/**
 * Acceptance for two innermost-band mechanisms:
 *  - code-layer inlined / hidden TOML (the embedded `b` default): no
 *    scattered external file needed, the embedded block restores to
 *    equivalent TOML (round-trip), and the items still enumerate
 *    normally — embedding hides the *file*, not the *items*; a/c still
 *    override b.
 *  - the pure-internal band: declarable only in code, discoverable only
 *    in a dev-phase registry the runtime store never consults, promoted
 *    to a plain constant with zero runtime config footprint.
 *
 * Parity port of the Python `test_config_inline_internal.py`. The Python
 * suite re-parses with stdlib `tomllib`; this suite re-parses with the
 * bridge's own matched reader (the round-trip is between the bridge's
 * writer and reader — exactly the encode∘decode identity the Python
 * bridge guarantees against `tomllib`).
 *
 * Run: `node --test topo-lang-typescript/runtime/test/`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AssertionError,
  BuildConfigKeyError,
  ConfigStore,
  DevInternalRegistry,
  ItemPolicy,
  KeyError,
  Layer,
  LayeredConfig,
  RUNTIME_MERGE_ORDER,
  UnbridgedValueError,
} from "../topo/_config_model.mjs";
import { ProductConfig } from "../topo/config.mjs";

const TOML_SRC = `log_level = "info"
retries = 3
ratio = 0.5
enabled = true

[net]
host = "example.com"
ports = [80, 443]
`;

// The data the source decodes to — the round-trip oracle (re-parsing
// restored text must equal this).
const DECODED = {
  log_level: "info",
  retries: 3,
  ratio: 0.5,
  enabled: true,
  net: { host: "example.com", ports: [80, 443] },
};

describe("InlineDeclareNoExternalFileNeeded", () => {
  it("inline-declared defaults need no external file", () => {
    const pc = new ProductConfig(); // path is null: nothing on disk
    pc.declareInlinedToml(TOML_SRC);
    assert.equal(pc.path, null);
    assert.equal(pc.get("log_level"), "info");
    assert.equal(pc.get("net.host"), "example.com");
    assert.deepEqual(pc.get("net.ports"), [80, 443]);
    for (const key of pc.keys()) {
      assert.equal(pc.resolve(key).layer, Layer.B);
    }
  });

  it("accepts an already-decoded object too", () => {
    const pc = new ProductConfig();
    pc.declareInlinedToml({ a: 1, nested: { b: 2 } });
    assert.equal(pc.get("a"), 1);
    assert.equal(pc.get("nested.b"), 2);
  });
});

describe("InlineRoundTrip", () => {
  it("restore yields TOML re-parsing to identical data", () => {
    const pc = new ProductConfig();
    pc.declareInlinedToml(TOML_SRC);
    const restored = pc.restoreInlinedToml();
    // Re-parse the restored text through a fresh inline declare and
    // confirm the resolved data equals the original decoded data.
    const pc2 = new ProductConfig();
    pc2.declareInlinedToml(restored);
    const reparsed = {};
    for (const k of pc2.keys()) {
      // Rebuild a nested object from the flat keys for a structural
      // equality check against the decoded oracle.
      const parts = k.split(".");
      let cur = reparsed;
      for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
      cur[parts[parts.length - 1]] = pc2.get(k);
    }
    assert.deepEqual(reparsed, DECODED);
  });

  it("restore is idempotent under re-parse", () => {
    const pc = new ProductConfig();
    pc.declareInlinedToml(TOML_SRC);
    const once = pc.restoreInlinedToml();
    const pc2 = new ProductConfig();
    pc2.declareInlinedToml(once);
    assert.equal(pc2.restoreInlinedToml(), once);
  });

  it("empty inline restores to empty", () => {
    const pc = new ProductConfig();
    pc.declareInlinedToml({});
    assert.equal(pc.restoreInlinedToml(), "");
  });
});

describe("FileHiddenNotItemHidden", () => {
  it("inlined items still enumerate under normal rules", () => {
    const pc = new ProductConfig();
    pc.declareInlinedToml(TOML_SRC);
    const keys = pc.keys();
    for (const k of [
      "log_level",
      "retries",
      "ratio",
      "enabled",
      "net.host",
      "net.ports",
    ]) {
      assert.ok(keys.includes(k));
    }
    pc.declare("retries", new ItemPolicy({ tags: ["tuning"] }));
    pc.declare("net.host", new ItemPolicy({ readLevel: 2 }));
    assert.deepEqual(pc.query(["tuning"]), ["retries"]);
    assert.ok(!pc.query().includes("net.host"));
    assert.ok(pc.query(null, 2).includes("net.host"));
    const rv = pc.queryResolved();
    assert.ok(rv.has("log_level"));
    assert.equal(rv.get("log_level").value, "info");
  });

  it("a and c still override inlined b", () => {
    const pc = new ProductConfig({ inlined: {}, injected: { retries: 99 } });
    pc.declareInlinedToml(TOML_SRC);
    assert.equal(pc.get("retries"), 99); // c overrides b
    assert.equal(pc.resolve("retries").layer, Layer.C);
    pc.set("log_level", "debug"); // a overrides b
    assert.equal(pc.get("log_level"), "debug");
    assert.equal(pc.resolve("log_level").layer, Layer.A);
    assert.equal(pc.get("ratio"), 0.5); // untouched -> still b
    assert.equal(pc.resolve("ratio").layer, Layer.B);
  });

  it("inline layer rejects a build-toolchain key", () => {
    const pc = new ProductConfig();
    assert.throws(
      () => pc.declareInlinedToml({ build: { language: "typescript" } }),
      BuildConfigKeyError,
    );
  });
});

describe("PureInternalDevPhaseOnly", () => {
  it("declared internal is dev-searchable by name and tag", () => {
    const pc = new ProductConfig();
    const value = pc.declareInternal("MAX_BUF", 4096, ["perf", "memory"]);
    assert.equal(value, 4096); // returns the plain value to bind
    assert.ok(pc.devInternal.names().includes("MAX_BUF"));
    assert.deepEqual(pc.devInternal.search(["perf"]), ["MAX_BUF"]);
    assert.deepEqual(pc.devInternal.search(["perf", "memory"]), ["MAX_BUF"]);
    assert.deepEqual(pc.devInternal.search(["unrelated"]), []);
    assert.equal(pc.devInternal.get("MAX_BUF").value, 4096);
  });

  it("internal absent from every runtime surface", () => {
    const pc = new ProductConfig({ inlined: { "public.k": 1 } });
    pc.declareInternal("SECRET_TUNING", 7, ["internal"]);
    assert.ok(!pc.keys().includes("SECRET_TUNING"));
    assert.ok(!pc.query().includes("SECRET_TUNING"));
    assert.ok(!pc.query(null, 999).includes("SECRET_TUNING"));
    assert.ok(!pc.store.resolveAll().has("SECRET_TUNING"));
    assert.ok(!pc.queryResolved(null, 999).has("SECRET_TUNING"));
    assert.throws(() => pc.get("SECRET_TUNING"), KeyError);
  });

  it("promoted value is a plain constant with no config reference", () => {
    const pc = new ProductConfig();
    const v = pc.declareInternal("RATE", 0.25);
    assert.equal(typeof v, "number");
    assert.equal(v, 0.25);
    // The store object holds no reference to the d registry.
    for (const attr of Object.values(pc.store)) {
      assert.ok(!(attr instanceof DevInternalRegistry));
    }
  });

  it("layer D stays out of the runtime merge", () => {
    assert.ok(!RUNTIME_MERGE_ORDER.includes(Layer.D));
    const cfg = new LayeredConfig({ inlined: { k: 1 } });
    assert.throws(() => cfg._layerMap(Layer.D), AssertionError);
  });

  it("internal value still honours the stdlib contract", () => {
    const pc = new ProductConfig();
    assert.throws(
      () => pc.declareInternal("WHEN", new Date("2026-05-16")),
      UnbridgedValueError,
    );
  });

  it("dev registry is disjoint from the store type", () => {
    const reg = new DevInternalRegistry();
    reg.declare("X", 1, ["t"]);
    const store = new ConfigStore(new LayeredConfig({ inlined: { X: 2 } }));
    // Same name in both is a coincidence, not a link.
    assert.equal(store.get("X"), 2);
    assert.equal(reg.get("X").value, 1);
  });
});
