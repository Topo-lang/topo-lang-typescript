// E2E tests for TypeScript containment checks.
//
// Each fixture exercises the TypeScriptCallSiteExtractor + ContainmentCheck
// pipeline.  `[containment] mode = "force"` upgrades any detected escape to
// an error, so these tests produce deterministic pass/fail outcomes.

#include "CheckRunner.h"
#include "TsServerBridge.h"

#include <gtest/gtest.h>
#include <string>

using namespace topo;

static std::string fixtureDir(const char* name) {
    return std::string(TOPO_TEST_FIXTURES_DIR) + "/" + name;
}

TEST(TypeScriptContainment, ExternalOk) {
    // A function declared `external` may call `fetch`, `eval`, etc.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("containment_external_ok");
    cfg.checkName = "containment";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptContainment, EvalInNonExternal) {
    // Non-external function calls eval — violation.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("containment_eval");
    cfg.checkName = "containment";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 1);
}

TEST(TypeScriptContainment, NewFunctionInNonExternal) {
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("containment_new_function");
    cfg.checkName = "containment";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 1);
}

TEST(TypeScriptContainment, ExternalClassMethodOk) {
    // A class method declared `external` in .topo (host emits callerQN
    // `Renderer.render`) must be recognised as external via the simple-name
    // fallback. Requires LanguageAnalysisProvider::separator() == "." so
    // ContainmentCheck splits the qualifiedName on the language-native
    // separator (regression for issue
    // containment-check-separator-hardcoded-double-colon).
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("containment_external_class_method_ok");
    cfg.checkName = "containment";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptContainment, SafeCodePasses) {
    // Pure computation with no escape mechanisms.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("containment_safe");
    cfg.checkName = "containment";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

// --- L2 deep containment (TsServerBridge / TypeScriptSafetyAnalyzer) ---
//
// These run the same fixtures with `deepMode = true`, exercising the
// tsserver-backed L2 path end-to-end. When tsserver returns semantic
// tokens, its result is authoritative (no L1 fallback), so a regression
// in the L2 analyzer is observable here.
//
// Skip semantics mirror CppContainmentL2: tsserver missing on the host is
// an environment blocker handled by one suite-level GTEST_SKIP in SetUp(),
// never a per-case skip.
class TypeScriptContainmentL2 : public ::testing::Test {
protected:
    void SetUp() override {
        if (!topo::lsp::TsServerBridge::isTsServerAvailable()) {
            GTEST_SKIP() << "typescript-language-server unavailable on PATH — "
                            "L2 deep containment tests need it to run.";
        }
    }
};

TEST_F(TypeScriptContainmentL2, EvalDeepDetected) {
    // L2 must resolve `eval` (hover is markdown-fenced) and report it.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("containment_eval");
    cfg.checkName = "containment";
    cfg.deepMode = true;
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 1);
}

TEST_F(TypeScriptContainmentL2, NewFunctionDeepDetected) {
    // `new Function(...)` — tsserver types the `Function` token as `class`;
    // L2 must still classify it as an escape.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("containment_new_function");
    cfg.checkName = "containment";
    cfg.deepMode = true;
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 1);
}

TEST_F(TypeScriptContainmentL2, SafeCodeDeepPasses) {
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("containment_safe");
    cfg.checkName = "containment";
    cfg.deepMode = true;
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST_F(TypeScriptContainmentL2, ExternalOkDeepPasses) {
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("containment_external_ok");
    cfg.checkName = "containment";
    cfg.deepMode = true;
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST_F(TypeScriptContainmentL2, ExternalClassMethodOkDeepPasses) {
    // Regression: L2 must pass the TypeScript `.` separator to
    // checkContainment so the external class-method caller `Renderer.render`
    // is recognised. Omitting it defaults to "::" and L2 false-positives.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("containment_external_class_method_ok");
    cfg.checkName = "containment";
    cfg.deepMode = true;
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}
