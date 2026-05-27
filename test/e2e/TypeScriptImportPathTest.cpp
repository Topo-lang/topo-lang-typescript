// E2E tests for TypeScript import-path checks.
//
// Verifies that std::import() paths in .topo resolve to existing files
// under the configured include directories.

#include "CheckRunner.h"

#include <gtest/gtest.h>
#include <string>

using namespace topo;

static std::string fixtureDir(const char* name) {
    return std::string(TOPO_TEST_FIXTURES_DIR) + "/" + name;
}

TEST(TypeScriptImportPath, PassFixture) {
    // std::import("helpers.ts", ...) resolves to src/helpers.ts under
    // include = ["src"].
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("import_path_typescript_pass");
    cfg.checkName = "import-path";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 0);
}

TEST(TypeScriptImportPath, FailFixture) {
    // std::import("nonexistent_module_xyz.ts", ...) — file does not exist.
    CheckConfig cfg;
    cfg.projectDir = fixtureDir("import_path_typescript_fail");
    cfg.checkName = "import-path";
    CheckRunner runner(cfg);
    ASSERT_TRUE(runner.loadConfig());
    EXPECT_EQ(runner.run(), 1);
}
