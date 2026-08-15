/**
 * Unit tests for _toolchain.mjs binary resolution — no real toolchain
 * needed: fake `topo` binaries are staged in temp dirs and resolved via
 * each tier (TOPO_BIN_DIR flat + nested + multi-config subdir, then
 * PATH), plus the strict-override raise (TOPO_BIN_DIR set but
 * unresolvable must throw, never fall through to PATH). This is the
 * suite that proves the Windows story (`.exe` suffix + PATHEXT
 * executability stand-in for the POSIX execute bit) on the windows-2022
 * lane, where the python/java siblings' probing has long been covered
 * but the mjs port previously had no automated surface on any OS.
 *
 * Runs identically on POSIX (suffix "" + chmod +x) so the tiers stay
 * pinned everywhere.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { topoBin } from "../topo/_toolchain.mjs";

const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";

function stageFakeTopo(dir, rel) {
  const p = join(dir, rel + EXE);
  mkdirSync(join(p, ".."), { recursive: true });
  // Content is irrelevant — resolution stats the file; PATHEXT suffix
  // (Windows) or the execute bit (POSIX) is what marks it runnable.
  writeFileSync(p, IS_WINDOWS ? "MZ" : "#!/bin/sh\nexit 0\n");
  if (!IS_WINDOWS) chmodSync(p, 0o755);
  return p;
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("TOPO_BIN_DIR flat layout resolves (env tier)", () => {
  const dir = mkdtempSync(join(tmpdir(), "topo-mjs-flat-"));
  try {
    const staged = stageFakeTopo(dir, "topo");
    const hit = withEnv({ TOPO_BIN_DIR: dir, PATH: "" }, () => topoBin());
    assert.equal(hit, staged);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TOPO_BIN_DIR nested source-mirror layout resolves", () => {
  const dir = mkdtempSync(join(tmpdir(), "topo-mjs-nested-"));
  try {
    const staged = stageFakeTopo(dir, join("topo-core", "tools", "topo", "topo"));
    const hit = withEnv({ TOPO_BIN_DIR: dir, PATH: "" }, () => topoBin());
    assert.equal(hit, staged);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TOPO_BIN_DIR multi-config subdir (Release/) resolves", () => {
  const dir = mkdtempSync(join(tmpdir(), "topo-mjs-cfg-"));
  try {
    const staged = stageFakeTopo(dir, join("Release", "topo"));
    const hit = withEnv({ TOPO_BIN_DIR: dir, PATH: "" }, () => topoBin());
    assert.equal(hit, staged);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PATH tier resolves the bare name (installed layout)", () => {
  const dir = mkdtempSync(join(tmpdir(), "topo-mjs-path-"));
  try {
    const staged = stageFakeTopo(dir, "topo");
    const hit = withEnv(
      { TOPO_BIN_DIR: undefined, PATH: dir + delimiter + (process.env.PATH || "") },
      () => topoBin(),
    );
    assert.equal(hit, staged);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strict TOPO_BIN_DIR: unresolvable override throws, never falls through to PATH", () => {
  const empty = mkdtempSync(join(tmpdir(), "topo-mjs-strict-"));
  const dir = mkdtempSync(join(tmpdir(), "topo-mjs-onpath-"));
  try {
    // A resolvable PATH must NOT rescue a set-but-unresolvable override:
    // the override is the CI/test pinning contract, and falling through
    // would silently swap the binary under test.
    stageFakeTopo(dir, "topo");
    assert.throws(
      () =>
        withEnv(
          { TOPO_BIN_DIR: empty, PATH: dir + delimiter + (process.env.PATH || "") },
          () => topoBin(),
        ),
      /TOPO_BIN_DIR/,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

if (IS_WINDOWS) {
  test("windows: a non-PATHEXT file is not treated as runnable", () => {
    const dir = mkdtempSync(join(tmpdir(), "topo-mjs-noext-"));
    try {
      // Bare extensionless file: a regular file but not PATHEXT-runnable,
      // so the env tier must NOT return it (and with no other tier
      // available the resolver throws its actionable error).
      writeFileSync(join(dir, "topo"), "not runnable");
      assert.throws(() =>
        withEnv({ TOPO_BIN_DIR: dir, PATH: "" }, () => topoBin()),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
