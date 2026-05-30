/**
 * Map the TypeScript host's In/Out *schema descriptors* onto topo stdlib
 * type spellings.
 *
 * Why a schema descriptor and not annotation reflection
 * -----------------------------------------------------
 * The Python projection of topo-app reads `__annotations__`: In/Out
 * live in the function signature, never in hand-written `.topo`. A
 * TypeScript function's parameter and return *types erase entirely* at
 * runtime — there is nothing for a runtime framework to reflect. So the
 * TS host keeps the same philosophy (In/Out declared once, at the
 * registration site, never re-declared in `.topo`) but materialises it
 * as an explicit value-level schema descriptor passed alongside the
 * handler. This is the identical representational decision the config
 * port made (TS erases types -> explicit schema/Record-like descriptors)
 * and reuses its stdlib type vocabulary verbatim.
 *
 * Scalar mapping follows the TypeScript stdlib aliases topo-init binds
 * (`std::typescript::{number,boolean,string}`): the user-facing aliases
 * are `int` / `float` / `bool` / `str`, exactly the four the Python host
 * exposes, so the same handler reads the same in either host.
 */

import { TypeRef } from "./_graph.mjs";

// The four scalar aliases. `int`/`float` both bridge to the host
// `number` per the TS topo-init type bindings, but they remain distinct
// topo aliases (the stdlib-type contract the config port also keeps).
const SCALARS = new Set(["int", "float", "bool", "str"]);

/**
 * `Field(name, type)` — one ordered, named record field. `type` is
 * either a scalar alias string ("int"/"float"/"bool"/"str") or a nested
 * record descriptor (the array form `Record(...)` returns).
 */
export function Field(name, type) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("record field name must be a non-empty string");
  }
  return [name, type];
}

/**
 * `Record(Field("id", "int"), Field("amount", "float"))` — an
 * order-preserving record descriptor. Mirrors the spec's "TS host maps
 * record<...> to an order-preserving structure" rule; field order is
 * explicit and stable, never inferred. Returns a tagged array so it is a
 * plain value (no class identity to leak across module copies).
 */
export function Record(...fields) {
  if (fields.length === 0) {
    // Mirrors core Sema: record<> with no field is rejected upstream;
    // fail early here so the user sees it before emission.
    throw new TypeError("record type must declare at least one field");
  }
  const seen = new Set();
  for (const f of fields) {
    if (!Array.isArray(f) || f.length !== 2 || typeof f[0] !== "string") {
      throw new TypeError(
        "Record(...) takes Field('name', type) entries only"
      );
    }
    if (seen.has(f[0])) {
      throw new TypeError(`duplicate record field '${f[0]}'`);
    }
    seen.add(f[0]);
  }
  const r = fields.map(([n, t]) => [n, t]);
  r.__topoRecord = true;
  return r;
}

function _isRecord(desc) {
  return Array.isArray(desc) && desc.__topoRecord === true;
}

/** Convert a schema descriptor into a TypeRef. */
export function toTypeRef(desc) {
  if (typeof desc === "string") {
    if (!SCALARS.has(desc)) {
      throw new TypeError(
        `unsupported handler type '${desc}'; use ` +
          `'int'/'float'/'bool'/'str' or Record(Field(...), ...)`
      );
    }
    return new TypeRef({ scalar: desc });
  }
  if (_isRecord(desc)) {
    return new TypeRef({
      record: desc.map(([n, t]) => [n, toTypeRef(t)]),
    });
  }
  throw new TypeError(
    `unsupported handler type ${JSON.stringify(desc)}; use ` +
      `'int'/'float'/'bool'/'str' or Record(Field(...), ...)`
  );
}

/**
 * Resolve a registration's declared In/Out into `(inType, outType)`.
 * `inSpec` is `null`/`undefined` for a source handler (no input). A
 * handler is a pure Functor: at most one input — the descriptor is a
 * single type, never a list, structurally enforcing "handler 至多一个
 * 输入参数" the same way the core Parser does, so an unrepresentable
 * signature never reaches emission.
 *
 * @param {string} name
 * @param {{in?: any, out: any}} spec
 * @returns {[TypeRef|null, TypeRef]}
 */
export function reflectSignature(name, spec) {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError(
      `handler '${name}' needs a {in?, out} schema; In/Out are declared ` +
        "once here (TS types erase at runtime), never in .topo"
    );
  }
  if (!("out" in spec)) {
    throw new TypeError(`handler '${name}' has no 'out' type`);
  }
  const inType =
    spec.in === undefined || spec.in === null
      ? null
      : toTypeRef(spec.in);
  const outType = toTypeRef(spec.out);
  return [inType, outType];
}
