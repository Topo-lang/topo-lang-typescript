/**
 * topo-app TypeScript surface: idiomatic registration, not a macro DSL.
 *
 * The proposal fixes the philosophy (Functor model + the five
 * declaration principles) and leaves each topo-lang to project it onto
 * its own idioms. The Python projection is a decorator that reflects
 * `__annotations__`. TypeScript erases types at runtime, so there is
 * nothing to reflect; the TS projection is an explicit registration call
 * carrying a value-level In/Out schema descriptor — the same
 * representational decision the config port made (TS types erase ->
 * explicit schema descriptors). It is still ordinary code: no new
 * syntax, no metaclass / Proxy magic, no decorator transpiler needed.
 *
 * A handler stays a normal callable after registration, so it remains
 * independently invocable and unit-testable with zero framework
 * bootstrap (a free consequence of the Functor model — the registry
 * holds a reference to the same function the caller passed, untouched).
 */

import { Edge, Flow, Graph, Handler } from "./_graph.mjs";
import { reflectSignature } from "./_reflect.mjs";

/**
 * A topo-app program: the in-memory logic graph plus the callables.
 *
 * One App owns one namespace and (for this slice) one flow — enough to
 * exercise every proposal mapping rule without productionizing.
 */
export class App {
  /** @param {string} namespace */
  constructor(namespace) {
    this._graph = new Graph(namespace);
    /** @type {Map<string, Function>} */
    this._fns = new Map();
  }

  // --- registration ---------------------------------------------------

  /**
   * Register a logic unit.
   *
   *   app.handler(parse, { in: "str", out: OrderRec });
   *   app.handler(seed, { out: "int" });           // source handler
   *
   * The function name is taken from `fn.name` (matching the Python host
   * reading `f.__name__`); pass `{ name }` to override for anonymous
   * functions. In/Out are stated once here, never re-declared in
   * `.topo`. The function is returned unchanged so the call site can
   * keep using it directly.
   *
   * @template {Function} F
   * @param {F} fn
   * @param {{in?: any, out: any, name?: string}} spec
   * @returns {F}
   */
  handler(fn, spec) {
    if (typeof fn !== "function") {
      throw new TypeError("app.handler(fn, spec): fn must be a function");
    }
    const name = (spec && spec.name) || fn.name;
    if (!name) {
      throw new TypeError(
        "handler has no name; pass { name } for an anonymous function"
      );
    }
    const [inType, outType] = reflectSignature(name, spec);
    this._graph.handlers.push(new Handler(name, inType, outType));
    this._fns.set(name, fn);
    return fn; // unchanged: still a plain, independently callable fn
  }

  /**
   * Declare a linear logic chain: `flow("p", a, b, c)` becomes edges
   * a->b->c->void. A `parallel(...)` member fans in/out from the same
   * neighbours (same-source / same-sink == same-stage parallel
   * candidates, per the proposal's mapping table).
   *
   * Stages are the registered functions themselves (or `parallel(...)`
   * groups of them); the name is resolved from the function reference,
   * so a flow lists the callables, never re-spells handler names.
   *
   * @param {string} name
   * @param {...(Function|_Parallel)} stages
   */
  flow(name, ...stages) {
    const names = (stage) => {
      if (stage instanceof _Parallel) {
        return stage.members.map((m) => this._nameOf(m));
      }
      return [this._nameOf(stage)];
    };

    /** @type {Edge[]} */
    const edges = [];
    for (let i = 0; i < stages.length - 1; i++) {
      for (const src of names(stages[i])) {
        for (const tgt of names(stages[i + 1])) {
          edges.push(new Edge(src, tgt));
        }
      }
    }
    for (const src of names(stages[stages.length - 1])) {
      edges.push(new Edge(src, null)); // terminal -> void
    }

    this._graph.flow = new Flow(name, edges);
  }

  // A flow stage must be a registered handler; resolving by identity (not
  // by re-spelled string) keeps the flow honest — an unregistered
  // function is rejected here rather than emitting a dangling edge.
  _nameOf(fn) {
    for (const [n, f] of this._fns) {
      if (f === fn) return n;
    }
    throw new TypeError(
      `flow stage ${fn && fn.name ? `'${fn.name}'` : fn} is not a ` +
        "registered handler; register it with app.handler(...) first"
    );
  }

  // --- introspection / round-trip ------------------------------------

  /** @returns {Graph} */
  get graph() {
    return this._graph;
  }

  /** @returns {Function|undefined} */
  callableFor(name) {
    return this._fns.get(name);
  }
}

class _Parallel {
  constructor(members) {
    this.members = members;
  }
}

/**
 * Independent units on the same input == same-stage parallel candidates
 * (proposal mapping rule). Purity of these is enforced by core
 * PurityCheck after emission, not self-asserted here.
 *
 * @param {...Function} members
 * @returns {_Parallel}
 */
export function parallel(...members) {
  return new _Parallel(members);
}

export { _Parallel };
