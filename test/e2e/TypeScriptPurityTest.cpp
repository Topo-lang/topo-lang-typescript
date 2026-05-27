// E2E tests for TypeScript purity checks.
//
// Exercises the TypeScriptSymbolAccessExtractor + PurityCheck pipeline.
// [purity] mode = "force" makes any module-level mutable write inside a
// parallel stage function an error.

#include "CheckRunner.h"

#include <gtest/gtest.h>
#include <string>

using namespace topo;

static std::string fixtureDir(const char* name) {
    return std::string(TOPO_TEST_FIXTURES_DIR) + "/" + name;
}

TEST(TypeScriptPurity, Pass01_NoGlobalWrites) {
    // All parallel stage<1> functions only use local variables.
    // No module-level `let`/`var` is written.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("purity_typescript_pass_01");
    cfg.checkName = "purity";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptPurity, Fail01_ModuleMutableWrite) {
    // `compute` (stage<1>) writes to module-level `let counter` — violation.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("purity_typescript_fail_01");
    cfg.checkName = "purity";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 1);
}
