// E2E tests for TypeScript visibility checks.
//
// Exercises the private/internal visibility pipeline.  `[visibility] mode =
// "force"` makes any cross-scope private/internal call an error.

#include "CheckRunner.h"

#include <gtest/gtest.h>
#include <string>

using namespace topo;

static std::string fixtureDir(const char* name) {
    return std::string(TOPO_TEST_FIXTURES_DIR) + "/" + name;
}

TEST(TypeScriptVisibility, Pass_PublicToPublic) {
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("visibility_typescript_pass_01");
    cfg.checkName = "visibility";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptVisibility, Fail_CrossModulePrivate) {
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("visibility_typescript_fail_01");
    cfg.checkName = "visibility";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 1);
}

TEST(TypeScriptVisibility, Fail_CrossModulePrivate_AliasedDestructuredImport) {
    // `import { helper as h }` followed by a bare `h()` call must still
    // resolve back to `app::helper` so VisibilityCheck flags the cross-
    // namespace private call. Regression: aliased destructured imports
    // must resolve back to their declaring namespace.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("visibility_typescript_fail_02");
    cfg.checkName = "visibility";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 1);
}
