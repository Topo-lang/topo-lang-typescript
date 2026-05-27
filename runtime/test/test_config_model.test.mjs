/**
 * Acceptance for the layered product-config model: frozen a/b/c merge
 * precedence, per-value provenance, and the Topo.toml boundary guard.
 * Parity port of the Python `test_config_model.py`.
 *
 * Run: `node --test topo-lang-typescript/runtime/test/`
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  PRODUCT_CONFIG_FILENAME,
  BuildConfigKeyError,
  Layer,
  LayeredConfig,
  KeyError,
  AssertionError,
  iterProvenance,
  mergeLayers,
  rejectIfBuildConfigKey,
} from "../topo/_config_model.mjs";

describe("MergePrecedence", () => {
  let cfg;
  beforeEach(() => {
    // Each layer is the sole winner of at least one key, plus a key all
    // three set so precedence is unambiguous.
    cfg = new LayeredConfig({
      inlined: {
        "log.level": "warn", // only b -> b wins
        "cache.size": 64, // b, overridden by a
        "retry.count": 1, // b, overridden by a and c
      },
      external: {
        "cache.size": 256, // a beats b
        "retry.count": 3, // a beats b, lost to c
        "feature.flag": true, // only a -> a wins
      },
      injected: {
        "retry.count": 9, // c beats a and b
        "tracing.enabled": false, // only c -> c wins
      },
    });
  });

  it("each key has a unique effective value and provenance", () => {
    const r = cfg.resolveAll();
    assert.equal(r.get("log.level").value, "warn");
    assert.equal(r.get("log.level").layer, Layer.B);
    assert.equal(r.get("cache.size").value, 256);
    assert.equal(r.get("cache.size").layer, Layer.A);
    assert.equal(r.get("feature.flag").value, true);
    assert.equal(r.get("feature.flag").layer, Layer.A);
    // Set by all three layers: c (most explicit) must win.
    assert.equal(r.get("retry.count").value, 9);
    assert.equal(r.get("retry.count").layer, Layer.C);
    assert.equal(r.get("tracing.enabled").value, false);
    assert.equal(r.get("tracing.enabled").layer, Layer.C);
  });

  it("keys enumerates every layer once, sorted", () => {
    assert.deepEqual(cfg.keys(), [
      "cache.size",
      "feature.flag",
      "log.level",
      "retry.count",
      "tracing.enabled",
    ]);
  });

  it("iterProvenance yields triples in stable key order", () => {
    assert.deepEqual(iterProvenance(cfg.resolveAll()), [
      ["cache.size", 256, Layer.A],
      ["feature.flag", true, Layer.A],
      ["log.level", "warn", Layer.B],
      ["retry.count", 9, Layer.C],
      ["tracing.enabled", false, Layer.C],
    ]);
  });

  it("mergeLayers helper matches", () => {
    const r = mergeLayers({ inlined: { x: 1 }, external: { x: 2 }, injected: { x: 3 } });
    assert.equal(r.get("x").value, 3);
    assert.equal(r.get("x").layer, Layer.C);
  });

  it("unknown key raises", () => {
    assert.throws(() => cfg.resolve("does.not.exist"), KeyError);
  });

  it("d layer is not a runtime merge layer", () => {
    // d exists in the vocabulary but is promoted to code, never merged
    // at runtime — asking the model to read it as a layer is an
    // explicit construction error, not a silent empty result.
    assert.throws(() => new LayeredConfig()._layerMap(Layer.D), AssertionError);
  });
});

describe("TopoTomlBoundary", () => {
  it("build section key rejected and points to Topo.toml", () => {
    assert.throws(
      () => rejectIfBuildConfigKey("build.language"),
      (e) =>
        e instanceof BuildConfigKeyError &&
        e.message.includes("Topo.toml") &&
        e.message.includes(PRODUCT_CONFIG_FILENAME),
    );
  });

  it("feature-mode section keys rejected", () => {
    for (const key of [
      "parallel.mode",
      "adaptive.min_trigger_ns",
      "optimize.indirection",
      "check.jobs",
      "topo.root",
    ]) {
      assert.throws(() => rejectIfBuildConfigKey(key), BuildConfigKeyError);
    }
  });

  it("build key in the a layer rejected on resolveAll", () => {
    const cfg = new LayeredConfig({ external: { "build.standard": "c++20" } });
    assert.throws(
      () => cfg.resolveAll(),
      (e) => e instanceof BuildConfigKeyError && e.message.includes("Topo.toml"),
    );
  });

  it("product key with a similar name is not rejected", () => {
    // Only the exact build sections are off-limits; product keys that
    // merely look related are fine.
    rejectIfBuildConfigKey("checkout.timeout_ms"); // not [check]
    rejectIfBuildConfigKey("testing_endpoint.url"); // not [test]
    const cfg = new LayeredConfig({ inlined: { "checkout.timeout_ms": 5000 } });
    assert.equal(cfg.resolve("checkout.timeout_ms").value, 5000);
  });
});
