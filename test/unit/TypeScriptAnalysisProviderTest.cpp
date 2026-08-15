// Unit tests for TypeScriptAnalysisProvider::collectSourceFiles — source
// discovery over the fixed projectDir/src + projectDir search roots.
//
// Regression focus: a search root that is a plain FILE (e.g. a regular file
// named `src` in the project root) used to be fed to
// fs::recursive_directory_iterator, whose "Not a directory" filesystem_error
// aborted the whole checker (rc=134). Roots must degrade, not throw, and the
// node_modules pruning must survive the non-throwing rewrite.
//
// NOTE: this file calls only collectSourceFiles — never
// createSymbolExtractor. TypeScriptProviderFallbackNoticeTest must stay the
// single test in topo-lang-typescript-tests that calls createSymbolExtractor()
// with the extractor unavailable (its stderr notice fires once per process).

#include "TypeScriptAnalysisProvider.h"

#include <gtest/gtest.h>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using namespace topo::check;

#ifdef _WIN32
#include <process.h>
static int topo_getpid() {
    return _getpid();
}
#else
#include <unistd.h>
static int topo_getpid() {
    return getpid();
}
#endif

class TypeScriptAnalysisProviderTest : public ::testing::Test {
protected:
    void SetUp() override {
        projectDir_ = fs::temp_directory_path() /
            ("topo_ts_provider_test_" + std::to_string(topo_getpid()));
        fs::create_directories(projectDir_);
    }

    void TearDown() override {
        std::error_code ec;
        fs::remove_all(projectDir_, ec);
    }

    std::string writeFile(const fs::path& rel, const std::string& content) {
        auto path = projectDir_ / rel;
        std::error_code ec;
        fs::create_directories(path.parent_path(), ec);
        std::ofstream ofs(path);
        ofs << content;
        return path.string();
    }

    static int countOf(const std::vector<std::string>& files, const std::string& path) {
        return static_cast<int>(std::count(files.begin(), files.end(), path));
    }

    fs::path projectDir_;
};

TEST_F(TypeScriptAnalysisProviderTest, SrcEntryThatIsRegularFileDoesNotAbort) {
    // A regular file shadowing the conventional src/ directory: the fixed
    // search roots feed it to the scan verbatim, where it used to abort.
    writeFile("src", "not a directory\n");
    auto mainTs = writeFile("main.ts", "export function run(): void {}\n");

    auto provider = createTypeScriptAnalysisProvider();
    auto files = provider->collectSourceFiles(projectDir_.string(), {});

    EXPECT_EQ(countOf(files, mainTs), 1);
}

TEST_F(TypeScriptAnalysisProviderTest, NodeModulesStillSkipped) {
    // Guards the disable_recursion_pending() skip across the non-throwing
    // iterator rewrite.
    auto appTs = writeFile(fs::path("src") / "app.ts",
                           "export function run(): void {}\n");
    auto depTs = writeFile(fs::path("node_modules") / "dep" / "index.ts",
                           "export function dep(): void {}\n");

    auto provider = createTypeScriptAnalysisProvider();
    auto files = provider->collectSourceFiles(projectDir_.string(), {});

    EXPECT_EQ(countOf(files, appTs), 1);
    EXPECT_EQ(countOf(files, depTs), 0);
}

TEST_F(TypeScriptAnalysisProviderTest, MissingSrcDirDegradesToSkip) {
    // No src/ at all: the missing root is skipped silently and the
    // projectDir scan still discovers root-level sources.
    auto mainTs = writeFile("main.ts", "export function run(): void {}\n");

    auto provider = createTypeScriptAnalysisProvider();
    auto files = provider->collectSourceFiles(projectDir_.string(), {});

    EXPECT_EQ(countOf(files, mainTs), 1);
}
