/**
 * Acceptance for the tag system, the tag-query API, and the two
 * orthogonal multi-level permission roles (read-visibility tiering vs
 * the write mis-operation gate), plus the tiered-transparency invariant.
 * Parity port of the Python `test_config_tags_perm.py`.
 *
 * Run: `node --test topo-lang-typescript/runtime/test/`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as model from "../topo/_config_model.mjs";
import {
  ConfigStore,
  ImpactLevel,
  ItemPolicy,
  LayeredConfig,
  WriteProtectionError,
  authorizeWrite,
  requiredReadLevel,
} from "../topo/_config_model.mjs";
import { ProductConfig } from "../topo/config.mjs";

function taggedStore() {
  // Items carry freely-combinable tags and a mix of read tiers, so tag
  // AND, the no-tag default, and the read tier can each be exercised
  // independently.
  const store = new ConfigStore(
    new LayeredConfig({
      inlined: {
        "log.level": "warn",
        "net.timeout_ms": 5000,
        "net.retries": 3,
        "cache.size": 256,
        "db.dsn": "postgres://local",
        "secret.api_key": "k-xxx",
      },
    }),
  );
  store.declare("log.level", new ItemPolicy({ tags: ["obs"] }));
  store.declare("net.timeout_ms", new ItemPolicy({ tags: ["network", "tuning"] }));
  store.declare("net.retries", new ItemPolicy({ tags: ["network"] }));
  store.declare("cache.size", new ItemPolicy({ tags: ["tuning"] }));
  store.declare(
    "db.dsn",
    new ItemPolicy({ tags: ["network"], readLevel: 2, impact: ImpactLevel.HIGH }),
  );
  store.declare(
    "secret.api_key",
    new ItemPolicy({ tags: ["network"], readLevel: 3, impact: ImpactLevel.HIGH }),
  );
  return store;
}

describe("TagQuery", () => {
  it("single tag returns the exact subset (gated ones hidden)", () => {
    assert.deepEqual(taggedStore().query(["network"]), [
      "net.retries",
      "net.timeout_ms",
    ]);
  });

  it("multi tag is AND combination, order-independent", () => {
    const store = taggedStore();
    assert.deepEqual(store.query(["network", "tuning"]), ["net.timeout_ms"]);
    assert.deepEqual(store.query(["tuning", "network"]), ["net.timeout_ms"]);
  });

  it("no tag returns all non-permission items", () => {
    assert.deepEqual(taggedStore().query(), [
      "cache.size",
      "log.level",
      "net.retries",
      "net.timeout_ms",
    ]);
  });

  it("tag with no match returns empty", () => {
    assert.deepEqual(taggedStore().query(["does-not-exist"]), []);
  });

  it("queryResolved carries values and provenance", () => {
    const rv = taggedStore().queryResolved(["tuning"]);
    assert.deepEqual(new Set(rv.keys()), new Set(["net.timeout_ms", "cache.size"]));
    assert.equal(rv.get("cache.size").value, 256);
  });
});

describe("ReadVisibilityTiering", () => {
  it("gated item hidden without a credential", () => {
    const store = taggedStore();
    assert.ok(!store.query().includes("db.dsn"));
    assert.ok(!store.query().includes("secret.api_key"));
    assert.throws(() => store.read("db.dsn"), WriteProtectionError);
  });

  it("each level sees that level's complete range", () => {
    const store = taggedStore();
    const l2 = store.query(null, 2);
    assert.ok(l2.includes("db.dsn"));
    assert.ok(!l2.includes("secret.api_key"));
    assert.equal(store.read("db.dsn", 2), "postgres://local");
    assert.throws(() => store.read("secret.api_key", 2), WriteProtectionError);
  });

  it("tiered transparency: the highest level enumerates everything", () => {
    const store = taggedStore();
    const top = store.maxReadLevel();
    assert.equal(top, 3);
    assert.deepEqual(
      new Set(store.query(null, top)),
      new Set(store.keys()),
    );
    for (const key of store.keys()) {
      store.read(key, top); // every item actually readable at the top
    }
  });

  it("tag filter and read tier are orthogonal", () => {
    const store = taggedStore();
    const top = store.maxReadLevel();
    assert.deepEqual(store.query(["network"], top), [
      "db.dsn",
      "net.retries",
      "net.timeout_ms",
      "secret.api_key",
    ]);
    assert.deepEqual(store.query(["network"]), ["net.retries", "net.timeout_ms"]);
  });
});

describe("SameQueryDifferentSites", () => {
  it("two call-sites, different args, different visibility", () => {
    const store = taggedStore();
    const siteOne = store.query(["network"]);
    const siteTwo = store.query(["network"], store.maxReadLevel());
    assert.notDeepEqual(siteOne, siteTwo);
    assert.ok(!siteOne.includes("db.dsn"));
    assert.ok(siteTwo.includes("db.dsn"));
  });

  it("query surface takes no identity argument", () => {
    for (const fn of [
      ConfigStore.prototype.query,
      ConfigStore.prototype.queryResolved,
      ConfigStore.prototype.read,
      ConfigStore.prototype.maxReadLevel,
    ]) {
      const sig = fn.toString().slice(0, fn.toString().indexOf(")") + 1);
      for (const forbidden of ["identity", "principal", "user", "agent"]) {
        assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(sig));
      }
    }
  });
});

describe("WriteGateGeneralizedMultiLevel", () => {
  it("mid-level threshold via the required-credential table", () => {
    // The write gate is the orthogonal twin of read tiering. Insert a
    // mid threshold by extending the explicit table, not by rewriting
    // logic — proves the scale is multi-level.
    const original = new Map(model.REQUIRED_CREDENTIAL_LEVEL);
    try {
      const mid = model.ImpactLevel.HIGH; // reuse enum slot; map it to 2
      model.REQUIRED_CREDENTIAL_LEVEL.set(mid, 2);
      const store = new ConfigStore();
      store.declare("db.dsn", new ItemPolicy({ impact: mid }));
      assert.throws(() => store.set("db.dsn", "x", 1), WriteProtectionError); // below 2
      store.set("db.dsn", "ok", 2); // meets 2
      assert.equal(store.get("db.dsn"), "ok");
    } finally {
      model.REQUIRED_CREDENTIAL_LEVEL.clear();
      for (const [k, v] of original) model.REQUIRED_CREDENTIAL_LEVEL.set(k, v);
    }
  });

  it("read level and write gate are independent fields", () => {
    const store = new ConfigStore();
    store.declare(
      "public.but.guarded",
      new ItemPolicy({ readLevel: 0, impact: ImpactLevel.HIGH }),
    );
    store.declare(
      "gated.but.cheap",
      new ItemPolicy({ readLevel: 2, impact: ImpactLevel.LOW }),
    );
    assert.equal(requiredReadLevel(store.policyOf("public.but.guarded")), 0);
    assert.throws(() => store.set("public.but.guarded", 1), WriteProtectionError);
    assert.equal(requiredReadLevel(store.policyOf("gated.but.cheap")), 2);
    store.set("gated.but.cheap", 1); // write gate does not bite
    assert.throws(() => store.read("gated.but.cheap"), WriteProtectionError); // read tier still bites
  });

  it("authorizeWrite still identity-independent", () => {
    const sig = authorizeWrite
      .toString()
      .slice(0, authorizeWrite.toString().indexOf(")") + 1);
    for (const forbidden of ["identity", "principal", "user", "agent"]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(sig));
    }
  });
});

describe("BridgeExposesOneQueryAPI", () => {
  it("ProductConfig query is a pure passthrough", () => {
    const pc = new ProductConfig({ inlined: { a: 1, b: 2 } });
    pc.declare("b", new ItemPolicy({ tags: ["x"] }));
    pc.declare("a", new ItemPolicy({ readLevel: 2 }));
    assert.deepEqual(pc.query(), ["b"]); // a is read-gated
    assert.deepEqual(pc.query(["x"]), ["b"]);
    assert.equal(pc.maxReadLevel(), 2);
    assert.deepEqual(pc.query(null, 2), ["a", "b"]);
    assert.equal(pc.read("a", 2), 1);
  });
});
