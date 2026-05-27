// E2E tests for TypeScript completeness checks.
//
// Drives CheckRunner against small TS fixture projects and asserts the
// overall pass/fail result.

#include "CheckRunner.h"

#include <gtest/gtest.h>
#include <string>

using namespace topo;

static std::string fixtureDir(const char* name) {
    return std::string(TOPO_TEST_FIXTURES_DIR) + "/" + name;
}

TEST(TypeScriptCompleteness, Pass) {
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("completeness_pass");
    cfg.checkName = "completeness";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptCompleteness, Fail) {
    // Source exports `bar` but .topo declares `foo` — undeclared symbol error.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("completeness_violation");
    cfg.checkName = "completeness";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 1);
}

TEST(TypeScriptCompleteness, DanglingDeclaration) {
    // .topo declares `foo` but the source file lacks it.
    // Dangling declarations are warnings, not errors; exit 0.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("dangling_declaration");
    cfg.checkName = "completeness";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptCompleteness, MixedEsmAndCommonJS) {
    // Host code mixes ESM (`export function`) and CommonJS
    // (`module.exports.X = ...`) across two files, with a third .d.ts
    // file carrying ambient stubs the extractor should ignore.
    // Exercises mixed ESM/CJS export completeness coverage.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("mixed_esm_cjs");
    cfg.checkName = "completeness";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

// --- TS-specific syntax coverage ---------

TEST(TypeScriptCompleteness, Syntax_ExportListRenaming) {
    // `export { _impl as publicApi }` renames internal bindings at the
    // module boundary; the extracted HostSymbol must use the exported
    // name, not the internal one, so the .topo declaration lines up.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("export_renaming");
    cfg.checkName = "completeness";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptCompleteness, Syntax_ReexportStar) {
    // `export * from "./helpers"` is a barrel re-export — it MUST NOT
    // produce a phantom HostSymbol, and the real implementation in the
    // re-exported file flows through unchanged.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("reexport_star");
    cfg.checkName = "completeness";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptCompleteness, Syntax_NestedNamespace) {
    // `export namespace Outer { export namespace Inner { ... } }` —
    // qualified name `Outer.Inner.compute` must resolve against the
    // .topo declaration `Outer::Inner::compute` via the simple-name
    // fallback.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("nested_namespace");
    cfg.checkName = "completeness";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptCompleteness, Syntax_DeclareModuleIgnored) {
    // `declare module "<name>" { ... }` in a .d.ts file is a pure type
    // stub; its contents must NOT appear as HostSymbols, otherwise the
    // completeness check would flag them as orphan implementations.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("declare_module_ignored");
    cfg.checkName = "completeness";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}
