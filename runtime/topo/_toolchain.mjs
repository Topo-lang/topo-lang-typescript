/**
 * Locate the built Topo toolchain binaries.
 *
 * topo-app is a product layer that *consumes* the existing toolchain; it
 * never reimplements parsing or checking. Resolution order — the canonical
 * policy shared with the Python (_toolchain.py) and Java (Toolchain.java)
 * runtimes; keep the three locators in lockstep:
 *
 *   1. explicit env var (TOPO_BIN_DIR) — STRICT: when set, the binary must
 *      resolve under it (a build tree or straight at a bin directory) or
 *      the locator throws an actionable error listing the probed paths.
 *      No silent fall-through: the override is the CI/test pinning
 *      contract, and degrading to PATH would silently swap the binary
 *      under test.
 *   2. PATH lookup for the bare binary name — the layout `cmake --install`,
 *      Homebrew, and the per-package installs ship into, and the only
 *      resolution that works outside a source checkout
 *   3. known sibling build trees of this checkout, fixed order,
 *      first-hit-wins: `build/`, then `build-asan/`
 *
 * Windows portability (ported from _toolchain.py / Toolchain.java): every
 * probe transparently tries the `.exe` suffix and the multi-config
 * subdirectories (Release/, RelWithDebInfo/, Debug/) emitted by the Visual
 * Studio / Xcode generators, and "is this executable?" is decided by a
 * PATHEXT suffix match — Node's accessSync(X_OK) degrades to a bare
 * existence probe on Windows, where POSIX execute bits are not maintained.
 *
 * `build-no-llvm/` is deliberately NOT searched: that tree mis-resolves
 * this project's suites and causes spurious parse failures (a tracked
 * environmental issue). Only freshly built trees are trusted. A clear
 * error is raised if nothing yields the binary, because silently
 * degrading a correctness tool would defeat the point.
 */

import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const _HERE = dirname(fileURLToPath(import.meta.url));
// This file lives at topo-lang-typescript/runtime/topo/_toolchain.mjs;
// the repository root is three parents up.
const _REPO_ROOT = resolve(_HERE, "..", "..", "..");

// Fixed probe order, first hit wins. `build-no-llvm` is intentionally
// excluded — it is stale and mis-resolves, producing spurious failures.
const _BUILD_DIRS = ["build", "build-asan"];

const _IS_WINDOWS = process.platform === "win32";

// Per-build sub-config directories CMake's multi-config generators emit
// (Visual Studio, Xcode). Probed after the flat layout.
const _CONFIG_SUBDIRS = ["Release", "RelWithDebInfo", "Debug"];

/** Windows-runnable suffixes per PATHEXT; [""] on POSIX (no-op filter). */
function _pathext() {
  if (!_IS_WINDOWS) return [""];
  const raw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function _isExecutableFile(p) {
  let st;
  try {
    st = statSync(p);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (_IS_WINDOWS) {
    // accessSync(X_OK) behaves like a bare existence check on Windows, so
    // mirror _toolchain.py: a regular file with a PATHEXT-runnable suffix
    // is executable (the same rule cmd.exe applies).
    return _pathext().includes(extname(p).toLowerCase());
  }
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Suffixes a binary reference may carry on disk. */
function _suffixes() {
  return _IS_WINDOWS ? ["", ".exe"] : [""];
}

/**
 * All on-disk paths where the binary `rel` may live under `base`:
 * nested source-tree mirror, flat bin layout (TOPO_BIN_DIR may point
 * straight at a bin directory), and the multi-config subdir variants —
 * each with and without the `.exe` suffix.
 */
function _candidatePathsFor(base, rel) {
  const name = basename(rel);
  const parent = dirname(rel);
  const out = [];
  for (const sfx of _suffixes()) {
    // Nested layout (per-tool subdirectory, source-tree mirror).
    out.push(join(base, rel + sfx));
    // Flat bin layout (Homebrew / cmake --install / topo backend).
    out.push(join(base, name + sfx));
    // Multi-config layouts (Visual Studio / Xcode generators).
    for (const cfg of _CONFIG_SUBDIRS) {
      out.push(join(base, cfg, rel + sfx));
      out.push(join(base, cfg, name + sfx));
      if (parent !== ".") out.push(join(base, parent, cfg, name + sfx));
    }
  }
  return out;
}

function _resolveIn(base, rel) {
  for (const cand of _candidatePathsFor(base, rel)) {
    if (_isExecutableFile(cand)) return cand;
  }
  return null;
}

/**
 * Cross-platform `which`: walk PATH for the bare binary name, honouring
 * PATHEXT on Windows so a request for "topo" correctly finds "topo.exe".
 * Returns null if not found.
 */
function _findOnPath(bare) {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  const suffixes = _IS_WINDOWS ? ["", ..._pathext()] : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const sfx of suffixes) {
      const cand = join(dir, bare + sfx);
      if (_isExecutableFile(cand)) return cand;
    }
  }
  return null;
}

function _find(rel) {
  // 1. Explicit override — STRICT: when set, the binary resolves under it
  //    or this throws; falling through would silently swap the binary
  //    under test (see the header block).
  const env = process.env.TOPO_BIN_DIR;
  if (env) {
    const hit = _resolveIn(env, rel);
    if (hit) return hit;
    throw new Error(
      `TOPO_BIN_DIR is set ('${env}') but '${rel}' does not resolve ` +
        `under it. Probed:\n  ` +
        _candidatePathsFor(env, rel).join("\n  ") +
        `\nFix or unset TOPO_BIN_DIR — the override pins the binary and ` +
        `never falls through to PATH.`
    );
  }

  // 2. PATH probe — the installed-package layout.
  const onPath = _findOnPath(basename(rel));
  if (onPath) return onPath;

  // 3. Sibling build trees of this checkout (dev convenience).
  for (const b of _BUILD_DIRS) {
    const hit = _resolveIn(join(_REPO_ROOT, b), rel);
    if (hit) return hit;
  }

  throw new Error(
    `could not locate '${rel}'. Install the Topo toolchain (so it is on ` +
      `PATH), build it (cmake --build build --target topo topo-check), or ` +
      `set TOPO_BIN_DIR (must be a current build tree — build-no-llvm is ` +
      `excluded as stale).`
  );
}

export function topoBin() {
  return _find("topo-core/tools/topo/topo");
}

export function topoCheckBin() {
  return _find("topo-cli/tools/topo-check/topo-check");
}
