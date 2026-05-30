/**
 * Acceptance for the layered product-config read/write API: get/set over
 * the frozen b ◁ a ◁ c precedence, stdlib-contract value validation, and
 * the identity-independent high-impact write gate. Parity port of the
 * Python `test_config_rw.py`.
 *
 * Run: `node --test topo-lang-typescript/runtime/test/`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BuildConfigKeyError,
  ConfigStore,
  ImpactLevel,
  ItemPolicy,
  KeyError,
  Layer,
  LayeredConfig,
  UnbridgedValueError,
  WriteProtectionError,
  authorizeWrite,
} from "../topo/_config_model.mjs";
import { ProductConfig } from "../topo/config.mjs";

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "topo-cfg-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("ReadWriteRoundTrip", () => {
  it("set then get through the store, c still wins over a", () => {
    const store = new ConfigStore(new LayeredConfig({ inlined: { "log.level": "warn" } }));
    store.set("log.level", "debug");
    assert.equal(store.get("log.level"), "debug");
    assert.equal(store.resolve("log.level").layer, Layer.A);
    store._cfg.injected.set("log.level", "trace");
    assert.equal(store.get("log.level"), "trace");
    assert.equal(store.resolve("log.level").layer, Layer.C);
  });

  it("get default only when no layer sets the key", () => {
    const store = new ConfigStore(new LayeredConfig({ inlined: { present: 1 } }));
    assert.equal(store.get("absent", 42), 42);
    assert.throws(() => store.get("absent"), KeyError); // no default -> no silent null
    assert.equal(store.get("present", 99), 1);
  });

  it("set reflected in the serialised external TOML and re-read", () => {
    withTempDir((td) => {
      const p = path.join(td, "topo-app.toml");
      const pc = new ProductConfig({ path: p });
      pc.set("cache.size", 256);
      pc.set("log.level", "debug");
      pc.set("feature.flags", ["a", "b"]);

      // Round-trips through a fresh ProductConfig over the same file
      // (the bridge's own matched reader — the round-trip contract).
      const pc2 = new ProductConfig({ path: p });
      assert.equal(pc2.get("cache.size"), 256);
      assert.equal(pc2.get("log.level"), "debug");
      assert.deepEqual(pc2.get("feature.flags"), ["a", "b"]);
    });
  });

  it("keys enumerates all layers", () => {
    const store = new ConfigStore(
      new LayeredConfig({ inlined: { "a.x": 1 }, injected: { "c.z": 3 } }),
    );
    store.set("b.y", 2);
    assert.deepEqual(store.keys(), ["a.x", "b.y", "c.z"]);
  });
});

describe("ValueTypeContract", () => {
  it("stdlib scalars accepted", () => {
    const store = new ConfigStore();
    store.set("s", "str");
    store.set("i", 7);
    store.set("f", 1.5);
    store.set("b", true);
    store.set("arr", [1, 2, 3]);
    store.set("rec", { id: 1, amount: 2.0 });
    assert.deepEqual(store.get("rec"), { id: 1, amount: 2.0 });
  });

  it("Date rejected, message points to the stdlib-bridging gap", () => {
    const store = new ConfigStore();
    assert.throws(
      () => store.set("event.at", new Date("2026-05-16T12:00:00Z")),
      (e) =>
        e instanceof UnbridgedValueError &&
        e.message.includes("event.at") && // locates the key
        e.message.includes("stdlib-bridging-types") && // names the gap source
        e.message.includes("time_*"), // names the missing family
    );
  });

  it("Date nested in an array rejected and located", () => {
    const store = new ConfigStore();
    assert.throws(
      () => store.set("schedule.points", [new Date("2026-01-01")]),
      (e) => e instanceof UnbridgedValueError && e.message.includes("schedule.points"),
    );
  });

  it("non-stdlib object rejected and located", () => {
    const store = new ConfigStore();
    class Custom {}
    assert.throws(
      () => store.set("weird.value", new Custom()),
      (e) =>
        e instanceof UnbridgedValueError &&
        e.message.includes("weird.value") &&
        e.message.includes("stdlib-bridging-types"),
    );
  });

  it("build-toolchain key still rejected on write", () => {
    const store = new ConfigStore();
    assert.throws(
      () => store.set("build.standard", "c++20"),
      (e) => e instanceof BuildConfigKeyError && e.message.includes("Topo.toml"),
    );
  });
});

describe("WriteProtectionGate", () => {
  function makeStore() {
    const store = new ConfigStore();
    store.declare("db.dsn", new ItemPolicy({ impact: ImpactLevel.HIGH }));
    store.declare("ui.theme", new ItemPolicy({ impact: ImpactLevel.LOW }));
    return store;
  }

  it("high-impact write without credential rejected, message has no identity", () => {
    const store = makeStore();
    assert.throws(
      () => store.set("db.dsn", "postgres://prod"),
      (e) => {
        const msg = e.message;
        return (
          e instanceof WriteProtectionError &&
          msg.includes("db.dsn") &&
          msg.includes("HIGH") &&
          !msg.toLowerCase().includes("human") &&
          !msg.toLowerCase().includes("agent")
        );
      },
    );
  });

  it("high-impact write with credential succeeds", () => {
    const store = makeStore();
    store.set("db.dsn", "postgres://prod", 1);
    assert.equal(store.get("db.dsn"), "postgres://prod");
  });

  it("low-impact write needs no credential", () => {
    const store = makeStore();
    store.set("ui.theme", "dark"); // no credential argument at all
    assert.equal(store.get("ui.theme"), "dark");
  });

  it("undeclared item defaults to low impact", () => {
    const store = new ConfigStore();
    store.set("anything.unlisted", 1); // no declare(), no credential
    assert.equal(store.get("anything.unlisted"), 1);
  });

  it("gate is identity-independent (no identity params, equal outcomes)", () => {
    // The authorize/set surface takes a credential *level* and no
    // principal: a "human" and an "agent" presenting the same level get
    // the exact same outcome. Asserted by behaviour and by the absence
    // of any identity parameter in the function source signatures.
    for (const fn of [authorizeWrite, ConfigStore.prototype.set]) {
      const sig = fn.toString().slice(0, fn.toString().indexOf(")") + 1);
      for (const forbidden of ["identity", "principal", "user", "agent"]) {
        assert.ok(
          !new RegExp(`\\b${forbidden}\\b`).test(sig),
          `${fn.name} signature must not take ${forbidden}: ${sig}`,
        );
      }
    }
    const a = makeStore();
    const b = makeStore();
    assert.throws(() => a.set("db.dsn", "x", 0), WriteProtectionError); // "the human"
    assert.throws(() => b.set("db.dsn", "x", 0), WriteProtectionError); // "the agent"
    a.set("db.dsn", "ok", 1);
    b.set("db.dsn", "ok", 1);
    assert.equal(a.get("db.dsn"), b.get("db.dsn"));
  });
});
