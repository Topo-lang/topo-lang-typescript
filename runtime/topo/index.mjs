/**
 * topo-app — Topo's quick-start framework, TypeScript projection.
 *
 * Write idiomatic TypeScript handlers/flows; the framework produces a
 * round-trippable `.topo` contract that the existing Topo toolchain
 * consumes and checks. The user writes no `.topo` by hand.
 *
 * This is the public surface barrel — the counterpart of the Python
 * `topo/__init__.py`. It aggregates the logic-graph framework
 * (App / parallel / Record / config / check) and re-exports the
 * already-shipped product-runtime configuration surface so a consumer
 * imports one module the way the Python suite imports `topo`.
 *
 *     import { App, parallel, Record, Field, config, check } from
 *       "./topo/index.mjs";
 *
 *     const app = new App("orders");
 *     const OrderRec = Record(Field("id", "int"), Field("amount", "float"));
 *     const parse = app.handler(function parse(raw) { ... },
 *                               { in: "str", out: OrderRec });
 *     app.flow("pipeline", parse, validate, persist);
 *
 *     const cfg = config(app);
 *     cfg.snapshot();           // whole graph, one place
 *     cfg.emitTopo("o.topo");   // the round-trippable .topo view
 *     check(app, ["app.ts"]);   // zero-declaration topo-check
 */

// --- logic-graph framework (this port) ---------------------------------
export { App, parallel } from "./app.mjs";
export { Record, Field } from "./_reflect.mjs";
export { config, Config } from "./app_config.mjs";
export { check } from "./check.mjs";
export { emitTopo } from "./_emit.mjs";
export { readTopo } from "./_readback.mjs";
export { Graph, Handler, Edge, Flow, TypeRef } from "./_graph.mjs";

// --- product-runtime configuration (already shipped) -------------------
// Re-exported so the single public surface matches the Python
// `__init__.py`, which exposes both the framework and the product
// config from `topo`.
export { ProductConfig } from "./config.mjs";
export {
  ItemPolicy,
  ImpactLevel,
  DevInternalRegistry,
  DevInternalItem,
} from "./_config_model.mjs";
