/**
 * Zero-declaration check: hand the existing topo-check the emitted .topo.
 *
 * The third-scenario value is "用框架就自动拿到 topo check" — the user
 * writes no .topo by hand. We materialise a throwaway project (Topo.toml
 * + emitted .topo + the user's TypeScript sources), run the *existing*
 * topo-check binary against it, and surface the verdict. No checking
 * logic is reimplemented here; this is pure orchestration, the exact
 * counterpart of the Python `check.py`.
 *
 * The TS host's topo-check analyses `.ts` source (its TypeScript
 * AnalysisProvider), so the caller supplies the `.ts` files that define
 * the handler functions named in the emitted `.topo`. The framework
 * registration (`.mjs`) and the checked source (`.ts`) are separate
 * artefacts by design — registration declares the contract, the .ts is
 * what topo-check verifies the contract against, exactly as the Python
 * slice checks the user's `.py` source against the emitted `.topo`.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { emitTopo } from "./_emit.mjs";
import { topoCheckBin } from "./_toolchain.mjs";

// `purity.mode = force` so the parallel-stage purity rule is exercised
// (the violating-handler parity case depends on it). completeness
// ignores synthetic ctor/main the host analyser may surface, matching
// the Python slice's Topo.toml.
function _topoToml(name) {
  return (
    "[project]\n" +
    `name = "${name}"\n` +
    "\n" +
    "[topo]\n" +
    'root = "topo/app.topo"\n' +
    "\n" +
    "[build]\n" +
    'language = "typescript"\n' +
    'sources = ["src/*.ts"]\n' +
    "\n" +
    "[purity]\n" +
    'mode = "force"\n' +
    "\n" +
    "[completeness]\n" +
    "ignore_constructors = true\n" +
    "ignore_main = true\n"
  );
}

/**
 * @typedef {{passed: boolean, returncode: number,
 *            stdout: string, stderr: string}} CheckResult
 */

/**
 * Run topo-check on the framework-emitted .topo against the given
 * TypeScript source files. No hand-written .topo anywhere in the flow.
 *
 * @param {import("./app.mjs").App} app
 * @param {string[]} tsSources absolute/relative paths to `.ts` files
 * @returns {CheckResult}
 */
export function check(app, tsSources) {
  const name = app.graph.namespace || "topo_app";
  const root = mkdtempSync(join(tmpdir(), "topo-app-check-"));
  let proc;
  try {
    mkdirSync(join(root, "topo"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Topo.toml"), _topoToml(name), "utf-8");
    writeFileSync(
      join(root, "topo", "app.topo"),
      emitTopo(app.graph),
      "utf-8"
    );
    for (const srcfile of tsSources) {
      copyFileSync(srcfile, join(root, "src", basename(srcfile)));
    }
    proc = spawnSync(topoCheckBin(), ["--project", root], {
      encoding: "utf-8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // topo-check's textual verdict is the source of truth: exit codes are
  // not always non-zero on a logical FAIL, so match the printed line
  // (same stance as the Python slice).
  const stdout = proc.stdout || "";
  const passed = stdout.includes("Result: PASS");
  return {
    passed,
    returncode: proc.status,
    stdout,
    stderr: proc.stderr || "",
  };
}
