// E2E tests for TypeScript stage-isolation checks.
//
// Exercises the TypeScriptCallEdgeExtractor + StageIsolationCheck pipeline.
// [stage_isolation] mode = "force" makes any forward-stage call an error.

#include "CheckRunner.h"

#include <gtest/gtest.h>
#include <string>

using namespace topo;

static std::string fixtureDir(const char* name) {
    return std::string(TOPO_TEST_FIXTURES_DIR) + "/" + name;
}

TEST(TypeScriptStageIsolation, Pass01_NoCrossStageCalls) {
    // `init` (stage<1>) and `process` (stage<2>) never call each other
    // at the host level — the call graph respects the declared stage order.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("stage_isolation_typescript_pass_01");
    cfg.checkName = "stage-isolation";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptStageIsolation, Fail01_ForwardStageCall) {
    // `init` (stage<1>) calls `process` (stage<2>) — forward-stage violation.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("stage_isolation_typescript_fail_01");
    cfg.checkName = "stage-isolation";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 1);
}
