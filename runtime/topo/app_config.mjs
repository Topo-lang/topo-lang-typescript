/**
 * The single unified configuration entry for a topo-app *logic graph*
 * (the topo-app design's "snapshot 与 emit 的 .topo 是同一逻辑结构两视图").
 *
 * `snapshot()` and `emitTopo()` are two views of the *same* logic
 * structure: the snapshot is the human/agent overview, the .topo is the
 * toolchain-consumable contract. They are kept consistent by
 * construction because both derive from the same Graph.
 *
 * This is the graph-level counterpart of the Python `config.py`'s
 * `config()` / `Config`. It is deliberately a separate module from the
 * product-runtime `config.mjs` (the `ProductConfig` / TOML bridge):
 * those answer "how does the running product behave", this answers
 * "what is the program's logic graph". The Python reference colocates
 * both in one file; the TS port keeps the already-shipped product-config
 * bridge untouched and adds the graph entry alongside it, with the
 * public `topo` surface (the index barrel) re-exporting `config` to the
 * graph entry exactly as the Python `__init__.py` does.
 */

import { emitTopo } from "./_emit.mjs";
import { readTopo } from "./_readback.mjs";
import { writeFileSync } from "node:fs";

export class Config {
  /** @param {import("./app.mjs").App} app */
  constructor(app) {
    this._app = app;
  }

  /** @returns {import("./_graph.mjs").Graph} */
  get graph() {
    return this._app.graph;
  }

  /**
   * The full graph: every handler with In/Out, every connection. One
   * place, the whole picture.
   */
  snapshot() {
    const g = this._app.graph;
    return {
      namespace: g.namespace,
      handlers: g.handlers.map((h) => ({
        name: h.name,
        in: h.inType === null ? null : h.inType.topo(),
        out: h.outType.topo(),
      })),
      flow:
        g.flow === null
          ? null
          : {
              name: g.flow.name,
              edges: g.flow.edges.map((e) => ({
                from: e.source,
                to: e.isTerminal ? "void" : e.target,
              })),
            },
    };
  }

  /**
   * The round-trippable .topo view of the same structure. Writes it to
   * `path` when given; always returns the text.
   *
   * @param {string} [path]
   * @returns {string}
   */
  emitTopo(path) {
    const text = emitTopo(this._app.graph);
    if (path !== undefined) {
      writeFileSync(path, text, "utf-8");
    }
    return text;
  }

  /**
   * Emit then read back through the real parser. Returns graph'.
   * @returns {import("./_graph.mjs").Graph}
   */
  roundtrip() {
    return readTopo(this.emitTopo());
  }
}

/**
 * The one `topo.config(app)` entry the topo-app design names.
 * @param {import("./app.mjs").App} app
 * @returns {Config}
 */
export function config(app) {
  return new Config(app);
}
