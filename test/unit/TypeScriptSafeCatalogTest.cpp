// Unit tests for TypeScriptSafePatterns + TypeScriptUnsafeCatalog.
//
// Covers construct / stdlib whitelist behaviour (prefix match included) and
// the unsafe-level classification pipeline that L2 uses to decide what to
// report.  These tests run without any LSP server running -- they exercise
// pure data-lookup logic.

#include "catalog/TypeScriptSafePatterns.h"
#include "catalog/TypeScriptUnsafeCatalog.h"

#include <gtest/gtest.h>

using namespace topo::check;

class TypeScriptSafeCatalogTest : public ::testing::Test {
protected:
    TypeScriptSafePatterns patterns_;

    void SetUp() override {
        ASSERT_TRUE(patterns_.loadDefault())
            << "TypeScriptSafePatterns.toml failed to load from default path";
    }
};

// --- Constructs ---------------------------------------------------------

TEST_F(TypeScriptSafeCatalogTest, Constructs_KeywordsAreSafe) {
    EXPECT_TRUE(patterns_.isConstructSafe("if"));
    EXPECT_TRUE(patterns_.isConstructSafe("for"));
    EXPECT_TRUE(patterns_.isConstructSafe("return"));
    EXPECT_TRUE(patterns_.isConstructSafe("readonly"));
    EXPECT_TRUE(patterns_.isConstructSafe("namespace"));
}

TEST_F(TypeScriptSafeCatalogTest, Constructs_EvalAndFunctionAreUnsafe) {
    EXPECT_TRUE(patterns_.isConstructUnsafe("eval"));
    EXPECT_TRUE(patterns_.isConstructUnsafe("Function"));
    EXPECT_FALSE(patterns_.isConstructUnsafe("class"));
}

// --- Stdlib whitelist + prefix match -----------------------------------

TEST_F(TypeScriptSafeCatalogTest, Stdlib_ESGlobalsAreSafe) {
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("Array"));
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("Object"));
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("Math"));
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("JSON"));
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("Promise"));
}

TEST_F(TypeScriptSafeCatalogTest, Stdlib_MembersOfSafeTypesAreSafeViaPrefix) {
    // "Array" is whitelisted; "Array.push", "Array.isArray", "Array.prototype.map"
    // all succeed via prefix match.
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("Array.push"));
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("Array.isArray"));
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("Array.prototype.map"));
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("Math.sqrt"));
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("JSON.parse"));
}

TEST_F(TypeScriptSafeCatalogTest, Stdlib_NodeSystemModulesAreNotSafe) {
    // fs / child_process / vm / net intentionally excluded from the whitelist.
    EXPECT_FALSE(patterns_.isStdlibSymbolSafe("fs.readFileSync"));
    EXPECT_FALSE(patterns_.isStdlibSymbolSafe("child_process.exec"));
    EXPECT_FALSE(patterns_.isStdlibSymbolSafe("vm.runInNewContext"));
    EXPECT_FALSE(patterns_.isStdlibSymbolSafe("net.createServer"));
}

TEST_F(TypeScriptSafeCatalogTest, Stdlib_PurePathAndUtilAreSafe) {
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("path"));
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("path.join"));
    EXPECT_TRUE(patterns_.isStdlibSymbolSafe("util.inspect"));
}

// --- UnsafeCatalog::classifyCall ---------------------------------------

TEST(TypeScriptUnsafeCatalog, ClassifyCall_EscapeMechanisms) {
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("eval"), UnsafeLevel::Escape);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("Function"), UnsafeLevel::Escape);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("__dynamic_import__"), UnsafeLevel::Escape);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("require"), UnsafeLevel::Escape);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("child_process.exec"), UnsafeLevel::Escape);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("vm.runInNewContext"), UnsafeLevel::Escape);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("Reflect.get"), UnsafeLevel::Escape);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("Atomics.wait"), UnsafeLevel::Escape);
}

TEST(TypeScriptUnsafeCatalog, ClassifyCall_SystemCalls) {
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("fetch"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("XMLHttpRequest"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("WebSocket"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("fs.readFileSync"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("fs.promises.readFile"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("net.createServer"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("process.exit"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("console.log"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("document.getElementById"), UnsafeLevel::System);
}

TEST(TypeScriptUnsafeCatalog, ClassifyCall_UserInput) {
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("alert"), UnsafeLevel::Input);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("prompt"), UnsafeLevel::Input);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("confirm"), UnsafeLevel::Input);
}

TEST(TypeScriptUnsafeCatalog, ClassifyCall_BareSafeReturnsSafe) {
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("parseInt"), UnsafeLevel::Safe);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("myUserFunction"), UnsafeLevel::Safe);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyCall("Array.from"), UnsafeLevel::Safe);
}

// --- UnsafeCatalog::classifyImport -------------------------------------

TEST(TypeScriptUnsafeCatalog, ClassifyImport_SystemModules) {
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("fs"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("fs/promises"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("http"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("net"), UnsafeLevel::System);
    // node:-prefix is normalized.
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("node:fs"), UnsafeLevel::System);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("node:process"), UnsafeLevel::System);
}

TEST(TypeScriptUnsafeCatalog, ClassifyImport_EscapeModules) {
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("child_process"), UnsafeLevel::Escape);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("vm"), UnsafeLevel::Escape);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("node:child_process"), UnsafeLevel::Escape);
}

TEST(TypeScriptUnsafeCatalog, ClassifyImport_PureModulesAreSafe) {
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("path"), UnsafeLevel::Safe);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("util"), UnsafeLevel::Safe);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("events"), UnsafeLevel::Safe);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("timers/promises"), UnsafeLevel::Safe);
}

TEST(TypeScriptUnsafeCatalog, ClassifyImport_ProjectRelativeIsSafe) {
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("./utils"), UnsafeLevel::Safe);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("../lib/helpers"), UnsafeLevel::Safe);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("/absolute/path"), UnsafeLevel::Safe);
}

TEST(TypeScriptUnsafeCatalog, ClassifyImport_UnknownPackageIsDep) {
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("lodash"), UnsafeLevel::Dep);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("@myorg/internal-lib"), UnsafeLevel::Dep);
    EXPECT_EQ(TypeScriptUnsafeCatalog::classifyImport("some-third-party"), UnsafeLevel::Dep);
}
