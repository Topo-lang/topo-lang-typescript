/**
 * Acceptance for the unified browse + agent-introspection entry: one
 * call that returns, within the caller's read tier, a self-describing
 * row per runtime config item, plus a structurally separate dev-phase
 * listing of the pure-internal (d) band. Parity port of the Python
 * `test_config_browse.py`.
 *
 * The central correctness risk this file guards is that the browse
 * routes through the tier-aware door (queryResolved/query/policyOf) and
 * never the tier-blind resolveAll: a permission-gated item must not leak
 * into a lower-level caller's browse. The tiered-transparency invariant
 * (the top level sees every runtime item; each level sees exactly that
 * level's complete range) is asserted explicitly.
 *
 * Run: `node --test topo-lang-typescript/runtime/test/`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NO_DEFAULT,
  BrowseEntry,
  ConfigStore,
  ImpactLevel,
  ItemPolicy,
  Layer,
  LayeredConfig,
} from "../topo/_config_model.mjs";
import { ProductConfig } from "../topo/config.mjs";

function layeredStore() {
  // Values arriving from all three runtime layers, a mix of impact
  // levels, read tiers, and freely-combinable tags — so every
  // documented row field can be checked against a known provenance.
  const store = new ConfigStore(
    new LayeredConfig({
      inlined: {
        "log.level": "warn",
        "net.timeout_ms": 1000,
        "cache.size": 256,
        "db.dsn": "postgres://default",
      },
      external: { "net.timeout_ms": 5000 },
      injected: { "cache.size": 512, "feature.flag": true },
    }),
  );
  store.declare("log.level", new ItemPolicy({ tags: ["obs"] }));
  store.declare(
    "net.timeout_ms",
    new ItemPolicy({ tags: ["network", "tuning"], impact: ImpactLevel.HIGH }),
  );
  store.declare("cache.size", new ItemPolicy({ tags: ["tuning"] }));
  store.declare("feature.flag", new ItemPolicy({ tags: ["features"] }));
  store.declare(
    "db.dsn",
    new ItemPolicy({ tags: ["network"], readLevel: 2, impact: ImpactLevel.HIGH }),
  );
  return store;
}

const rowByKey = (rows) => new Map(rows.map((r) => [r.key, r]));

describe("FullPerItemSchema", () => {
  it("every documented field is present and correct", () => {
    const store = layeredStore();
    const rows = store.browse(null, store.maxReadLevel());
    const by = rowByKey(rows);

    for (const r of rows) {
      assert.ok(r instanceof BrowseEntry);
      for (const fld of [
        "key",
        "type",
        "default",
        "effective",
        "layer",
        "impact",
        "requiredWriteLevel",
        "requiredReadLevel",
        "tags",
      ]) {
        assert.ok(fld in r, `missing field ${fld}`);
      }
    }

    const log = by.get("log.level");
    assert.equal(log.type, "str");
    assert.equal(log.default, "warn");
    assert.equal(log.effective, "warn");
    assert.equal(log.layer, Layer.B);
    assert.equal(log.impact, ImpactLevel.LOW);
    assert.equal(log.requiredWriteLevel, 0);
    assert.equal(log.requiredReadLevel, 0);
    assert.deepEqual(log.tags, new Set(["obs"]));

    const net = by.get("net.timeout_ms");
    assert.equal(net.type, "int");
    assert.equal(net.default, 1000);
    assert.equal(net.effective, 5000);
    assert.equal(net.layer, Layer.A);
    assert.equal(net.impact, ImpactLevel.HIGH);
    assert.equal(net.requiredWriteLevel, 1);
    assert.equal(net.requiredReadLevel, 0);
    assert.deepEqual(net.tags, new Set(["network", "tuning"]));

    const cache = by.get("cache.size");
    assert.equal(cache.type, "int");
    assert.equal(cache.default, 256);
    assert.equal(cache.effective, 512);
    assert.equal(cache.layer, Layer.C);

    const flag = by.get("feature.flag");
    assert.equal(flag.type, "bool");
    assert.equal(flag.default, NO_DEFAULT);
    assert.equal(flag.effective, true);
    assert.equal(flag.layer, Layer.C);

    const dsn = by.get("db.dsn");
    assert.equal(dsn.requiredReadLevel, 2);
    assert.equal(dsn.requiredWriteLevel, 1);
    assert.equal(dsn.type, "str");
  });
});

describe("TieredTransparencyInvariant", () => {
  it("gated item absent below tier, present at and above", () => {
    const store = layeredStore();
    const below = new Set(store.browse(null, 0).map((r) => r.key));
    assert.ok(!below.has("db.dsn"));
    const at = new Set(store.browse(null, 2).map((r) => r.key));
    assert.ok(at.has("db.dsn"));
    const above = new Set(store.browse(null, 5).map((r) => r.key));
    assert.ok(above.has("db.dsn"));
  });

  it("top-level browse equals the complete runtime key set", () => {
    const store = layeredStore();
    const top = store.maxReadLevel();
    const browsed = store
      .browse(null, top)
      .map((r) => r.key)
      .sort();
    assert.deepEqual(browsed, store.keys());
  });

  it("each level is exactly that level's complete range", () => {
    const store = layeredStore();
    const zero = store
      .browse(null, 0)
      .map((r) => r.key)
      .sort();
    const expectedZero = store
      .keys()
      .filter((k) => store.policyOf(k).readLevel === 0)
      .sort();
    assert.deepEqual(zero, expectedZero);
  });
});

describe("RoutesThroughTierAwareDoor", () => {
  it("browse does not use resolveAll to leak", () => {
    const store = layeredStore();
    const tierBlind = new Set(store.resolveAll().keys());
    assert.ok(tierBlind.has("db.dsn"));
    const browsedKeys = new Set(store.browse(null, 0).map((r) => r.key));
    assert.ok(!browsedKeys.has("db.dsn"));
    assert.notDeepEqual(browsedKeys, tierBlind);
    for (const r of store.browse(null, 0)) {
      assert.notEqual(r.key, "db.dsn");
    }
  });
});

describe("IdentityIndependence", () => {
  it("signature has no principal/identity param", () => {
    for (const fn of [ConfigStore.prototype.browse, ProductConfig.prototype.browse]) {
      const sig = fn.toString().slice(0, fn.toString().indexOf(")") + 1);
      for (const forbidden of ["principal", "identity", "user", "agent"]) {
        assert.ok(
          !new RegExp(`\\b${forbidden}\\b`).test(sig),
          `${fn.name} must not take a ${forbidden} arg`,
        );
      }
    }
  });

  it("same level yields an identical (structurally equal) browse", () => {
    const store = layeredStore();
    const a = store.browse(null, 1);
    const b = store.browse(null, 1);
    assert.deepEqual(a, b);
  });
});

describe("LiveDerivedNoStaticList", () => {
  it("a key added after construction auto-appears", () => {
    const store = layeredStore();
    const before = new Set(store.browse(null, 0).map((r) => r.key));
    assert.ok(!before.has("late.added"));
    store.set("late.added", "hi"); // lands in the external (a) layer
    const after = new Set(store.browse(null, 0).map((r) => r.key));
    assert.ok(after.has("late.added"));
  });
});

describe("DevPhaseDListing", () => {
  it("d absent from runtime browse at every level", () => {
    const cfg = new ProductConfig({ inlined: { "log.level": "warn" } });
    cfg.declareInternal("BUILD_SALT", "abc123", ["crypto"]);
    cfg.declareInternal("MAX_WIDGETS", 64, ["limits"]);
    for (const level of [0, 1, 99]) {
      const keys = new Set(cfg.browse(null, level).map((r) => r.key));
      assert.ok(!keys.has("BUILD_SALT"));
      assert.ok(!keys.has("MAX_WIDGETS"));
    }
    assert.ok(!cfg.keys().includes("BUILD_SALT"));
  });

  it("d present only in dev listing and tag-searchable", () => {
    const cfg = new ProductConfig();
    cfg.declareInternal("BUILD_SALT", "abc123", ["crypto"]);
    cfg.declareInternal("MAX_WIDGETS", 64, ["limits"]);
    const listed = new Set(cfg.devBrowse().map((r) => r.name));
    assert.deepEqual(listed, new Set(["BUILD_SALT", "MAX_WIDGETS"]));
    const crypto = cfg.devBrowse(["crypto"]);
    assert.deepEqual(
      crypto.map((r) => r.name),
      ["BUILD_SALT"],
    );
    assert.equal(crypto[0].value, "abc123");
    assert.deepEqual(crypto[0].tags, new Set(["crypto"]));
  });

  it("dev_browse shape is distinct from a runtime entry", () => {
    const cfg = new ProductConfig();
    cfg.declareInternal("BUILD_SALT", "abc123", ["crypto"]);
    const rec = cfg.devBrowse()[0];
    assert.ok(!(rec instanceof BrowseEntry));
    assert.equal(rec.constructor, Object);
    assert.deepEqual(new Set(Object.keys(rec)), new Set(["name", "value", "tags"]));
  });

  it("no d declared yields an empty listing without a registry", () => {
    const cfg = new ProductConfig();
    assert.deepEqual(cfg.devBrowse(), []);
    assert.equal(cfg._devInternal, null);
  });
});

describe("ProductConfigBrowseParity", () => {
  it("bridge browse is a passthrough to the model", () => {
    const cfg = new ProductConfig({
      inlined: { "a.x": 1, "b.y": "two" },
      injected: { "a.x": 9 },
    });
    cfg.declare("b.y", new ItemPolicy({ tags: ["t"], readLevel: 1 }));
    const low = new Set(cfg.browse(null, 0).map((r) => r.key));
    assert.deepEqual(low, new Set(["a.x"]));
    const full = cfg.browse(null, cfg.maxReadLevel());
    assert.ok(full.every((r) => r instanceof BrowseEntry));
    assert.deepEqual(new Set(full.map((r) => r.key)), new Set(["a.x", "b.y"]));
    const ax = rowByKey(full).get("a.x");
    assert.equal(ax.default, 1);
    assert.equal(ax.effective, 9);
    assert.equal(ax.layer, Layer.C);
  });
});
