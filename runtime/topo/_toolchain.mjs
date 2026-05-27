/**
 * Locate the built Topo toolchain binaries.
 *
 * topo-app is a product layer that *consumes* the existing toolchain; it
 * never reimplements parsing or checking. Resolution order:
 *
 *   1. explicit env var (TOPO_BIN_DIR) — used by tests and CI
 *   2. the project `build/` tree of this checkout
 *
 * `build-no-llvm/` is deliberately NOT searched: that tree mis-resolves
 * this project's suites and causes spurious parse failures (a tracked
 * environmental issue). Only the freshly built `build/` binaries are
 * trusted. A clear error is raised if neither yields the binary, because
 * silently degrading a correctness tool would defeat the point.
 */

import { accessSync, constants, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const _HERE = dirname(fileURLToPath(import.meta.url));
// This file lives at topo-lang-typescript/runtime/topo/_toolchain.mjs;
// the repository root is three parents up.
const _REPO_ROOT = resolve(_HERE, "..", "..", "..");

// Only the LLVM-enabled `build/` tree. `build-no-llvm` is intentionally
// excluded — it is stale and mis-resolves, producing spurious failures.
const _BUILD_DIRS = ["build"];

function _candidateDirs() {
  const dirs = [];
  const env = process.env.TOPO_BIN_DIR;
  if (env) dirs.push(env);
  for (const b of _BUILD_DIRS) dirs.push(join(_REPO_ROOT, b));
  return dirs;
}

function _isExecutableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function _find(rel) {
  for (const base of _candidateDirs()) {
    const cand = join(base, rel);
    if (_isExecutableFile(cand)) return cand;
    // TOPO_BIN_DIR may point straight at a bin directory.
    const flat = join(base, rel.split("/").pop());
    if (_isExecutableFile(flat)) return flat;
  }
  throw new Error(
    `could not locate '${rel}'. Build the toolchain ` +
      `(cmake --build build --target topo topo-check) or set ` +
      `TOPO_BIN_DIR (must be the LLVM-enabled build, not build-no-llvm).`
  );
}

export function topoBin() {
  return _find("topo-core/tools/topo/topo");
}

export function topoCheckBin() {
  return _find("topo-cli/tools/topo-check/topo-check");
}
