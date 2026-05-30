/**
 * The TypeScript-host bridge for the product runtime configuration.
 *
 * The layered model (`_config_model.mjs`) is language-agnostic and
 * never touches files. This is the V8/Node ecosystem's bridge: it
 * decodes `topo-app.toml` and serialises writes back, and projects the
 * merged result into idiomatic host accessors via `ProductConfig`.
 *
 * TOML strategy (deliberate, mirrors the Python bridge stance)
 * -----------------------------------------------------------------------
 * Node has no built-in TOML parser, and the established npm options
 * (`@iarna/toml`, `smol-toml`, …) are third-party packages. The Python
 * bridge consciously avoids a hard runtime TOML dependency: it reads
 * with the stdlib `tomllib` and ships its own *minimal deterministic*
 * writer rather than pulling `tomli-w`. There is no Node stdlib
 * equivalent of `tomllib`, so to keep the same "no hard third-party
 * dependency" stance this bridge ships a minimal deterministic TOML
 * *reader and writer* covering exactly the flat scalar / array /
 * inline-table config vocabulary the model accepts (the same surface
 * the Python writer covers). It is intentionally not a full TOML 1.0
 * implementation — the config vocabulary is the contract, and keeping
 * the reader/writer a matched pair guarantees encode∘decode is the
 * identity for that vocabulary (the round-trip constraint). If a richer
 * parser is ever needed it can be swapped without the model noticing.
 *
 * Number parity: TOML distinguishes integers from floats; the model's
 * stdlib contract preserves that as "int" vs "float". The reader keeps
 * the distinction by decoding `3` to an integer-valued JS number and
 * `0.5` to a fractional one; the writer emits an integer-valued number
 * without a decimal point and a fractional one with one, so a
 * read→write→read cycle preserves the int/float contract.
 */

import { createRequire as _createRequire } from "node:module";
import {
  ConfigStore,
  DevInternalRegistry,
  LayeredConfig,
} from "./_config_model.mjs";

// --- minimal deterministic TOML reader ----------------------------------
//
// Covers the config vocabulary: top-level + `[a.b]` table headers,
// `key = value` assignments, string / boolean / integer / float
// scalars, arrays, and inline `{ ... }` tables. A TOML datetime is
// decoded to a JS `Date` so the model's stdlib-contract guard rejects
// it the same way the Python bridge lets `tomllib` produce a datetime
// the model then rejects (parity: the gap surfaces at validate time,
// naming the stdlib-bridging-types gap, not silently at parse time).

function _parseTomlValue(raw) {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith('"') || text.startsWith("'")) {
    return _parseString(text);
  }
  if (text.startsWith("[")) return _parseArray(text);
  if (text.startsWith("{")) return _parseInlineTable(text);
  // Bare datetime / date / time -> Date, so the model's contract guard
  // rejects it (it has no stdlib bridge). Detected before number so a
  // date like 2026-05-16 is not mistaken for arithmetic.
  if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?$/.test(text) ||
      /^\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) {
    const d = new Date(text.replace(" ", "T"));
    // Even if the host cannot parse it, a Date object (Invalid or not)
    // still trips the model's `instanceof Date` rejection — exactly the
    // intended "no stdlib contract" outcome.
    return d;
  }
  if (/^[+-]?(\d[\d_]*)$/.test(text)) {
    return Number.parseInt(text.replace(/_/g, ""), 10);
  }
  if (/^[+-]?((\d[\d_]*)?\.\d[\d_]*|\d[\d_]*\.|\d[\d_]*[eE][+-]?\d+|(\d[\d_]*)?\.\d[\d_]*[eE][+-]?\d+)$/.test(text)) {
    return Number.parseFloat(text.replace(/_/g, ""));
  }
  throw new SyntaxError(`unsupported TOML value: ${raw}`);
}

function _parseString(text) {
  const quote = text[0];
  // The minimal vocabulary uses basic strings; literal (single-quoted)
  // strings are taken verbatim with no escape processing, as TOML
  // specifies, so a round-tripped basic string stays basic.
  if (quote === "'") {
    const end = text.indexOf("'", 1);
    return text.slice(1, end);
  }
  let out = "";
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else if (next === "r") out += "\r";
      else out += next;
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i += 1;
  }
  return out;
}

// Split a bracketed/braced body at top-level commas, respecting nested
// strings, arrays and tables — enough for the config vocabulary.
function _splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let inStr = null;
  let cur = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) {
      cur += ch;
      if (ch === "\\" && inStr === '"') {
        cur += body[i + 1] ?? "";
        i += 1;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

function _parseArray(text) {
  const body = text.slice(1, text.lastIndexOf("]"));
  if (body.trim() === "") return [];
  return _splitTopLevel(body).map((p) => _parseTomlValue(p));
}

function _parseInlineTable(text) {
  const body = text.slice(1, text.lastIndexOf("}"));
  const out = {};
  if (body.trim() === "") return out;
  for (const pair of _splitTopLevel(body)) {
    const eq = pair.indexOf("=");
    const k = pair.slice(0, eq).trim();
    out[k] = _parseTomlValue(pair.slice(eq + 1));
  }
  return out;
}

/** Decode TOML text into a nested plain object (the config vocabulary). */
function _loadToml(text) {
  const root = {};
  let cursor = root;
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/^\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const section = line.slice(1, line.indexOf("]")).trim();
      cursor = root;
      for (const part of section.split(".")) {
        if (cursor[part] === undefined) cursor[part] = {};
        cursor = cursor[part];
      }
      continue;
    }
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    cursor[key] = _parseTomlValue(line.slice(eq + 1));
  }
  return root;
}

// --- nested <-> flat dotted-key transforms ------------------------------

/**
 * Turn dotted keys (`a.b.c`) into nested object structure so the
 * serialised TOML uses idiomatic `[a.b]` tables instead of quoted
 * dotted keys. Keys sorted so emission is deterministic.
 */
function _splitNested(flat) {
  const root = {};
  for (const dotted of [...flat.keys()].sort()) {
    const parts = dotted.split(".");
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      if (cursor[part] === undefined) cursor[part] = {};
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = flat.get(dotted);
  }
  return root;
}

/**
 * Inverse of `_splitNested`: a decoded TOML document back to the
 * model's flat dotted-key Map. A nested object is treated as a table; a
 * value the model stores as a `record` only appears as a *value* (an
 * inline table), never recursed into, because config keys are addressed
 * by dotted path and a stored table value is itself a leaf in that
 * addressing. The seam: `_splitNested` only produces plain nesting
 * objects, and `_loadToml` only produces nested objects from `[a.b]`
 * headers, so a stored record is a value here, never a table.
 */
function _flattenNested(nested, prefix = "") {
  const flat = new Map();
  for (const [name, value] of Object.entries(nested)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (_isNestingTable(value)) {
      for (const [k, v] of _flattenNested(value, key)) {
        flat.set(k, v);
      }
    } else {
      flat.set(key, value);
    }
  }
  return flat;
}

/**
 * A plain object reached as a nesting table (from a `[a.b]` header or
 * `_splitNested`) vs. a record *value*. The reader only ever produces a
 * nesting table from a section header; an inline `{ }` is parsed into
 * an object but appears as a leaf value (the writer round-trips it
 * inline). Distinguishing them here keeps the flat addressing honest:
 * only a `[section]`-derived object is descended into, an inline-table
 * value is left as a leaf. The reader tags inline-table objects so this
 * stays an exact, not heuristic, decision.
 */
function _isNestingTable(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    value[_INLINE_TABLE] !== true
  );
}

// A non-enumerable brand the reader stamps on inline-table objects so
// the flatten step can tell a stored record value from a nesting table
// without a fragile heuristic. Symbol so it never collides with a
// config key and never serialises.
const _INLINE_TABLE = Symbol("topo.inlineTable");

// --- minimal deterministic TOML writer ----------------------------------

function _tomlScalar(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `non-finite number ${value} is not TOML-serialisable (the model ` +
          "rejects it before a write reaches the bridge)",
      );
    }
    // Integer-valued -> no decimal point; fractional -> as-is. This is
    // what keeps the int/float stdlib contract stable across a
    // write→read cycle.
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  if (typeof value === "string") {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => _tomlScalar(v)).join(", ") + "]";
  }
  if (value instanceof Date) {
    throw new TypeError(
      "Date values have no stdlib bridge and must be rejected by the " +
        "model before serialisation",
    );
  }
  if (value !== null && typeof value === "object") {
    // A record value -> inline table, deterministically key-sorted.
    const inner = Object.keys(value)
      .sort()
      .map((k) => `${k} = ${_tomlScalar(value[k])}`)
      .join(", ");
    return "{" + inner + "}";
  }
  throw new TypeError(
    `value of type ${typeof value} is not TOML-serialisable`,
  );
}

/**
 * A minimal deterministic TOML emitter for the config vocabulary.
 * Scalars/arrays of a table are written before nested sub-tables, keys
 * are sorted, and a stored table *value* (a record) is written inline
 * so it round-trips as one value rather than a sub-section.
 */
function _emitToml(nested, path = []) {
  const scalars = {};
  const subtables = {};
  for (const name of Object.keys(nested).sort()) {
    const value = nested[name];
    if (_isNestingTable(value) && !(value instanceof Date)) {
      subtables[name] = value;
    } else {
      scalars[name] = value;
    }
  }
  const out = [];
  for (const name of Object.keys(scalars).sort()) {
    out.push(`${name} = ${_tomlScalar(scalars[name])}`);
  }
  for (const name of Object.keys(subtables).sort()) {
    const section = [...path, name].join(".");
    const body = _emitToml(subtables[name], [...path, name]);
    out.push(`\n[${section}]`);
    if (body) out.push(body);
  }
  return out.filter((p) => p !== "").join("\n");
}

// --- product config projection ------------------------------------------

/**
 * TypeScript-host projection of the product runtime config entry.
 *
 * Wraps a language-agnostic `ConfigStore`; this class only adds the
 * V8/Node ecosystem's file I/O (the minimal TOML reader/writer above)
 * and the round-trippable inline-TOML surface. `set` updates the
 * external layer via the model and re-serialises the user-managed file
 * so a write is immediately reflected on disk and in the next `get`.
 *
 * File I/O is injected (`fs`) so the model+bridge can be exercised
 * without the runner depending on a particular module-resolution shape;
 * when omitted, Node's `node:fs` is used. The pure-internal (`d`)
 * catalogue is created lazily and kept on the side — it is *not* wired
 * into the ConfigStore, so the runtime read/merge path provably cannot
 * reach a `d` item; a production projection could skip building it.
 */
export class ProductConfig {
  constructor({
    path = null,
    inlined = null,
    injected = null,
    policies = null,
    fs = null,
  } = {}) {
    this._path = path;
    this._fs = fs;
    this._devInternal = null;
    let external = new Map();
    if (path !== null) {
      const fsImpl = this._fsImpl();
      try {
        const text = fsImpl.readFileSync(path, "utf-8");
        external = _flattenNested(_loadToml(text));
      } catch (exc) {
        // A missing file is the "no external overrides yet" state, not
        // an error — symmetric with the Python bridge swallowing
        // FileNotFoundError. Any other I/O error is surfaced.
        if (exc && exc.code === "ENOENT") {
          external = new Map();
        } else {
          throw exc;
        }
      }
    }
    const layered = new LayeredConfig({
      inlined: inlined,
      external: external,
      injected: injected,
    });
    this._store = new ConfigStore(layered, { policies });
  }

  _fsImpl() {
    if (this._fs) return this._fs;
    // Lazily required so a pathless (in-memory) config never needs fs.
    // eslint-disable-next-line no-undef
    return _nodeFs();
  }

  get store() {
    return this._store;
  }

  get path() {
    return this._path;
  }

  declare(key, policy) {
    this._store.declare(key, policy);
  }

  // -- code-layer inline / hidden TOML (layer b) ----------------------
  //
  // An explicit code-level call (not a TOML directive, not automatic
  // build behaviour) that says "this config block ships *inside* the
  // artifact" so it no longer needs to sit as a scattered external
  // file. The model only ever sees decoded data; this bridge owns the
  // decode and the symmetric restore back to TOML text.

  /**
   * Embed a TOML config block as the inlined (b) default. `source` may
   * be TOML *text* (a string) decoded here, or an already-decoded plain
   * object. After this call the product needs no external file for
   * these defaults, yet every embedded item still enumerates through
   * keys/query/queryResolved exactly like any `b` value: embedding
   * hides the *file*, never the *items*. `a` and `c` keep overriding
   * `b` unchanged (no merge regression).
   */
  declareInlinedToml(source) {
    let decoded;
    if (typeof source === "string") {
      decoded = _loadToml(source);
    } else if (
      source !== null &&
      typeof source === "object" &&
      !Array.isArray(source)
    ) {
      decoded = source;
    } else {
      throw new TypeError(
        "declareInlinedToml expects TOML text or an already-decoded " +
          `object, got ${source === null ? "null" : typeof source}`,
      );
    }
    this._store._cfg.installInlined(_flattenNested(decoded));
  }

  /**
   * Reconstruct the embedded (b) layer as equivalent TOML text.
   * Embedding is not opacity: the inlined block is always recoverable
   * to readable, hand-editable TOML. "Equivalent" means re-parsing the
   * returned text yields the same decoded data the layer holds —
   * guaranteed because it reuses the very same deterministic emitter
   * and flat→nested transform the external writer uses, so encode∘decode
   * is the identity for the scalar / array / table config vocabulary.
   */
  restoreInlinedToml() {
    const inlined = this._store._cfg.inlined;
    const nested = _splitNested(inlined);
    const body = _emitToml(nested).trim();
    return body + (inlined.size ? "\n" : "");
  }

  // -- pure-internal (d) declaration ----------------------------------

  get devInternal() {
    if (this._devInternal === null) {
      this._devInternal = new DevInternalRegistry();
    }
    return this._devInternal;
  }

  /**
   * Declare a pure-internal datum and return the plain value. The
   * return value is what the caller binds — byte-equivalent to a
   * hand-written constant, carrying no config-system reference. Its
   * only visibility is dev-phase tag/name lookup via `devInternal`; it
   * never enters the runtime store, so it is absent from
   * keys/query/resolve.
   */
  declareInternal(name, value, tags = []) {
    return this.devInternal.declare(name, value, tags);
  }

  keys() {
    return this._store.keys();
  }

  /**
   * Tag- and read-tier-filtered key list. Pure passthrough to the
   * language-agnostic store: the bridge adds no filtering of its own.
   */
  query(tags = null, credentialLevel = 0) {
    return this._store.query(tags, credentialLevel);
  }

  queryResolved(tags = null, credentialLevel = 0) {
    return this._store.queryResolved(tags, credentialLevel);
  }

  maxReadLevel() {
    return this._store.maxReadLevel();
  }

  read(key, credentialLevel = 0) {
    return this._store.read(key, credentialLevel);
  }

  /**
   * Self-describing rows for every runtime item within the caller's
   * read tier. Takes a credential *level* only — no principal/identity
   * — so the same level always yields the same browse. At maxReadLevel
   * this is the complete runtime key set; `d` items are never included.
   * Pure passthrough: the row schema and tier routing live in the
   * model so any host bridge browses identically.
   */
  browse(tags = null, credentialLevel = 0) {
    return this._store.browse(tags, credentialLevel);
  }

  /**
   * The dev-phase-only catalogue of pure-internal (d) data. Explicitly
   * *not* part of the runtime browse: `d` is promoted to a plain host
   * constant and has zero runtime config footprint, so it is absent
   * from `browse` at every level. When `tags` is given only `d` items
   * whose tag set is a superset match (same freely-combinable tag-AND
   * as the runtime query); otherwise every declared `d` item is listed.
   * Returns plain `{name, value, tags}` records, distinct in shape from
   * a runtime BrowseEntry so the two ranges never blur. Browsing an
   * empty dev band must not even create the side registry.
   */
  devBrowse(tags = null) {
    if (this._devInternal === null) return [];
    const reg = this._devInternal;
    const names = tags ? reg.search(tags) : reg.names();
    return names.map((name) => {
      const item = reg.get(name);
      return { name: item.name, value: item.value, tags: item.tags };
    });
  }

  get(key, ...args) {
    return this._store.get(key, ...args);
  }

  resolve(key) {
    return this._store.resolve(key);
  }

  /**
   * Validate + write through the model, then re-serialise the external
   * layer to the user-managed file (when a path is set).
   */
  set(key, value, credentialLevel = 0) {
    this._store.set(key, value, credentialLevel);
    if (this._path !== null) {
      this._writeExternal();
    }
  }

  /**
   * The external (`a`) layer as deterministic TOML text — the exact
   * bytes `set` writes to `topo-app.toml`.
   */
  serializeExternal() {
    const nested = _splitNested(this._store.pendingExternal());
    const body = _emitToml(nested).trim();
    return body + (this._store.pendingExternal().size ? "\n" : "");
  }

  _writeExternal() {
    // Only reachable when a file-backed config is in use; a pathless
    // (in-memory) config never persists. Asserting the invariant keeps
    // the write honest rather than letting a null path reach the fs.
    if (this._path === null) {
      throw new Error(
        "cannot persist external layer: this config has no file path",
      );
    }
    this._fsImpl().writeFileSync(this._path, this.serializeExternal(), "utf-8");
  }
}

// Node's `node:fs` is loaded lazily and behind an indirection so the
// pure model+bridge can be unit-tested with an injected fs and an
// in-memory (pathless) config never imports it. Kept at the bottom so
// the export surface above reads as pure logic.
let _cachedFs = null;
function _nodeFs() {
  if (_cachedFs === null) {
    // require is available in .mjs via createRequire; using a dynamic
    // import would force every caller async. createRequire keeps the
    // synchronous file I/O the Python bridge has, parity-preserving.
    // eslint-disable-next-line no-undef
    _cachedFs = _createRequire(import.meta.url)("node:fs");
  }
  return _cachedFs;
}

// Re-export the model surface so a consumer imports one module the way
// the Python suite imports `topo._config_model` and `topo.config`.
export {
  PRODUCT_CONFIG_FILENAME,
  BUILD_TOOLCHAIN_SECTIONS,
  Layer,
  RUNTIME_MERGE_ORDER,
  BuildConfigKeyError,
  rejectIfBuildConfigKey,
  ResolvedValue,
  NO_DEFAULT,
  BrowseEntry,
  LayeredConfig,
  mergeLayers,
  iterProvenance,
  UnbridgedValueError,
  stdlibTypeOf,
  validateValue,
  ImpactLevel,
  REQUIRED_CREDENTIAL_LEVEL,
  NO_CREDENTIAL_LEVEL,
  WriteProtectionError,
  KeyError,
  AssertionError,
  ItemPolicy,
  requiredCredentialLevel,
  requiredReadLevel,
  authorizeWrite,
  MISSING,
  ConfigStore,
  DevInternalItem,
  DevInternalRegistry,
} from "./_config_model.mjs";
