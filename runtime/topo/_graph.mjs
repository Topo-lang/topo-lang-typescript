/**
 * In-memory logic graph: the single source of truth a topo-app program
 * builds by registration.
 *
 * Parity port of the Python reference `_graph.py`. The graph is
 * deliberately a plain data model with no behaviour beyond structural
 * equality. Emission, read-back and checking are separate concerns that
 * consume this model, so the round-trip can be reasoned about as data,
 * not as side effects.
 *
 * TypeScript host note: TS type annotations erase at runtime, so In/Out
 * cannot be reflected from a function's type the way the Python host
 * reads `__annotations__`. The host therefore carries the topo type as
 * an explicit `TypeRef` schema descriptor — the same representational
 * stance the config port took (TS types erase -> explicit schema/Record
 * descriptors). The contract is unchanged: In/Out are stated once at the
 * registration site and never re-declared in hand-written `.topo`.
 */

/**
 * A topo type as it will be spelled in `.topo`.
 *
 * `scalar` carries a stdlib scalar alias (`int` / `float` / `bool` /
 * `str`). `record` carries an ordered field list `[name, TypeRef][]`.
 * Exactly one of the two is populated; `void` (no input / terminal) is
 * represented by the absence of a TypeRef at the use site, never by a
 * TypeRef instance.
 */
export class TypeRef {
  /**
   * @param {{scalar?: string, record?: Array<[string, TypeRef]>}} opts
   */
  constructor({ scalar = null, record = null } = {}) {
    this.scalar = scalar;
    // Store record fields as a frozen tuple-of-pairs so a TypeRef is
    // value-stable: field order is part of the type's identity.
    this.record = record === null ? null : record.map(([n, t]) => [n, t]);
    Object.freeze(this);
  }

  topo() {
    if (this.record !== null) {
      const inner = this.record
        .map(([n, t]) => `${n}: ${t.topo()}`)
        .join(", ");
      return `record<${inner}>`;
    }
    // `scalar` is guaranteed non-null when `record` is null (constructed
    // only via the reflect/Record paths, which reject everything else).
    return this.scalar;
  }
}

/** A registered logic unit. `inType` is null for a source handler. */
export class Handler {
  /**
   * @param {string} name
   * @param {TypeRef|null} inType
   * @param {TypeRef} outType
   */
  constructor(name, inType, outType) {
    this.name = name;
    this.inType = inType;
    this.outType = outType;
  }

  signature() {
    // The single input parameter is conventionally named `in` to match
    // the handler-input form; a source handler has no parameter.
    const param = this.inType === null ? "" : `${this.inType.topo()} in`;
    return `handler ${this.name}(${param}) -> ${this.outType.topo()};`;
  }
}

/**
 * A pipeline edge inside a flow. `target` is null for a terminal edge
 * (`source -> void;`).
 */
export class Edge {
  /**
   * @param {string} source
   * @param {string|null} target
   */
  constructor(source, target) {
    this.source = source;
    this.target = target;
    Object.freeze(this);
  }

  get isTerminal() {
    return this.target === null;
  }
}

export class Flow {
  /**
   * @param {string} name
   * @param {Edge[]} edges
   */
  constructor(name, edges = []) {
    this.name = name;
    this.edges = edges;
  }
}

/**
 * The whole program: namespace, handlers, one flow.
 *
 * A single namespace + single flow keeps the slice minimal while still
 * exercising every mapping rule topo-app commits to.
 */
export class Graph {
  /**
   * @param {string} namespace
   * @param {Handler[]} handlers
   * @param {Flow|null} flow
   */
  constructor(namespace, handlers = [], flow = null) {
    this.namespace = namespace;
    this.handlers = handlers;
    this.flow = flow;
  }

  /** @returns {Handler|null} */
  handler(name) {
    for (const h of this.handlers) {
      if (h.name === name) return h;
    }
    return null;
  }

  // --- Semantic equality (the round-trip's headline acceptance) -------

  /**
   * A canonical, order-insensitive description of the graph's meaning.
   * Two graphs are semantically equivalent iff their keys are equal.
   * Handler order and edge order do not change meaning (the stage
   * topology is derived from the edge set), so both are sorted. The key
   * is a JSON string so structural equality is a plain `===`.
   */
  semanticKey() {
    const handlers = this.handlers
      .map((h) => [
        h.name,
        h.inType === null ? null : h.inType.topo(),
        h.outType.topo(),
      ])
      .sort(_cmpArrays);
    const flowName = this.flow ? this.flow.name : null;
    const edges = this.flow
      ? this.flow.edges
          .map((e) => [e.source, e.target])
          .sort(_cmpArrays)
      : [];
    return JSON.stringify([this.namespace, flowName, handlers, edges]);
  }

  /** @param {Graph} other */
  equivalentTo(other) {
    return this.semanticKey() === other.semanticKey();
  }
}

// Stable lexicographic order over equal-length arrays of nullable
// strings, so semanticKey() is order-insensitive the same way the
// Python reference's `sorted(...)` over tuples is. `null` sorts before
// any string, matching Python's `None < str` only being relied on for
// the void target (a non-terminal target is always a name string).
function _cmpArrays(a, b) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === null) return -1;
    if (y === null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
