/**
 * Language-agnostic core of the product runtime configuration: the
 * layered value model, its merge precedence, and per-value provenance.
 *
 * This is the *本体* — it owns semantics, not wiring. It deliberately
 * has no TOML parser, no file I/O and no host-specific behaviour. Each
 * host-language bridge decodes its ecosystem's TOML into the plain
 * object/array/scalar values this model consumes, and projects the
 * merged result into idiomatic host accessors. The model itself would
 * read identically if reimplemented in another host runtime — this file
 * is the TypeScript-host transcription of that same semantics, kept at
 * parity with the Python reference 本体.
 *
 * Why the product config is a separate file from the build-time
 * `Topo.toml`
 * -----------------------------------------------------------------------
 * `Topo.toml` configures the *toolchain build* (host language, sources,
 * optimisation feature-modes, check policy — owned by topo-build). This
 * model configures the *built product's* runtime behaviour. They live at
 * different lifecycle layers and answer different questions ("how is it
 * compiled" vs. "how does the running product behave"), so they are kept
 * as two files with no shared sections. The fixed name for the product
 * runtime config in this proof of concept is `topo-app.toml`. A
 * build-toolchain key has exactly one home — `Topo.toml` — and putting
 * it into the product config is a category error the validation hook
 * rejects, naming the file the key actually belongs to instead of
 * silently accepting a key nothing reads.
 *
 * The three runtime layers and their precedence
 * ---------------------------------------------
 * Three layers carry a configuration value at runtime, least to most
 * explicit:
 *   - `b` — inlined / hidden TOML embedded in the artifact via an
 *     explicit code-layer declaration. The built-in default.
 *   - `a` — the external `topo-app.toml` file the user manages.
 *     Overrides the inlined default.
 *   - `c` — a value injected directly in code through the topo
 *     interface. The most explicit, overrides everything.
 *
 * Frozen merge precedence: inlined default (b) ◁ external file (a) ◁
 * in-code injection (c). "More explicit wins": `c` overrides `a`
 * overrides `b`, per key.
 *
 * A fourth band `d` (pure-internal) exists in the model's vocabulary
 * but is intentionally absent from this runtime merge: `d` is promoted
 * to a plain host constant by the toolchain and has zero
 * configuration-system footprint at runtime, so there is nothing to
 * merge. `LAYER.D` is excluded from RUNTIME_MERGE_ORDER and the runtime
 * merge never sees it.
 *
 * Number-type note (host-specific, parity-preserving): the Python
 * reference relies on `tomllib` decoding distinct `int`/`float` types.
 * JavaScript has a single `number`. Parity with the Python int/float
 * contract is kept by classifying a finite `number` as the integer
 * contract iff `Number.isInteger(n)`, otherwise the float contract —
 * which is exactly the int/float distinction the bridge's TOML reader
 * and writer also use, so the contract reads the same end to end.
 */

// Fixed product runtime config filename for this proof of concept. Kept
// here (not in a bridge) so every host agrees on the boundary name.
export const PRODUCT_CONFIG_FILENAME = "topo-app.toml";

// The build toolchain owns Topo.toml; these are its section names. A key
// whose first dotted segment is one of these belongs to the build
// config, never to the product runtime config. Naming them here keeps
// the non-overlap boundary a single explicit set rather than scattered
// string checks.
export const BUILD_TOOLCHAIN_SECTIONS = new Set([
  "topo",
  "build",
  "builder",
  "parallel",
  "adaptive",
  "optimize",
  "observability",
  "lifetime",
  "loop_parallel",
  "types",
  "completeness",
  "check",
  "test",
]);

/**
 * Which runtime layer a value originates from. The numeric values encode
 * the merge precedence (higher wins) so the merge never hard-codes an
 * ordering separate from the layer identity. `D` is listed for
 * vocabulary completeness but is never produced by the runtime merge.
 *
 * Frozen distinct objects (not bare numbers) so `===` provenance checks
 * are reference-identity stable the way the Python enum members are.
 */
export const Layer = Object.freeze({
  B: Object.freeze({ name: "B", precedence: 1 }), // inlined / hidden TOML default
  A: Object.freeze({ name: "A", precedence: 2 }), // external topo-app.toml
  C: Object.freeze({ name: "C", precedence: 3 }), // in-code injection
  D: Object.freeze({ name: "D", precedence: 0 }), // pure-internal; never merged
});

// Layers that participate in the runtime merge, least to most explicit.
export const RUNTIME_MERGE_ORDER = Object.freeze([Layer.B, Layer.A, Layer.C]);

/**
 * Raised when a key that belongs to the build toolchain is offered to
 * the product runtime config. The message names `Topo.toml` so the user
 * is told exactly where the key actually belongs.
 */
export class BuildConfigKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BuildConfigKeyError";
  }
}

/** First dotted segment of a config key (`a.b.c` -> `a`). */
function _rootSection(key) {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

/**
 * Boundary guard: refuse a key that belongs in `Topo.toml`.
 *
 * The product runtime config and the build-time `Topo.toml` share no
 * sections by design; accepting a build key here would create a second,
 * silently-ignored home for it. Rejecting loudly — and naming the file
 * the key actually belongs to — keeps the boundary honest.
 */
export function rejectIfBuildConfigKey(key) {
  const section = _rootSection(key);
  if (BUILD_TOOLCHAIN_SECTIONS.has(section)) {
    throw new BuildConfigKeyError(
      `'${key}' configures the build toolchain (section ` +
        `'[${section}]') and belongs in Topo.toml, not the product ` +
        `runtime config (${PRODUCT_CONFIG_FILENAME}). The two files ` +
        `share no sections; set this in Topo.toml instead.`,
    );
  }
}

/**
 * An effective value plus the layer it came from. Provenance travels
 * with every value so any consumer can answer "which layer set this?"
 * without re-running the merge. Frozen to mirror the Python frozen
 * dataclass — a resolved value is not mutated by a consumer.
 */
export class ResolvedValue {
  constructor(value, layer) {
    this.value = value;
    this.layer = layer;
    Object.freeze(this);
  }
}

/**
 * Sentinel marking "this item has no built-in (inlined `b`) default".
 * Distinct from a stored `null` so a browse consumer can tell "no
 * default exists" from "default is a null-like value". A single shared
 * frozen instance so identity checks are stable.
 */
class _NoDefault {
  toString() {
    return "<no default>";
  }
}
export const NO_DEFAULT = Object.freeze(new _NoDefault());

/**
 * One self-describing row of the unified browse. Carries everything a
 * human or an agent needs to judge a config item without a second
 * query: identity and contract type, the built-in default and the
 * current effective value with the layer that produced it, the write
 * blast-radius (`impact`) and *both* permission thresholds —
 * `requiredWriteLevel` (the mis-operation gate) and `requiredReadLevel`
 * (the read-visibility tier), kept separate because the two roles are
 * orthogonal — plus the freely-combinable retrieval `tags`. `default`
 * is the NO_DEFAULT sentinel when the item has no inlined default.
 * Frozen so a browse row cannot be mutated by a consumer.
 */
export class BrowseEntry {
  constructor({
    key,
    type,
    default: defaultValue,
    effective,
    layer,
    impact,
    requiredWriteLevel,
    requiredReadLevel,
    tags,
  }) {
    this.key = key;
    this.type = type;
    this.default = defaultValue;
    this.effective = effective;
    this.layer = layer;
    this.impact = impact;
    this.requiredWriteLevel = requiredWriteLevel;
    this.requiredReadLevel = requiredReadLevel;
    this.tags = tags;
    Object.freeze(this);
  }
}

/**
 * The a/b/c layers as plain decoded data + the merge over them. Each
 * layer is a flat Map of dotted-key -> already-decoded plain value
 * (scalar / array / object). TOML parsing is a separate concern: a
 * bridge fills these maps; this model only merges and attributes them.
 *
 * A plain object would conflate config keys with prototype properties
 * (`toString`, `constructor`); a `Map` keeps the key space exactly the
 * decoded keys, matching the Python `dict` semantics.
 */
export class LayeredConfig {
  constructor({ inlined, external, injected } = {}) {
    this.inlined = _toMap(inlined); // layer b
    this.external = _toMap(external); // layer a
    this.injected = _toMap(injected); // layer c
  }

  /**
   * Register a block of already-decoded data as the inlined (b) layer —
   * the artifact-embedded default. Decode-only by design: the caller (a
   * host bridge) turns TOML text into this plain map and, symmetrically,
   * restores the map back to equivalent TOML. Embedding changes where
   * the *file* lives, never whether the *items* are browsable: the
   * installed keys merge as the ordinary `b` default. Build-toolchain
   * keys are rejected here too, so a misplaced key cannot sneak in
   * through the embedded layer any more than through the external file.
   */
  installInlined(data) {
    const map = _toMap(data);
    for (const key of map.keys()) {
      rejectIfBuildConfigKey(key);
    }
    this.inlined = map;
  }

  _layerMap(layer) {
    if (layer === Layer.B) return this.inlined;
    if (layer === Layer.A) return this.external;
    if (layer === Layer.C) return this.injected;
    // Layer.D never participates in the runtime merge by construction.
    throw new AssertionError(`${layer.name} is not a runtime merge layer`);
  }

  _validateKeys() {
    for (const layer of RUNTIME_MERGE_ORDER) {
      for (const key of this._layerMap(layer).keys()) {
        rejectIfBuildConfigKey(key);
      }
    }
  }

  /**
   * Every key contributed by any runtime layer, sorted for a stable,
   * hand-checkable enumeration.
   */
  keys() {
    const seen = new Set();
    for (const layer of RUNTIME_MERGE_ORDER) {
      for (const key of this._layerMap(layer).keys()) {
        seen.add(key);
      }
    }
    return [...seen].sort();
  }

  /**
   * Effective value + provenance for one key. Walks the layers
   * least-to-most explicit; the last layer that carries the key wins,
   * and that layer is the recorded provenance.
   */
  resolve(key) {
    rejectIfBuildConfigKey(key);
    let winner = null;
    for (const layer of RUNTIME_MERGE_ORDER) {
      const layerMap = this._layerMap(layer);
      if (layerMap.has(key)) {
        winner = new ResolvedValue(layerMap.get(key), layer);
      }
    }
    if (winner === null) {
      throw new KeyError(key);
    }
    return winner;
  }

  /**
   * Every key -> (effective value, provenance layer). Build-toolchain
   * keys are rejected up front so a misplaced key fails loudly rather
   * than appearing as a phantom entry.
   */
  resolveAll() {
    this._validateKeys();
    const out = new Map();
    for (const key of this.keys()) {
      out.set(key, this.resolve(key));
    }
    return out;
  }
}

/**
 * Convenience: build a `LayeredConfig` from the three layer maps and
 * return the resolved key -> value+provenance mapping.
 */
export function mergeLayers({ inlined, external, injected } = {}) {
  const cfg = new LayeredConfig({ inlined, external, injected });
  return cfg.resolveAll();
}

/**
 * Flatten a resolved mapping to `[key, value, layer]` triples in stable
 * key order — the shape later browse/introspection slices read.
 */
export function iterProvenance(resolved) {
  const keys = [...resolved.keys()].sort();
  return keys.map((key) => {
    const rv = resolved.get(key);
    return [key, rv.value, rv.layer];
  });
}

// --- Value-type contract ------------------------------------------------
//
// A config value only enters the model if it has a stdlib bridge type,
// so every value the running product reads has a known contract — the
// same schema vocabulary the handler In/Out boundary uses. The rule is
// expressed over decoded plain data, so it reads identically in any
// host.

/**
 * A config value whose type has no stdlib bridge was offered. The
 * message names the offending key and points at the
 * stdlib-bridging-types roadmap gap so the rejection is actionable
 * (e.g. a TOML datetime: `time_*` is not yet a stdlib type, so
 * accepting it would mean a value with no contract). Silently keeping
 * such a value would leave the product reading something nothing in the
 * schema describes — louder is safer than a phantom contract.
 */
export class UnbridgedValueError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "UnbridgedValueError";
  }
}

/**
 * The stdlib bridge spelling for a decoded value, or throw.
 *
 * The Python reference checks `bool` before `int` because Python's
 * `bool` is an `int` subclass. JavaScript's `boolean` and `number` are
 * disjoint primitives, so the spellings are derived from `typeof`
 * directly while preserving the same observable mapping: boolean ->
 * "bool", a finite integer-valued number -> "int", any other finite
 * number -> "float" (the int/float split the TOML bridge also uses),
 * string -> "str", array -> "slice", plain object -> "record".
 *
 * `Date` is the JavaScript correspondence of Python's
 * `date`/`time`/`datetime` (the only datetime-like value a TOML decoder
 * yields) and is rejected the same way, naming roadmap 08. Aggregates
 * are validated element-wise so a Date smuggled inside an array or
 * record is caught, not just a top-level one.
 */
export function stdlibTypeOf(value) {
  // date/time/datetime have no stdlib correspondence — see the
  // stdlib-bridging-types roadmap (time_* has no native host type and is
  // deferred). Reject rather than invent an ad-hoc contract.
  if (value instanceof Date) {
    throw new UnbridgedValueError(
      "value of type 'Date' has no stdlib bridge type — TOML date/time " +
        "maps to the not-yet-implemented time_* family (see roadmap 08, " +
        "stdlib-bridging-types: the time_*/uuid/decimal128 gap). " +
        "Accepting it would store a value with no schema contract; use " +
        "a bridged scalar instead.",
    );
  }
  const t = typeof value;
  if (t === "boolean") return "bool";
  if (t === "number") {
    if (!Number.isFinite(value)) {
      // NaN / ±Infinity decode from no TOML scalar and have no stdlib
      // contract — refuse rather than silently classify them as float.
      throw new UnbridgedValueError(
        `value '${value}' is a non-finite number with no stdlib bridge ` +
          "type (see roadmap 08, stdlib-bridging-types). Only finite " +
          "integer / float values have a schema contract.",
      );
    }
    // The int/float split that keeps parity with the Python tomllib
    // int vs. float contract and with the bridge's TOML reader/writer.
    return Number.isInteger(value) ? "int" : "float";
  }
  if (typeof value === "bigint") return "int";
  if (t === "string") return "str";
  if (Array.isArray(value)) {
    for (const element of value) {
      stdlibTypeOf(element);
    }
    return "slice";
  }
  if (value !== null && t === "object" && _isPlainRecord(value)) {
    for (const element of Object.values(value)) {
      stdlibTypeOf(element);
    }
    return "record";
  }
  const shown =
    value === null
      ? "null"
      : value === undefined
        ? "undefined"
        : (value.constructor && value.constructor.name) || t;
  throw new UnbridgedValueError(
    `value of type '${shown}' has no stdlib bridge type (see roadmap ` +
      "08, stdlib-bridging-types). Only string / integer / float / bool " +
      "/ array / table values have a schema contract; refusing to store " +
      "an uncontracted value.",
  );
}

/** A plain `record`-shaped object (not Date/Array/class instance). */
function _isPlainRecord(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value) || value instanceof Date) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Type-gate a value about to be written under `key`. Re-throws the
 * underlying UnbridgedValueError with the offending key prepended so a
 * rejection always locates the problem.
 */
export function validateValue(key, value) {
  try {
    stdlibTypeOf(value);
  } catch (exc) {
    if (exc instanceof UnbridgedValueError) {
      throw new UnbridgedValueError(`config key '${key}': ${exc.message}`);
    }
    throw exc;
  }
}

// --- Write protection: impact level + credential gate -------------------
//
// This gate exists to stop *mistaken* writes to items where a wrong
// value has outsized blast radius — it is a guard rail, not a secrecy
// boundary. It is identity-independent by construction: the check takes
// a credential *level*, never a principal. A human and an agent
// presenting the same level are treated identically; there is no "who"
// argument anywhere.

/**
 * How disruptive a wrong write to a config item is. Modelled as an
 * *ordered* scale (not a bool) from the start so a later multi-tier
 * permission slice can introduce intermediate levels and a per-item
 * required-credential-level without reshaping callers. Today only the
 * LOW/HIGH endpoints are used and the gate compares the presented
 * credential level against the item's required level.
 */
export const ImpactLevel = Object.freeze({
  LOW: 0, // routine; a wrong value is easily noticed and reverted
  HIGH: 1, // outsized blast radius; a careless write must be deliberate
});

const _IMPACT_NAME = Object.freeze({ 0: "LOW", 1: "HIGH" });

/**
 * Credential level a writer must present to pass the gate for an item
 * of a given impact. Kept as an explicit ordered map (not
 * `impact === HIGH`) so inserting a mid level later is a table edit, not
 * a logic rewrite. Exported mutable (a `Map`) so the parity test can
 * insert a mid threshold by extending the table — proving the scale is
 * multi-level — exactly as the Python suite mutates the dict.
 */
export const REQUIRED_CREDENTIAL_LEVEL = new Map([
  [ImpactLevel.LOW, 0],
  [ImpactLevel.HIGH, 1],
]);

// A writer with no credential is level 0 — enough for LOW items, short
// of anything that requires deliberate intent.
export const NO_CREDENTIAL_LEVEL = 0;

/**
 * A write to an item was refused because the presented credential level
 * is below what the item's impact level requires, *or* a read was
 * refused below an item's read tier. The message is about the
 * credential gap only — never about identity. Mirrors the Python
 * `PermissionError` lineage so `instanceof Error` catches it the same.
 */
export class WriteProtectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "WriteProtectionError";
  }
}

/** Missing-key error mirroring Python's `KeyError`. */
export class KeyError extends Error {
  constructor(key) {
    super(`'${key}'`);
    this.name = "KeyError";
    this.key = key;
  }
}

/** Construction-time invariant breach mirroring Python's AssertionError. */
export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * Per-item declaration carrying two *orthogonal* dimensions plus impact.
 *
 *  - `tags` — a freely-combinable set of strings scoping *retrieval*.
 *    A pure label set: tags never affect read or write permission, only
 *    which filter a query matches. Stored as a frozen Set so tag
 *    identity is order-independent.
 *  - `readLevel` — the minimum permission level a caller must present to
 *    have this item *enumerated or read*. Default `0` means visible to
 *    everyone. Above `0` makes the item permission-gated: hidden from
 *    any query below that level, listed only at/above it.
 *  - `impact` — independent of the two above: it drives the *write*
 *    mis-operation gate, not visibility.
 *
 * The two permission roles ride the same integer scale but are
 * deliberately separate fields: an item can be freely readable yet
 * write-guarded, or read-gated yet low-impact to write. Tags are a
 * third, permission-independent axis. Frozen so the declaration object
 * cannot be mutated after the fact.
 */
export class ItemPolicy {
  constructor({ impact = ImpactLevel.LOW, tags = [], readLevel = 0 } = {}) {
    this.impact = impact;
    // Accept any iterable of tag strings at the call site but always
    // store a frozen Set, so tag identity is order-independent.
    this.tags = Object.freeze(new Set(tags));
    this.readLevel = readLevel;
    Object.freeze(this);
  }
}

/** The minimum credential level a writer must present for this item. */
export function requiredCredentialLevel(policy) {
  return REQUIRED_CREDENTIAL_LEVEL.get(policy.impact);
}

/**
 * The minimum permission level a caller must present to have this item
 * enumerated/read. `0` means unrestricted. This is the
 * *read-visibility tiering* role — the orthogonal twin of
 * requiredCredentialLevel (the write gate). Both consult the same
 * integer scale; they answer different questions (may I *see* it vs.
 * may I *change* it) and never collapse into one another.
 */
export function requiredReadLevel(policy) {
  return policy.readLevel;
}

/**
 * Pass iff `credentialLevel` meets the item's required level. Note the
 * signature: there is no principal/identity parameter. The gate cannot
 * and does not distinguish a human from an agent — it only compares
 * levels, which is exactly the "防误操作 not secrecy" intent.
 */
export function authorizeWrite(key, policy, credentialLevel = NO_CREDENTIAL_LEVEL) {
  const needed = requiredCredentialLevel(policy);
  if (credentialLevel < needed) {
    throw new WriteProtectionError(
      `config key '${key}' is impact=${_IMPACT_NAME[policy.impact]}; ` +
        `writing it requires credential level >= ${needed}, but the ` +
        `write presented level ${credentialLevel}. This guard prevents ` +
        "accidental high-impact changes; re-issue the write with a " +
        "sufficient credential level if the change is intended.",
    );
  }
}

// --- Read/write API over the layered model ------------------------------

/**
 * Sentinel so `get(key)` can distinguish "no default given" from a
 * legitimately stored null-like value.
 */
const _MISSING = Object.freeze({ _missing: true });
export const MISSING = _MISSING;

/**
 * Read/write façade over `LayeredConfig`.
 *
 * Reads honour the frozen `b ◁ a ◁ c` precedence. Writes land in the
 * *external* layer (`a`) — the user-managed file's in-memory image —
 * because that is the layer a user/agent is allowed to author; the
 * inlined default (`b`) and in-code injection (`c`) are owned by other
 * mechanisms. This class stays language-agnostic: it mutates the
 * decoded `external` map and reports the new value; turning that map
 * into `topo-app.toml` bytes is a host-bridge concern. A host bridge
 * calls `pendingExternal()` to obtain the map to serialise after a
 * write.
 */
export class ConfigStore {
  constructor(layered = null, { policies = null } = {}) {
    this._cfg = layered !== null ? layered : new LayeredConfig();
    // Unlisted items default to LOW impact: writes are unguarded unless
    // an item is explicitly declared high-impact.
    this._policies = new Map();
    if (policies) {
      for (const [k, v] of _entries(policies)) {
        this._policies.set(k, v);
      }
    }
  }

  // -- declaration -----------------------------------------------------

  /** Attach a write-protection / tag / read-tier policy to `key`. */
  declare(key, policy) {
    rejectIfBuildConfigKey(key);
    this._policies.set(key, policy);
  }

  /** The item's declared policy, or the LOW-impact default. */
  policyOf(key) {
    return this._policies.has(key) ? this._policies.get(key) : new ItemPolicy();
  }

  // -- tag + read-visibility query ------------------------------------
  //
  // One query API, two orthogonal filter dimensions, *zero* ambient
  // state. It takes the filter (tags, level) as arguments and reads no
  // identity — so the same method called from two sites with different
  // arguments yields different visibility purely from what each site
  // passes in. There is intentionally no principal/user/agent argument.

  /**
   * The highest read-level any runtime item requires. A caller
   * presenting this level (or above) can enumerate *every* runtime item
   * — there is no level at which some runtime fragment stays invisible.
   * This is what makes the tiered-transparency invariant checkable. `0`
   * when nothing is permission-gated.
   */
  maxReadLevel() {
    let top = 0;
    for (const key of this._cfg.keys()) {
      const lvl = this.policyOf(key).readLevel;
      if (lvl > top) top = lvl;
    }
    return top;
  }

  _visible(key, credentialLevel) {
    return credentialLevel >= this.policyOf(key).readLevel;
  }

  /**
   * Keys matching a tag filter *and* within the caller's read tier.
   *
   *  - `tags` — when null/undefined/empty every item matches the tag
   *    axis; otherwise an item matches only if its tag set is a
   *    *superset* of the requested set (tag AND, freely combinable).
   *    Tags never grant or deny permission; they only scope range.
   *  - `credentialLevel` — an item is listed only when this level meets
   *    the item's `readLevel`. With no credential, every
   *    permission-gated item (`readLevel > 0`) is hidden. At
   *    maxReadLevel the read axis admits all keys.
   *
   * Returns sorted keys for a stable, hand-checkable enumeration.
   */
  query(tags = null, credentialLevel = NO_CREDENTIAL_LEVEL) {
    const wanted = tags ? new Set(tags) : new Set();
    const out = [];
    for (const key of this._cfg.keys()) {
      if (!this._visible(key, credentialLevel)) continue;
      if (wanted.size && !_isSuperset(this.policyOf(key).tags, wanted)) continue;
      out.push(key);
    }
    return out.sort();
  }

  /**
   * `query` but returning effective value + provenance for each matched
   * key — the read counterpart of the filter, so a caller within its
   * tier gets values too, not just names.
   */
  queryResolved(tags = null, credentialLevel = NO_CREDENTIAL_LEVEL) {
    const out = new Map();
    for (const key of this.query(tags, credentialLevel)) {
      out.set(key, this._cfg.resolve(key));
    }
    return out;
  }

  // -- read ------------------------------------------------------------

  /** Every key any runtime layer contributes, sorted. */
  keys() {
    return this._cfg.keys();
  }

  /**
   * Effective value honouring `b ◁ a ◁ c`. Returns `default` if given
   * and the key is set by no layer; otherwise a missing key throws
   * `KeyError` (no silent `undefined`/`null`).
   */
  get(key, defaultValue = _MISSING) {
    try {
      return this._cfg.resolve(key).value;
    } catch (exc) {
      if (exc instanceof KeyError) {
        if (defaultValue === _MISSING) throw exc;
        return defaultValue;
      }
      throw exc;
    }
  }

  /** Effective value + which layer it came from. */
  resolve(key) {
    return this._cfg.resolve(key);
  }

  /** Every key -> (effective value, provenance layer). */
  resolveAll() {
    return this._cfg.resolveAll();
  }

  /**
   * Read honouring the read-visibility tier. Below the item's
   * `readLevel` the item is treated as not listable, so a read is
   * refused the same way enumeration hides it. `get` stays the raw,
   * tier-blind accessor lower layers and the write path rely on;
   * `read` is the tier-aware door.
   */
  read(key, credentialLevel = NO_CREDENTIAL_LEVEL) {
    if (!this._visible(key, credentialLevel)) {
      const needed = this.policyOf(key).readLevel;
      throw new WriteProtectionError(
        `config key '${key}' requires read level >= ${needed} to be ` +
          `listed or read; the request presented level ${credentialLevel}. ` +
          "Permission-gated items are hidden below their tier; re-issue " +
          "with a sufficient level.",
      );
    }
    return this._cfg.resolve(key).value;
  }

  // -- write -----------------------------------------------------------

  /**
   * Write `value` for `key` into the external layer (`a`). Order of
   * checks: a build-toolchain key is a category error (rejected first);
   * then the value must have a stdlib contract; then the
   * write-protection gate. Only after all three pass is the external
   * map mutated, so a rejected write never leaves a partial state.
   */
  set(key, value, credentialLevel = NO_CREDENTIAL_LEVEL) {
    rejectIfBuildConfigKey(key);
    validateValue(key, value);
    authorizeWrite(key, this.policyOf(key), credentialLevel);
    this._cfg.external.set(key, value);
  }

  // -- unified browse + introspection ---------------------------------
  //
  // A single call that yields, *within the caller's read tier*, a
  // self-describing row per config item. It is built strictly on the
  // tier-aware door (queryResolved -> query -> policyOf); it never calls
  // the tier-blind resolveAll/resolve/get, so a permission-gated item
  // cannot leak into a lower-level caller's view. The row set is derived
  // live on every call, so a key declared after construction appears
  // with no list to maintain.

  /**
   * Self-describing rows for every item in the caller's read tier.
   * Routes through `queryResolved` (the tier-aware door), so the result
   * is exactly this level's complete range: at maxReadLevel every
   * runtime item is present (tiered-transparency — no level-invisible
   * fragment); below an item's `readLevel` that item is wholly absent,
   * value included. The signature takes a credential *level* only —
   * there is no principal/identity argument. `d` is not a runtime item
   * and never appears here.
   */
  browse(tags = null, credentialLevel = NO_CREDENTIAL_LEVEL) {
    const resolved = this.queryResolved(tags, credentialLevel);
    const rows = [];
    for (const key of [...resolved.keys()].sort()) {
      const rv = resolved.get(key);
      const policy = this.policyOf(key);
      // Default = the inlined (b) built-in when the key has one; absent
      // otherwise. Read from the b layer map directly (not via the
      // tier-blind resolve) so this stays a pure lookup that cannot
      // widen visibility.
      const hasDefault = this._cfg.inlined.has(key);
      const defaultValue = hasDefault ? this._cfg.inlined.get(key) : NO_DEFAULT;
      // Type from the contract that already governs every stored value;
      // prefer the effective value, fall back to the default so a row
      // still types when both exist.
      const typeSource =
        rv.value !== null && rv.value !== undefined ? rv.value : defaultValue;
      let valueType;
      try {
        valueType = stdlibTypeOf(typeSource);
      } catch (exc) {
        if (exc instanceof UnbridgedValueError) {
          valueType = stdlibTypeOf(rv.value);
        } else {
          throw exc;
        }
      }
      rows.push(
        new BrowseEntry({
          key,
          type: valueType,
          default: defaultValue,
          effective: rv.value,
          layer: rv.layer,
          impact: policy.impact,
          requiredWriteLevel: requiredCredentialLevel(policy),
          requiredReadLevel: requiredReadLevel(policy),
          tags: policy.tags,
        }),
      );
    }
    return rows;
  }

  // -- bridge hook -----------------------------------------------------

  /**
   * The external-layer map a host bridge serialises to the user-managed
   * config file after a write. Returned by reference so the bridge sees
   * the post-write image; the model never touches files itself.
   */
  pendingExternal() {
    return this._cfg.external;
  }
}

// --- Pure-internal (d) band: dev-phase registry, no runtime presence ----
//
// `d` is the innermost band. Unlike a/b/c it is *not* a runtime config
// value: after toolchain processing it is promoted to a plain host
// constant with zero configuration-system footprint, which is why
// `Layer.D` is excluded from RUNTIME_MERGE_ORDER and the runtime merge
// never sees it. Its tags exist for one purpose only — being
// discoverable *while developing* — so it gets its own registry that is
// structurally disjoint from ConfigStore/LayeredConfig. Nothing on the
// runtime read/merge path holds a reference to this type or its
// instances; a runtime build can drop this registry entirely without
// changing any resolved value.

/**
 * A pure-internal datum as seen *only during development*. Carries the
 * declared name, its constant value, and dev-phase retrieval tags. It
 * has no `readLevel`/`impact`: those gate runtime visibility and write
 * blast-radius, and `d` has neither a runtime presence nor a runtime
 * write path. This object lives solely in `DevInternalRegistry`; the
 * runtime config store has no field that can hold it. Frozen to mirror
 * the Python frozen dataclass.
 */
export class DevInternalItem {
  constructor(name, value, tags = []) {
    this.name = name;
    this.value = value;
    this.tags = Object.freeze(new Set(tags));
    Object.freeze(this);
  }
}

/**
 * A development-phase-only catalogue of `d` declarations. This is the
 * *only* place a `d` item is visible, and it is deliberately a
 * free-standing object the runtime config path never consults:
 * ConfigStore does not hold one, LayeredConfig does not reference one,
 * and resolve/query/keys cannot reach it. Its sole job is to let a
 * developer find a pure-internal datum by name or tag while building. A
 * production build may simply never construct this registry — the
 * promoted constants stand on their own.
 */
export class DevInternalRegistry {
  constructor() {
    this._items = new Map();
  }

  /**
   * Record a pure-internal datum for dev-phase discovery and return the
   * plain value to be bound as a host constant. The value still must
   * satisfy the stdlib contract, but it is *not* stored as a config
   * item anywhere: the return value is what the caller binds,
   * byte-equivalent to a hand-written constant. The build-toolchain
   * boundary guard applies to the name as well, so `d` cannot be used
   * to smuggle a build key either.
   */
  declare(name, value, tags = []) {
    rejectIfBuildConfigKey(name);
    validateValue(name, value);
    this._items.set(name, new DevInternalItem(name, value, tags));
    return value;
  }

  /** Every declared `d` name, sorted — dev-phase enumeration. */
  names() {
    return [...this._items.keys()].sort();
  }

  /** The dev-phase record for `name` (throws if undeclared). */
  get(name) {
    if (!this._items.has(name)) throw new KeyError(name);
    return this._items.get(name);
  }

  /**
   * `d` names whose tag set is a superset of `tags` (tag AND, same
   * freely-combinable semantics as the runtime tag query) — this is the
   * *only* retrieval `d`'s tags ever serve.
   */
  search(tags) {
    const wanted = new Set(tags);
    const out = [];
    for (const [name, item] of this._items) {
      if (_isSuperset(item.tags, wanted)) out.push(name);
    }
    return out.sort();
  }
}

// --- internal helpers ---------------------------------------------------

/** `target` ⊇ `wanted` — every member of `wanted` is in `target`. */
function _isSuperset(target, wanted) {
  for (const w of wanted) {
    if (!target.has(w)) return false;
  }
  return true;
}

/**
 * Normalise a layer/policy input (Map | plain object | null) to a Map.
 * A plain object is accepted for ergonomic call sites; a Map passes
 * through so a caller can hand in an already-built map by reference.
 */
function _toMap(data) {
  if (data == null) return new Map();
  if (data instanceof Map) return new Map(data);
  return new Map(Object.entries(data));
}

/** Iterate a Map | plain object as `[key, value]` pairs. */
function _entries(data) {
  if (data instanceof Map) return data.entries();
  return Object.entries(data);
}
