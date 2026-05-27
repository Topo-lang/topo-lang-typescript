// Unit tests for TypeScriptImportExtractor (L1 regex).
//
// Covers ES module imports, CommonJS require, type-only imports, side-effect
// imports, and re-exports.  Each test writes a temp .ts file and asserts the
// HostImport records the extractor produces.

#include "TypeScriptImportExtractor.h"

#include <gtest/gtest.h>
#include <filesystem>
#include <fstream>
#include <string>

#ifdef _WIN32
#include <process.h>
static int topo_getpid() { return _getpid(); }
#else
#include <unistd.h>
static int topo_getpid() { return getpid(); }
#endif

namespace fs = std::filesystem;
using namespace topo::check;

class TypeScriptImportExtractorTest : public ::testing::Test {
protected:
    fs::path tempDir_;

    void SetUp() override {
        tempDir_ = fs::temp_directory_path() /
            ("topo_ts_import_test_" + std::to_string(topo_getpid()) +
             "_" + std::to_string(reinterpret_cast<uintptr_t>(this)));
        fs::create_directories(tempDir_);
    }

    void TearDown() override {
        std::error_code ec;
        fs::remove_all(tempDir_, ec);
    }

    std::vector<HostImport> extract(const std::string& content) {
        auto path = tempDir_ / "src.ts";
        { std::ofstream ofs(path); ofs << content; }
        TypeScriptImportExtractor extractor;
        return extractor.extractImports(path.string());
    }

    static const HostImport* findPath(const std::vector<HostImport>& imports,
                                      const std::string& path) {
        for (const auto& i : imports) if (i.normalizedPath == path) return &i;
        return nullptr;
    }
};

TEST_F(TypeScriptImportExtractorTest, DefaultImport) {
    auto imports = extract("import foo from \"./foo\";\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].normalizedPath, "./foo");
}

TEST_F(TypeScriptImportExtractorTest, NamedImport) {
    auto imports = extract("import { A, B } from \"./mod\";\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].normalizedPath, "./mod");
}

TEST_F(TypeScriptImportExtractorTest, AliasedNamedImport) {
    auto imports = extract("import { A as X, B as Y } from \"./mod\";\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].normalizedPath, "./mod");
}

TEST_F(TypeScriptImportExtractorTest, StarImport) {
    auto imports = extract("import * as ns from \"./mod\";\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].normalizedPath, "./mod");
}

TEST_F(TypeScriptImportExtractorTest, TypeOnlyImport) {
    auto imports = extract("import type { T } from \"./types\";\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].normalizedPath, "./types");
}

TEST_F(TypeScriptImportExtractorTest, SideEffectImport) {
    auto imports = extract("import \"./polyfill\";\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].normalizedPath, "./polyfill");
}

TEST_F(TypeScriptImportExtractorTest, CommonJsRequire) {
    auto imports = extract("const fs = require(\"fs\");\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].normalizedPath, "fs");
    EXPECT_EQ(imports[0].unsafeLevel, UnsafeLevel::System);
}

TEST_F(TypeScriptImportExtractorTest, CommonJsRequireDestructured) {
    auto imports = extract("const { exec } = require(\"child_process\");\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].normalizedPath, "child_process");
    EXPECT_EQ(imports[0].unsafeLevel, UnsafeLevel::Escape);
}

TEST_F(TypeScriptImportExtractorTest, ReexportNamed) {
    auto imports = extract("export { A } from \"./mod\";\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].normalizedPath, "./mod");
}

TEST_F(TypeScriptImportExtractorTest, ReexportStar) {
    auto imports = extract("export * from \"./mod\";\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].normalizedPath, "./mod");
}

TEST_F(TypeScriptImportExtractorTest, NodeBuiltinsClassified) {
    auto imports = extract(
        "import * as fs from \"fs\";\n"
        "import * as net from \"net\";\n"
        "import * as cp from \"child_process\";\n");
    ASSERT_EQ(imports.size(), 3u);
    EXPECT_EQ(findPath(imports, "fs")->unsafeLevel, UnsafeLevel::System);
    EXPECT_EQ(findPath(imports, "net")->unsafeLevel, UnsafeLevel::System);
    EXPECT_EQ(findPath(imports, "child_process")->unsafeLevel,
              UnsafeLevel::Escape);
}

TEST_F(TypeScriptImportExtractorTest, SafePathIsSafe) {
    auto imports = extract("import { x } from \"./utils\";\n");
    ASSERT_EQ(imports.size(), 1u);
    EXPECT_EQ(imports[0].unsafeLevel, UnsafeLevel::Safe);
}

TEST_F(TypeScriptImportExtractorTest, IgnoresCommentedImport) {
    // The import is inside a block comment; should NOT be detected.
    auto imports = extract("/* import { A } from \"./mod\"; */\n");
    EXPECT_TRUE(imports.empty());
}
