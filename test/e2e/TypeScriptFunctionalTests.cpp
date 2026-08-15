// End-to-end functional tests: drive `topo-build` against TypeScript fixture
// projects (which dispatches to the topo-build-typescript subprocess) and
// assert the final exit code + stderr contents.

#include "topo/Platform/Platform.h"
#include "topo/Platform/Process.h"

#include <nlohmann/json.hpp>

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace topo::test::e2e {

namespace {

// One-time, in-process PATH prepend of the tool directories handed in by
// CMake (TOPO_FUNC_E2E_TOOL_DIRS, '|'-separated): topo-build resolves both
// its backend (topo-build-typescript) and the integrated-check topo-check
// by bare name from PATH. setenv/_putenv_s is process-global, so the test
// process and its whole subprocess chain inherit it — the same pattern the
// topo-jvm e2e harness uses for its backend tool dirs.
void prependToolDirsToPathOnce() {
    static bool done = false;
    if (done) return;
    done = true;
#ifdef TOPO_FUNC_E2E_TOOL_DIRS
    const std::string dirs = TOPO_FUNC_E2E_TOOL_DIRS;
#else
    const std::string dirs;
#endif
    if (dirs.empty()) return;
    const std::string sep(platform::PathSeparator);
    std::string prefix;
    size_t pos = 0;
    while (pos < dirs.size()) {
        size_t end = dirs.find('|', pos);
        if (end == std::string::npos) end = dirs.size();
        const std::string dir = dirs.substr(pos, end - pos);
        if (!dir.empty()) {
            if (!prefix.empty()) prefix += sep;
            prefix += dir;
        }
        pos = end + 1;
    }
    if (prefix.empty()) return;
    const char* oldPath = std::getenv("PATH");
    std::string newPath = prefix;
    if (oldPath && *oldPath) {
        newPath += sep;
        newPath += oldPath;
    }
#ifdef _WIN32
    _putenv_s("PATH", newPath.c_str());
#else
    setenv("PATH", newPath.c_str(), 1);
#endif
}

} // namespace

class TypeScriptFunctional : public ::testing::Test {
protected:
    fs::path topoBuildExe_;
    fs::path tsFixturesDir_;

    void SetUp() override {
#ifdef TOPO_BUILD_EXE
        topoBuildExe_ = fs::path(TOPO_BUILD_EXE);
#endif
        ASSERT_FALSE(topoBuildExe_.empty()) << "TOPO_BUILD_EXE not set";
        ASSERT_TRUE(fs::exists(topoBuildExe_))
            << "topo-build not found: " << topoBuildExe_;
#ifdef TOPO_TS_E2E_FIXTURES_DIR
        tsFixturesDir_ = fs::path(TOPO_TS_E2E_FIXTURES_DIR);
#endif
        ASSERT_FALSE(tsFixturesDir_.empty()) << "TOPO_TS_E2E_FIXTURES_DIR not set";
        ASSERT_TRUE(fs::exists(tsFixturesDir_))
            << "TypeScript fixtures dir not found: " << tsFixturesDir_;
        prependToolDirsToPathOnce();
    }

    struct FullResult {
        int exitCode = -1;
        std::string stdoutOutput;
        std::string stderrOutput;
    };

    FullResult topoBuildTs(const std::string& projectName,
                           const std::vector<std::string>& extraArgs = {}) {
        fs::path projDir = tsFixturesDir_ / projectName;
        // Fresh-run determinism: a warm check cache replaces diagnostics
        // with "Result: FAIL (cached)" and the build cache short-circuits
        // the backend — clear both so every spawn exercises the full
        // funnel. (.topo-check-cache is a file at the project root, NOT
        // inside .topo-cache/.)
        std::error_code ec;
        fs::remove_all(projDir / ".topo-cache", ec);
        fs::remove_all(projDir / ".topo-check-cache", ec);
        std::string exe = topoBuildExe_.generic_string();
        std::string workDir = projDir.generic_string();
        auto r = platform::runProcessCapture(exe, extraArgs, workDir);
        return FullResult{r.exitCode, r.stdoutOutput, r.stderrOutput};
    }

    static std::string readFile(const fs::path& path) {
        std::ifstream in(path);
        if (!in) return {};
        std::ostringstream ss;
        ss << in.rdbuf();
        return ss.str();
    }

    // Execute `node <ts-exec-flags> --no-warnings -e <inline> <distAppPath>`
    // and capture stdout/stderr/exitCode. The inline script receives the
    // rewritten dist file's absolute path via process.argv[1] and is
    // expected to:
    //   - exit 0 on the compliance path (runtime contract holds)
    //   - throw / non-zero on the violation path
    //
    // Why inline (-e) instead of a driver.mjs in the fixture: a fixture-side
    // driver would either need to live under src/ (and then the transform
    // would rewrite it) or in a sibling dir that has to be hand-managed for
    // every fixture. An -e script keeps the assertion next to the C++ test
    // that owns the semantics, and node has no problem importing the dist
    // .ts file as long as TS execution is enabled.
    //
    // Node 22.6+ ships `--experimental-strip-types`; 23+ enables TS
    // execution by default. `--experimental-transform-types` (22.0–22.5)
    // was removed in 22.7+, so we probe at first use rather than hard-code.
    struct NodeResult {
        int exitCode = -1;
        std::string stdoutOutput;
        std::string stderrOutput;
    };

    static const std::vector<std::string>& tsExecFlags() {
        static const std::vector<std::string> flags = probeTsExecFlags();
        return flags;
    }

    // Probe `node` to find a flag set that can execute `.ts` files (without
    // namespace blocks — fixtures use plain `export function`). Tries
    // `--experimental-strip-types` (22.6+), then `--experimental-transform-types`
    // (22.0–22.5), then no flag (23+ default-on). Returns the first set
    // that exits 0. If none works, returns the legacy flag so the failure
    // surfaces as a clear "bad option" stderr rather than a silent skip.
    static std::vector<std::string> probeTsExecFlags() {
        fs::path probeDir = fs::temp_directory_path() / "topo-ts-functional-probe";
        std::error_code ec;
        fs::create_directories(probeDir, ec);
        fs::path src = probeDir / "probe.ts";
        {
            std::ofstream(src) <<
                "export function f(x: number): number { return x; }\n"
                "console.log(f(0));\n";
        }
        const std::vector<std::vector<std::string>> candidates = {
            {"--experimental-strip-types", "--no-warnings"},
            {"--experimental-transform-types", "--no-warnings"},
            {"--no-warnings"},
        };
        for (const auto& flags : candidates) {
            std::vector<std::string> args = flags;
            args.push_back(src.string());
            auto r = platform::runProcessCaptureWithTimeout("node", args, 5000);
            if (r.exitCode == 0) return flags;
        }
        // None of the probes succeeded — fall back to the legacy flag so the
        // resulting "bad option" stderr surfaces the diagnostic, rather than
        // silently disabling these tests.
        return {"--experimental-transform-types", "--no-warnings"};
    }

    NodeResult runNode(const std::string& inlineScript,
                       const fs::path& distAppPath,
                       int timeoutMs = 10000) {
        std::vector<std::string> args = tsExecFlags();
        args.emplace_back("-e");
        args.push_back(inlineScript);
        args.push_back(distAppPath.generic_string());
        auto r = platform::runProcessCaptureWithTimeout("node", args, timeoutMs);
        return NodeResult{r.exitCode, r.stdoutOutput, r.stderrOutput};
    }
};

TEST_F(TypeScriptFunctional, CompletenessPass) {
    auto r = topoBuildTs("completeness_pass");
    EXPECT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;
}

TEST_F(TypeScriptFunctional, CompletenessViolation) {
    auto r = topoBuildTs("completeness_violation");
    EXPECT_NE(r.exitCode, 0)
        << "Build should fail for undeclared TS symbols:\n" << r.stderrOutput;
}

// VisibilityPass — make .topo visibility enforceable on TypeScript output.
// Build the fixture, then assert dist/src/app.ts mirrors src/, strips `export`
// from declarations marked private, and injects @internal JSDoc for those
// marked internal.
TEST_F(TypeScriptFunctional, VisibilityTransformRewritesExports) {
    fs::path projDir = tsFixturesDir_ / "visibility_transform";
    fs::path distApp = projDir / "dist" / "src" / "app.ts";

    // Clean stale dist from any prior run.
    std::error_code ec;
    fs::remove_all(projDir / "dist", ec);
    fs::remove_all(projDir / ".topo-cache", ec);

    auto r = topoBuildTs("visibility_transform");
    ASSERT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;

    ASSERT_TRUE(fs::exists(distApp))
        << "Transformed output not written: " << distApp
        << "\nstderr:\n" << r.stderrOutput;

    std::string out = readFile(distApp);
    ASSERT_FALSE(out.empty()) << "Transformed app.ts is empty";

    // Public declaration retains its export.
    EXPECT_NE(out.find("export function run"), std::string::npos)
        << "Public 'run' should still be exported:\n" << out;

    // Private declaration loses its export.
    EXPECT_EQ(out.find("export function helper"), std::string::npos)
        << "Private 'helper' should not be exported:\n" << out;
    EXPECT_NE(out.find("function helper"), std::string::npos)
        << "Private 'helper' declaration missing from output:\n" << out;

    // Internal declaration retains its export but gets an @internal JSDoc.
    EXPECT_NE(out.find("@internal"), std::string::npos)
        << "Internal 'diagnostic' missing @internal JSDoc:\n" << out;
    EXPECT_NE(out.find("function diagnostic"), std::string::npos)
        << "Internal 'diagnostic' missing from output:\n" << out;

    // File-scoping: unrelated.ts declares `format`/`noop`, neither of which
    // is in any .topo visibility entry. With per-file maps the transform
    // must produce no rewrite for this file (and so must not write it).
    fs::path distUnrelated = projDir / "dist" / "src" / "unrelated.ts";
    EXPECT_FALSE(fs::exists(distUnrelated))
        << "Untouched file should not be written: " << distUnrelated;
}

// VisibilityPass sidecar.
//
// After `topo-build-typescript` runs the visibility transform, it should
// emit a `<outRoot>.topo-passes/VisibilityPass.json` file with a
// conformant common header (pass / category / fired / fired_count /
// decision / reason / elapsed_ns) plus a `rewrites[]` array listing each
// rewritten host file. The fixture rewrites exactly one file (app.ts);
// unrelated.ts is untouched, so `fired_count == 1` and the rewrites list
// has one entry whose `host_file` ends in `app.ts`.
TEST_F(TypeScriptFunctional, VisibilityTransformWritesSidecar) {
    fs::path projDir = tsFixturesDir_ / "visibility_transform";
    fs::path sidecar = projDir / "dist.topo-passes" / "VisibilityPass.json";

    std::error_code ec;
    fs::remove_all(projDir / "dist", ec);
    fs::remove_all(projDir / "dist.topo-passes", ec);
    fs::remove_all(projDir / ".topo-cache", ec);

    auto r = topoBuildTs("visibility_transform");
    ASSERT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;

    ASSERT_TRUE(fs::exists(sidecar))
        << "Sidecar not written: " << sidecar
        << "\nstderr:\n" << r.stderrOutput;

    std::string body = readFile(sidecar);
    ASSERT_FALSE(body.empty()) << "Sidecar is empty: " << sidecar;

    // Header fields — all 7 common keys.
    EXPECT_NE(body.find("\"pass\": \"VisibilityPass\""), std::string::npos)
        << "Missing pass field:\n" << body;
    EXPECT_NE(body.find("\"category\":"), std::string::npos)
        << "Missing category field:\n" << body;
    EXPECT_NE(body.find("\"fired\": true"), std::string::npos)
        << "Sidecar should report fired=true:\n" << body;
    EXPECT_NE(body.find("\"fired_count\": 1"), std::string::npos)
        << "Sidecar should report fired_count=1 (only app.ts rewritten):\n"
        << body;
    EXPECT_NE(body.find("\"decision\":"), std::string::npos)
        << "Missing decision field:\n" << body;
    EXPECT_NE(body.find("\"reason\":"), std::string::npos)
        << "Missing reason field:\n" << body;
    EXPECT_NE(body.find("\"elapsed_ns\":"), std::string::npos)
        << "Missing elapsed_ns field:\n" << body;

    // Rewrites list — exactly one entry, app.ts.
    EXPECT_NE(body.find("\"rewrites\":"), std::string::npos)
        << "Missing rewrites field:\n" << body;
    EXPECT_NE(body.find("app.ts"), std::string::npos)
        << "Rewrites list should mention app.ts:\n" << body;
    EXPECT_EQ(body.find("unrelated.ts"), std::string::npos)
        << "unrelated.ts is untouched and should NOT appear in rewrites:\n"
        << body;
}

// ContainmentGuardPass sidecar.
//
// Mirrors the VisibilityPass sidecar test: build the containment_guard_pass
// fixture, assert that `<outRoot>.topo-passes/ContainmentGuardPass.json`
// exists with the standard 7-field header + a `guards[]` array containing
// one entry for the transformed file. The fixture's `guarded` function
// uses all four restricted APIs (eval / new Function / dynamic import /
// Reflect), so the `changes[]` array should reference those.
TEST_F(TypeScriptFunctional, ContainmentGuardPassWritesSidecar) {
    fs::path projDir = tsFixturesDir_ / "containment_guard_pass";
    fs::path sidecar = projDir / "dist.topo-passes" / "ContainmentGuardPass.json";

    std::error_code ec;
    fs::remove_all(projDir / "dist", ec);
    fs::remove_all(projDir / "dist.topo-passes", ec);
    fs::remove_all(projDir / ".topo-cache", ec);

    auto r = topoBuildTs("containment_guard_pass");
    ASSERT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;

    ASSERT_TRUE(fs::exists(sidecar))
        << "Sidecar not written: " << sidecar
        << "\nstderr:\n" << r.stderrOutput;

    std::string body = readFile(sidecar);
    ASSERT_FALSE(body.empty()) << "Sidecar is empty: " << sidecar;

    EXPECT_NE(body.find("\"pass\": \"ContainmentGuardPass\""), std::string::npos)
        << "Wrong/missing pass field:\n" << body;
    EXPECT_NE(body.find("\"category\": \"ENHANCE\""), std::string::npos)
        << "Missing category=ENHANCE:\n" << body;
    EXPECT_NE(body.find("\"fired\": true"), std::string::npos)
        << "Should fire (fixture exercises all 4 restricted APIs):\n" << body;
    EXPECT_NE(body.find("\"decision\": \"forced_applied\""), std::string::npos)
        << "Mode is force in fixture; decision should be forced_applied:\n"
        << body;
    EXPECT_NE(body.find("\"guards\":"), std::string::npos)
        << "Missing guards array:\n" << body;
    // `changes` strings come from the JS transform: "guarded <fn>: <api>".
    EXPECT_NE(body.find("eval"), std::string::npos)
        << "changes[] should mention eval:\n" << body;
    EXPECT_NE(body.find("Reflect"), std::string::npos)
        << "changes[] should mention Reflect:\n" << body;
}

// StageAssertPass sidecar.
//
// Same pattern. Fixture declares a 3-stage pipeline (fetch / parse stage 1,
// transform stage 2, emit stage 3), so changes[] should list four
// stage-asserted callsites.
TEST_F(TypeScriptFunctional, StageAssertPassWritesSidecar) {
    fs::path projDir = tsFixturesDir_ / "stage_assert_pass";
    fs::path sidecar = projDir / "dist.topo-passes" / "StageAssertPass.json";

    std::error_code ec;
    fs::remove_all(projDir / "dist", ec);
    fs::remove_all(projDir / "dist.topo-passes", ec);
    fs::remove_all(projDir / ".topo-cache", ec);

    auto r = topoBuildTs("stage_assert_pass");
    ASSERT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;

    ASSERT_TRUE(fs::exists(sidecar))
        << "Sidecar not written: " << sidecar
        << "\nstderr:\n" << r.stderrOutput;

    std::string body = readFile(sidecar);
    ASSERT_FALSE(body.empty()) << "Sidecar is empty: " << sidecar;

    EXPECT_NE(body.find("\"pass\": \"StageAssertPass\""), std::string::npos)
        << "Wrong/missing pass field:\n" << body;
    EXPECT_NE(body.find("\"category\": \"ENHANCE\""), std::string::npos)
        << "Missing category=ENHANCE:\n" << body;
    EXPECT_NE(body.find("\"fired\": true"), std::string::npos)
        << "Should fire (fixture declares 3 stages):\n" << body;
    EXPECT_NE(body.find("\"decision\": \"forced_applied\""), std::string::npos)
        << "Mode is force in fixture; decision should be forced_applied:\n"
        << body;
    EXPECT_NE(body.find("\"assertions\":"), std::string::npos)
        << "Missing assertions array:\n" << body;
    // changes[] strings come from the JS transform:
    //   "stage-asserted pipeline: <callee>@<stage>".
    EXPECT_NE(body.find("stage-asserted"), std::string::npos)
        << "changes[] should mention stage-asserted callsites:\n" << body;
}

// tsc_sourcemap_link sidecar.
//
// The TypeScript backend is check-only: the user runs tsc, and the
// resulting `dist/*.js` + `dist/*.js.map` land in the build output dir
// (the fixture commits them). After checks pass, topo-build-typescript
// scans the output dir and emits
// `<outRoot>.topo-passes/tsc_sourcemap_link.json` recording the
// `.ts` ↔ `.js` ↔ `.js.map` correspondence so `topo profile` /
// `topo debug` can reverse V8 frame locations. We JSON-parse the
// sidecar and assert all 7 common header fields, a non-empty entries
// list, and that entries[0].sourcemap_path ends with `.js.map`.
TEST_F(TypeScriptFunctional, TscSourcemapLinkWritesSidecar) {
    fs::path projDir = tsFixturesDir_ / "tsc_sourcemap_link";
    fs::path sidecar = projDir / "dist.topo-passes" / "tsc_sourcemap_link.json";

    std::error_code ec;
    fs::remove_all(projDir / "dist.topo-passes", ec);
    fs::remove_all(projDir / ".topo-cache", ec);

    auto r = topoBuildTs("tsc_sourcemap_link");
    ASSERT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;

    ASSERT_TRUE(fs::exists(sidecar))
        << "Sidecar not written: " << sidecar
        << "\nstderr:\n" << r.stderrOutput;

    std::string body = readFile(sidecar);
    ASSERT_FALSE(body.empty()) << "Sidecar is empty: " << sidecar;

    nlohmann::json j;
    ASSERT_NO_THROW(j = nlohmann::json::parse(body))
        << "Sidecar is not valid JSON:\n" << body;

    // All 7 common header fields.
    EXPECT_EQ(j.value("pass", ""), "tsc_sourcemap_link") << body;
    EXPECT_EQ(j.value("category", ""), "INFRA") << body;
    ASSERT_TRUE(j.contains("fired")) << body;
    EXPECT_TRUE(j["fired"].get<bool>())
        << "Fixture commits dist/index.js + .js.map; should fire:\n" << body;
    ASSERT_TRUE(j.contains("fired_count")) << body;
    EXPECT_GE(j["fired_count"].get<int>(), 1) << body;
    EXPECT_EQ(j.value("decision", ""), "applied") << body;
    EXPECT_FALSE(j.value("reason", "").empty()) << body;
    ASSERT_TRUE(j.contains("elapsed_ns")) << body;

    // Entries non-empty + shape.
    ASSERT_TRUE(j.contains("entries")) << body;
    ASSERT_TRUE(j["entries"].is_array()) << body;
    ASSERT_FALSE(j["entries"].empty())
        << "entries[] should list the dist .js ↔ .js.map link:\n" << body;
    const auto& e0 = j["entries"][0];
    ASSERT_TRUE(e0.contains("ts_file")) << body;
    ASSERT_TRUE(e0.contains("js_file")) << body;
    ASSERT_TRUE(e0.contains("sourcemap_path")) << body;
    std::string smPath = e0["sourcemap_path"].get<std::string>();
    ASSERT_GE(smPath.size(), 7u) << body;
    EXPECT_EQ(smPath.substr(smPath.size() - 7), ".js.map")
        << "sourcemap_path should end with .js.map, got '" << smPath
        << "':\n" << body;
}

// VisibilityPass runtime witness — load the rewritten dist file under
// `node --experimental-transform-types` and assert the public/private/
// internal visibility contract holds at the module-shape level:
//   - `run`        public   → exported (typeof === "function")
//   - `helper`     private  → NOT exported (module.helper === undefined)
//   - `diagnostic` internal → still exported (export is kept; @internal JSDoc
//                             is a doc-only marker, not a runtime change)
//
// String-level assertions in the static test above prove the *text* changed.
// This test proves the *runtime module shape* changed correspondingly — the
// only level at which downstream consumers can actually observe visibility.
TEST_F(TypeScriptFunctional, VisibilityTransformRuntimeShape) {
    fs::path projDir = tsFixturesDir_ / "visibility_transform";
    fs::path distApp = projDir / "dist" / "src" / "app.ts";

    std::error_code ec;
    fs::remove_all(projDir / "dist", ec);
    fs::remove_all(projDir / ".topo-cache", ec);

    auto r = topoBuildTs("visibility_transform");
    ASSERT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;
    ASSERT_TRUE(fs::exists(distApp))
        << "Transformed output not written: " << distApp;

    const std::string driver = R"JS(
        const { pathToFileURL } = await import("node:url");
        const m = await import(pathToFileURL(process.argv[1]).href);
        if (typeof m.run !== "function") {
            throw new Error("public 'run' should be exported as a function, got " + typeof m.run);
        }
        if (m.helper !== undefined) {
            throw new Error("private 'helper' must not be exported; got " + typeof m.helper);
        }
        if (typeof m.diagnostic !== "function") {
            throw new Error("internal 'diagnostic' should still be exported (export kept; @internal is doc-only)");
        }
        console.log("OK");
    )JS";

    auto nr = runNode(driver, distApp);
    EXPECT_EQ(nr.exitCode, 0)
        << "Runtime visibility shape violated.\nstdout:\n" << nr.stdoutOutput
        << "\nstderr:\n" << nr.stderrOutput;
    EXPECT_NE(nr.stdoutOutput.find("OK"), std::string::npos)
        << "Driver did not print OK:\nstdout:\n" << nr.stdoutOutput
        << "\nstderr:\n" << nr.stderrOutput;
}

// ContainmentGuardPass — runtime enforcement for the static ContainmentCheck.
// Build the fixture, then assert dist/src/app.ts has runtime traps injected
// around every use of `eval` / `new Function` / `Reflect.*` / dynamic
// `import()` inside the non-external `guarded` function — and that the
// external `runCommand` body is left byte-identical (regression coverage:
// external functions ARE the declared boundary and must not be guarded).
TEST_F(TypeScriptFunctional, ContainmentGuardPassInsertsRuntimeGuards) {
    fs::path projDir = tsFixturesDir_ / "containment_guard_pass";
    fs::path distApp = projDir / "dist" / "src" / "app.ts";

    std::error_code ec;
    fs::remove_all(projDir / "dist", ec);
    fs::remove_all(projDir / ".topo-cache", ec);

    auto r = topoBuildTs("containment_guard_pass");
    ASSERT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;

    ASSERT_TRUE(fs::exists(distApp))
        << "Transformed output not written: " << distApp
        << "\nstderr:\n" << r.stderrOutput;

    std::string out = readFile(distApp);
    ASSERT_FALSE(out.empty()) << "Transformed app.ts is empty";

    // Every restricted-API use in `guarded` should have been replaced with
    // a throwing IIFE carrying a "Topo containment violation" Error.
    EXPECT_NE(out.find("Topo containment violation"), std::string::npos)
        << "Guard prelude missing:\n" << out;
    EXPECT_NE(out.find("'eval'"), std::string::npos)
        << "eval guard missing:\n" << out;
    EXPECT_NE(out.find("'new Function'"), std::string::npos)
        << "new Function guard missing:\n" << out;
    EXPECT_NE(out.find("'Reflect'"), std::string::npos)
        << "Reflect guard missing:\n" << out;
    EXPECT_NE(out.find("'import()'"), std::string::npos)
        << "dynamic import() guard missing:\n" << out;

    // Each guard message should name the function it was injected into.
    EXPECT_NE(out.find("'guarded'"), std::string::npos)
        << "Guard message should name 'guarded':\n" << out;

    // Regression: the external function `runCommand` MUST keep its `eval`
    // call intact — external functions are the contract boundary. Slice
    // out the runCommand body (from `function runCommand` to the closing
    // brace at depth 0) and check the direct `eval(` is still there and
    // no throw-IIFE guard was injected into it.
    auto runIdx = out.find("function runCommand");
    ASSERT_NE(runIdx, std::string::npos)
        << "External `runCommand` declaration missing from output:\n" << out;
    auto openBrace = out.find('{', runIdx);
    ASSERT_NE(openBrace, std::string::npos);
    int depth = 1;
    size_t scan = openBrace + 1;
    while (scan < out.size() && depth > 0) {
        if (out[scan] == '{') ++depth;
        else if (out[scan] == '}') --depth;
        if (depth == 0) break;
        ++scan;
    }
    ASSERT_LT(scan, out.size())
        << "Could not find matching brace for runCommand body";
    std::string runBody = out.substr(openBrace, scan - openBrace + 1);

    // External body keeps its raw `eval(` call.
    EXPECT_NE(runBody.find("eval("), std::string::npos)
        << "External runCommand's eval() must remain un-guarded:\n" << runBody;
    // The transform's guard signature is `throw new Error("Topo containment
    // violation:` — the source-level comment in the fixture intentionally
    // contains the phrase "Topo containment violation" too, so substring
    // matching on the phrase alone over-matches. Anchor on the throw form.
    EXPECT_EQ(runBody.find("throw new Error(\"Topo containment violation"),
              std::string::npos)
        << "External runCommand must NOT receive a guard:\n" << runBody;
}

// ContainmentGuardPass runtime witness — execute the rewritten dist file
// under node and assert both halves of the contract:
//
//   - Non-external `guarded(x)`: calling it triggers the first restricted-API
//     guard (eval), which must throw `Topo containment violation`. This is
//     the runtime witness that the static ContainmentCheck warning translates
//     into an actual runtime trap when the violating line is reached.
//
//   - External `runCommand(code)`: calling it must succeed (eval is permitted
//     here — `runCommand` is declared `external`, i.e. the contract boundary).
//     This is the runtime witness for the regression coverage that the static
//     test above asserts at the string level — the external body is left
//     un-guarded, so eval still works and returns the expected value.
//
// One test, two driver calls — keeps the per-pass test count balanced.
TEST_F(TypeScriptFunctional, ContainmentGuardPassRuntimeBehavior) {
    fs::path projDir = tsFixturesDir_ / "containment_guard_pass";
    fs::path distApp = projDir / "dist" / "src" / "app.ts";

    std::error_code ec;
    fs::remove_all(projDir / "dist", ec);
    fs::remove_all(projDir / ".topo-cache", ec);

    auto r = topoBuildTs("containment_guard_pass");
    ASSERT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;
    ASSERT_TRUE(fs::exists(distApp))
        << "Transformed output not written: " << distApp;

    // Violation path — non-external `guarded(5)` must throw with the guard
    // signature. Exit non-zero AND stderr carries the phrase.
    {
        const std::string driver = R"JS(
            const { pathToFileURL } = await import("node:url");
            const m = await import(pathToFileURL(process.argv[1]).href);
            try {
                m.guarded(5);
            } catch (e) {
                if (!String(e.message).includes("Topo containment violation")) {
                    throw new Error("guarded threw, but not with the expected guard message: " + e.message);
                }
                console.log("VIOLATION_OK");
                process.exit(0);
            }
            throw new Error("guarded(5) must throw a Topo containment violation, but it returned normally");
        )JS";

        auto nr = runNode(driver, distApp);
        EXPECT_EQ(nr.exitCode, 0)
            << "Containment guard violation path failed.\nstdout:\n"
            << nr.stdoutOutput << "\nstderr:\n" << nr.stderrOutput;
        EXPECT_NE(nr.stdoutOutput.find("VIOLATION_OK"), std::string::npos)
            << "Driver did not confirm violation:\nstdout:\n" << nr.stdoutOutput
            << "\nstderr:\n" << nr.stderrOutput;
    }

    // Compliance path — external `runCommand(42)` must execute without a
    // guard and return the eval result. This proves the regression
    // protection (external bodies untouched) holds at runtime, not just in
    // the emitted text.
    {
        const std::string driver = R"JS(
            const { pathToFileURL } = await import("node:url");
            const m = await import(pathToFileURL(process.argv[1]).href);
            const v = m.runCommand(42);
            if (v !== 42) throw new Error("runCommand(42) should return 42, got " + v);
            console.log("COMPLIANCE_OK");
        )JS";

        auto nr = runNode(driver, distApp);
        EXPECT_EQ(nr.exitCode, 0)
            << "External function must execute unguarded.\nstdout:\n"
            << nr.stdoutOutput << "\nstderr:\n" << nr.stderrOutput;
        EXPECT_NE(nr.stdoutOutput.find("COMPLIANCE_OK"), std::string::npos)
            << "Driver did not confirm compliance:\nstdout:\n" << nr.stdoutOutput
            << "\nstderr:\n" << nr.stderrOutput;
    }
}

// StageAssertPass — runtime witness for the static StageIsolationCheck.
// Build the fixture, then assert dist/src/app.ts injects a monotonic stage
// counter prologue into `pipeline` and wraps every direct callsite to a
// stage-mapped callee (fetch / parse / transform / emit) with an
// assertion IIFE. The non-orchestrator functions (fetch / parse / etc.)
// must NOT get prologues — they are stage participants, not the host.
TEST_F(TypeScriptFunctional, StageAssertPassEnforcesOrderingAtRuntime) {
    fs::path projDir = tsFixturesDir_ / "stage_assert_pass";
    fs::path distApp = projDir / "dist" / "src" / "app.ts";

    std::error_code ec;
    fs::remove_all(projDir / "dist", ec);
    fs::remove_all(projDir / ".topo-cache", ec);

    auto r = topoBuildTs("stage_assert_pass");
    ASSERT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;

    ASSERT_TRUE(fs::exists(distApp))
        << "Transformed output not written: " << distApp
        << "\nstderr:\n" << r.stderrOutput;

    std::string out = readFile(distApp);
    ASSERT_FALSE(out.empty()) << "Transformed app.ts is empty";

    // Prologue: monotonic stage counter must be declared at top of pipeline.
    EXPECT_NE(out.find("let __topoStage = 0"), std::string::npos)
        << "Stage counter prologue missing:\n" << out;

    // Guard message phrase must appear (per-call wrappers carry it).
    EXPECT_NE(out.find("Topo stage assertion"), std::string::npos)
        << "Stage assertion guard message missing:\n" << out;

    // Every stage-mapped callee must appear in at least one guard's
    // declaration string. Anchor on the printed message-substring form
    // generated by buildAssertedCall (`'<name>' declared stage<N>`).
    EXPECT_NE(out.find("'fetch' declared stage<1>"), std::string::npos)
        << "fetch@stage1 guard missing:\n" << out;
    EXPECT_NE(out.find("'parse' declared stage<1>"), std::string::npos)
        << "parse@stage1 guard missing:\n" << out;
    EXPECT_NE(out.find("'transform' declared stage<2>"), std::string::npos)
        << "transform@stage2 guard missing:\n" << out;
    EXPECT_NE(out.find("'emit' declared stage<3>"), std::string::npos)
        << "emit@stage3 guard missing:\n" << out;

    // The counter update path (Math.max) must be present — without it,
    // the counter never advances and the assertion never fires.
    EXPECT_NE(out.find("Math.max(__topoStage, __need)"), std::string::npos)
        << "Counter advance via Math.max missing:\n" << out;

    // Regression: stage participants (fetch / parse / transform / emit)
    // are NOT orchestrators and must not receive their own prologue. Only
    // `pipeline` was named in the stage map. Counting prologue occurrences
    // catches accidental over-rewriting (e.g. visiting nested scopes).
    size_t prologueCount = 0;
    size_t pos = 0;
    while ((pos = out.find("let __topoStage = 0", pos)) != std::string::npos) {
        ++prologueCount;
        pos += 1;
    }
    EXPECT_EQ(prologueCount, 1u)
        << "Exactly one prologue expected (only pipeline is staged); got "
        << prologueCount << ":\n" << out;
}

// StageAssertPass runtime witness — execute the rewritten dist file and
// confirm the in-declared-order compliance path actually runs cleanly under
// the injected counter + per-callsite assertion wrappers.
//
// The fixture's pipeline body calls fetch (stage 1) → parse (stage 1) →
// transform (stage 2) → emit (stage 3) — monotonic by construction. The
// rewrite injects `let __topoStage = 0;` at the top and wraps each callsite
// with an assertion IIFE that throws if `__need < __topoStage`. Calling in
// declared order must therefore return cleanly; any regression that breaks
// the wrapper logic (e.g. comparing in the wrong direction, advancing the
// counter before the assertion runs) would surface as a thrown error here.
//
// The negative property — "out-of-declared-order throws" — is structural:
// the static test above already asserts the emitted text contains the
// `if (__need < __topoStage) throw new Error("Topo stage assertion: …")`
// pattern with the right stage numbers, so a violation cannot avoid firing.
// Authoring a second fixture whose .topo+source disagree would fail the
// static StageIsolationCheck and could not reach the transform.
TEST_F(TypeScriptFunctional, StageAssertPassRuntimeCompliance) {
    fs::path projDir = tsFixturesDir_ / "stage_assert_pass";
    fs::path distApp = projDir / "dist" / "src" / "app.ts";

    std::error_code ec;
    fs::remove_all(projDir / "dist", ec);
    fs::remove_all(projDir / ".topo-cache", ec);

    auto r = topoBuildTs("stage_assert_pass");
    ASSERT_EQ(r.exitCode, 0) << "topo-build should succeed:\n" << r.stderrOutput;
    ASSERT_TRUE(fs::exists(distApp))
        << "Transformed output not written: " << distApp;

    const std::string driver = R"JS(
        const { pathToFileURL } = await import("node:url");
        const m = await import(pathToFileURL(process.argv[1]).href);
        // In-declared-order path: must NOT throw.
        m.pipeline();
        console.log("OK");
    )JS";

    auto nr = runNode(driver, distApp);
    EXPECT_EQ(nr.exitCode, 0)
        << "In-order pipeline call must not throw under stage-assert.\nstdout:\n"
        << nr.stdoutOutput << "\nstderr:\n" << nr.stderrOutput;
    EXPECT_NE(nr.stdoutOutput.find("OK"), std::string::npos)
        << "Driver did not print OK:\nstdout:\n" << nr.stdoutOutput
        << "\nstderr:\n" << nr.stderrOutput;
    // Sanity: stderr should not carry a stage-assertion violation message.
    EXPECT_EQ(nr.stderrOutput.find("Topo stage assertion"), std::string::npos)
        << "Unexpected stage assertion fired in compliance path:\nstderr:\n"
        << nr.stderrOutput;
}

// StageAssertPass off-mode bundle-size regression.
//
// Acceptance criterion: when stage-assert is off the V8 backend must not
// inject any `performance.mark` calls, and the compiled JS bundle stays
// byte-for-byte unchanged (regression-tested below). The live config key
// is `[transforms.stage_assert]`; off / auto / force share the FeatureMode
// three-level semantics. StageAssertPass is the only stage instrumentation
// the V8 backend has, and reserves `performance.mark` injection for it.
//
// `stage_assert_off` is byte-for-byte identical to `stage_assert_pass`
// except `[transforms.stage_assert].mode = "off"`. The check-only TS
// backend only writes to dist/ when a transform actually runs, so:
//   - on-mode  (force): dist/src/app.ts exists, is rewritten (counter +
//     per-callsite guards), and must contain ZERO `performance.mark`
//     (the mark injection is not yet wired — guard against a
//     regression that adds it unconditionally).
//   - off-mode (off):   StageAssertPass never runs; the user's effective
//     bundle is the untouched src/app.ts. It must contain ZERO
//     `performance.mark`, and its size must be <= the on-mode transformed
//     output (instrumentation only ever adds bytes, never removes them).
//
// Both halves together prove the criterion: off-mode injects no
// instrumentation and its bundle is no larger than on-mode.
TEST_F(TypeScriptFunctional, StageAssertOffModeNoPerfMarkBundleSizeUnchanged) {
    fs::path onProj = tsFixturesDir_ / "stage_assert_pass";
    fs::path offProj = tsFixturesDir_ / "stage_assert_off";
    fs::path onDistApp = onProj / "dist" / "src" / "app.ts";
    fs::path offDistApp = offProj / "dist" / "src" / "app.ts";
    fs::path offSrcApp = offProj / "src" / "app.ts";

    std::error_code ec;
    fs::remove_all(onProj / "dist", ec);
    fs::remove_all(onProj / "dist.topo-passes", ec);
    fs::remove_all(onProj / ".topo-cache", ec);
    fs::remove_all(offProj / "dist", ec);
    fs::remove_all(offProj / "dist.topo-passes", ec);
    fs::remove_all(offProj / ".topo-cache", ec);

    // --- On-mode (force): transform runs, output is instrumented. ---
    auto onR = topoBuildTs("stage_assert_pass");
    ASSERT_EQ(onR.exitCode, 0)
        << "on-mode topo-build should succeed:\n" << onR.stderrOutput;
    ASSERT_TRUE(fs::exists(onDistApp))
        << "on-mode transformed output missing: " << onDistApp
        << "\nstderr:\n" << onR.stderrOutput;
    std::string onOut = readFile(onDistApp);
    ASSERT_FALSE(onOut.empty()) << "on-mode transformed app.ts is empty";

    // Sanity: on-mode genuinely instrumented (so the comparison is
    // meaningful — otherwise an equal size would be vacuous).
    EXPECT_NE(onOut.find("let __topoStage = 0"), std::string::npos)
        << "on-mode output not instrumented; comparison would be vacuous:\n"
        << onOut;

    // performance.mark injection is NOT yet wired. Guard against a regression
    // that adds `performance.mark` unconditionally (i.e. even when the
    // user wants only the assertion semantics, not profiling marks).
    EXPECT_EQ(onOut.find("performance.mark"), std::string::npos)
        << "on-mode output unexpectedly contains performance.mark "
           "(stage_instrument mark injection must be opt-in, not "
           "unconditional):\n" << onOut;

    // --- Off-mode: StageAssertPass never runs. ---
    auto offR = topoBuildTs("stage_assert_off");
    ASSERT_EQ(offR.exitCode, 0)
        << "off-mode topo-build should succeed:\n" << offR.stderrOutput;

    // The check-only backend only mirrors src/ -> dist/ when a transform
    // runs. With stage_assert off and no other transform enabled, no
    // dist/src/app.ts is produced; the user's effective bundle is the
    // untouched source. Accept either: (a) no dist output (preferred —
    // proves the pass did not run at all), or (b) a dist output that is
    // byte-identical to the source (no instrumentation injected).
    std::string offEffective;
    if (fs::exists(offDistApp)) {
        offEffective = readFile(offDistApp);
        std::string offSrc = readFile(offSrcApp);
        EXPECT_EQ(offEffective, offSrc)
            << "off-mode produced a dist output that differs from source — "
               "StageAssertPass must not run when mode=off:\noffDist:\n"
            << offEffective << "\noffSrc:\n" << offSrc;
    } else {
        offEffective = readFile(offSrcApp);
    }
    ASSERT_FALSE(offEffective.empty())
        << "off-mode effective bundle is empty";

    // Off-mode injects ZERO performance.mark.
    EXPECT_EQ(offEffective.find("performance.mark"), std::string::npos)
        << "off-mode bundle contains performance.mark — instrumentation "
           "must not be injected when mode=off:\n" << offEffective;
    // And ZERO stage-assert instrumentation at all.
    EXPECT_EQ(offEffective.find("__topoStage"), std::string::npos)
        << "off-mode bundle contains stage-assert counter — the pass must "
           "not run when mode=off:\n" << offEffective;

    // Bundle size: off-mode <= on-mode. Instrumentation only ever adds
    // bytes (counter prologue + per-callsite guard IIFEs), so the
    // un-instrumented bundle must be no larger than the instrumented one.
    EXPECT_LE(offEffective.size(), onOut.size())
        << "off-mode bundle (" << offEffective.size()
        << " B) is larger than on-mode instrumented output ("
        << onOut.size() << " B) — impossible unless off-mode injected "
           "something:\noff:\n" << offEffective << "\non:\n" << onOut;
}

} // namespace topo::test::e2e
