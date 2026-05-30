/**
 * End-to-end acceptance for the topo-app TypeScript vertical slice.
 *
 * Parity port of the Python `test_vertical_slice.py` T1–T5. Each block
 * maps to the same acceptance criterion as its Python counterpart.
 *
 * Requires the freshly built toolchain binaries (`topo`, `topo-check`)
 * under the project `build/` tree (the LLVM-enabled build), or
 * TOPO_BIN_DIR pointing at them. `build-no-llvm/` is intentionally not
 * used — it mis-resolves and yields spurious parse failures.
 *
 * Run (explicit file list — `node --test <dir>` misfires on Node v26,
 * tracked issue):
 *   node --test topo-lang-typescript/runtime/test/test_vertical_slice.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { App, parallel } from "../topo/app.mjs";
import { Field, Record } from "../topo/_reflect.mjs";
import { config } from "../topo/app_config.mjs";
import { check } from "../topo/check.mjs";
import { emitTopo as rawEmit } from "../topo/_emit.mjs";
import { readTopo } from "../topo/_readback.mjs";

const OrderRec = Record(Field("id", "int"), Field("amount", "float"));

// Plain functions; the framework leaves them untouched (T1 asserts they
// stay independently callable). Bodies are irrelevant to the .topo
// contract — the schema descriptors carry In/Out.
function buildApp(namespace = "orders") {
  const app = new App(namespace);
  const parse = app.handler(
    function parse(raw) {
      return [raw.length, 1.0];
    },
    { in: "str", out: OrderRec }
  );
  const validate = app.handler(
    function validate(order) {
      return order;
    },
    { in: OrderRec, out: OrderRec }
  );
  const persist = app.handler(
    function persist(_order) {
      return true;
    },
    { in: OrderRec, out: "bool" }
  );
  app.flow("order_pipeline", parse, validate, persist);
  return app;
}

// --- T1 ----------------------------------------------------------------
describe("T1 Skeleton — graph is enumerable", () => {
  it("graph enumerable", () => {
    const g = buildApp().graph;
    assert.equal(g.namespace, "orders");
    assert.deepEqual(
      g.handlers.map((h) => h.name),
      ["parse", "validate", "persist"]
    );
    assert.equal(g.handler("parse").inType.topo(), "str");
    assert.equal(
      g.handler("parse").outType.topo(),
      "record<id: int, amount: float>"
    );
    assert.equal(g.handler("persist").outType.topo(), "bool");
    assert.ok(g.flow !== null);
    assert.equal(g.flow.edges.length, 3); // parse->validate->persist->void
  });

  it("source handler has no input", () => {
    // A no-input handler is a legal source handler.
    const app = new App("src");
    app.handler(
      function seed() {
        return 0;
      },
      { out: "int" }
    );
    assert.equal(app.graph.handler("seed").inType, null);
  });

  it("handler stays independently callable", () => {
    // A registered handler is a plain fn: no framework bootstrap needed.
    const app = new App("x");
    const double = app.handler(
      function double(n) {
        return n * 2;
      },
      { in: "int", out: "int" }
    );
    assert.equal(double(21), 42);
  });
});

// --- T2 ----------------------------------------------------------------
describe("T2 Emit — emitted .topo parses under the merged grammar", () => {
  it("emitted topo parses", () => {
    const text = config(buildApp()).emitTopo();
    assert.ok(
      text.includes(
        "handler parse(str in) -> record<id: int, amount: float>;"
      )
    );
    assert.ok(text.includes("flow order_pipeline {"));
    // readTopo() throws if `topo` rejects the source — parsing it is
    // itself the grammar-conformance proof (fresh binary).
    const g2 = readTopo(text);
    assert.equal(g2.namespace, "orders");
  });
});

// --- T3 ----------------------------------------------------------------
describe("T3 RoundTrip — graph == graph' (headline)", () => {
  it("semantic equivalence", () => {
    const g1 = buildApp().graph;
    const g2 = config(buildApp()).roundtrip();
    assert.ok(
      g1.equivalentTo(g2),
      `${g1.semanticKey()} != ${g2.semanticKey()}`
    );
  });

  it("hand edit survives readback", () => {
    // The .topo is a view, not an opaque IR: reorder edges by hand,
    // read back, still semantically equivalent.
    const app = buildApp();
    const text = config(app).emitTopo();
    const edited = text.replace(
      "      parse -> validate;\n      validate -> persist;",
      "      validate -> persist;\n      parse -> validate;"
    );
    assert.ok(app.graph.equivalentTo(readTopo(edited)));
  });
});

// --- T4 ----------------------------------------------------------------
// Zero hand-written .topo; the existing topo-check runs. The TS host's
// topo-check analyses `.ts` source, so the parity case supplies a `.ts`
// file whose function names match the emitted handlers. Mirrors the
// Python COMPLIANT / VIOLATING pair (parse -> parallel(enrich, audit) ->
// total, with `audit` doing a hidden module-global write in VIOLATING).

const COMPLIANT_TS = [
  "export function parse(raw: number): number {",
  "  return raw + 1;",
  "}",
  "export function enrich(v: number): number {",
  "  return v * 2;",
  "}",
  "export function audit(v: number): number {",
  "  return v;",
  "}",
  "export function total(v: number): number {",
  "  return v + 0.5;",
  "}",
  "",
].join("\n");

// `audit` reassigns a module-level mutable binding — the same purity
// violation the Python VIOLATING introduces, and the same shape the
// shipped TS purity fixture proves topo-check flags.
const VIOLATING_TS = [
  "let _log = 0;",
  "export function parse(raw: number): number {",
  "  return raw + 1;",
  "}",
  "export function enrich(v: number): number {",
  "  return v * 2;",
  "}",
  "export function audit(v: number): number {",
  "  _log = _log + v; // module-global write — purity violation",
  "  return v;",
  "}",
  "export function total(v: number): number {",
  "  return v + 0.5;",
  "}",
  "",
].join("\n");

function appWithSource(tsText) {
  const td = mkdtempSync(join(tmpdir(), "topo-app-vs-"));
  const src = join(td, "app.ts");
  writeFileSync(src, tsText, "utf-8");

  // Registration mirrors the .ts: int handlers, parse -> parallel(enrich,
  // audit) -> total. In/Out via explicit schema descriptors (TS erases
  // types), the same In/Out-once contract as the Python annotations.
  const app = new App("orders");
  const parse = app.handler(function parse(raw) { return raw + 1; },
    { in: "int", out: "int" });
  const enrich = app.handler(function enrich(v) { return v * 2; },
    { in: "int", out: "int" });
  const audit = app.handler(function audit(v) { return v; },
    { in: "int", out: "int" });
  const total = app.handler(function total(v) { return v + 0.5; },
    { in: "int", out: "float" });
  app.flow("pipeline", parse, parallel(enrich, audit), total);
  return [app, src];
}

describe("T4 ZeroDeclarationCheck — existing topo-check runs", () => {
  it("compliant app passes", () => {
    const [app, src] = appWithSource(COMPLIANT_TS);
    const r = check(app, [src]);
    assert.ok(r.passed, r.stdout + r.stderr);
  });

  it("violating handler is flagged", () => {
    // A flow handler with a hidden module-global write is a parallel
    // candidate at the same stage as a sibling; topo-check's PurityCheck
    // must flag it even though the source carries no hand-written .topo.
    const [app, src] = appWithSource(VIOLATING_TS);
    const r = check(app, [src]);
    assert.equal(
      r.passed,
      false,
      "violating handler should be flagged by topo-check"
    );
  });
});

// --- T5 ----------------------------------------------------------------
describe("T5 ConfigEntry — snapshot lists full graph", () => {
  it("snapshot lists full graph", () => {
    const snap = config(buildApp()).snapshot();
    assert.equal(snap.namespace, "orders");
    assert.equal(snap.handlers.length, 3);
    assert.equal(snap.flow.name, "order_pipeline");
    assert.equal(snap.flow.edges.length, 3);
  });

  it("config emit equals emitter output", () => {
    const app = buildApp();
    assert.equal(config(app).emitTopo(), rawEmit(app.graph));
  });
});
