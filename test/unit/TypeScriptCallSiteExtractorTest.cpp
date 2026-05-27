// Unit tests for TypeScriptCallSiteExtractor (L1 regex).
//
// Covers dangerous-call detection: eval, new Function, dynamic import(),
// require(), child_process.*, fs.*, fetch, new XMLHttpRequest / WebSocket.
// Asserts calleePattern, unsafeLevel, and the caller-scope attribution.

#include "TypeScriptCallSiteExtractor.h"

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

class TypeScriptCallSiteExtractorTest : public ::testing::Test {
protected:
    fs::path tempDir_;

    void SetUp() override {
        tempDir_ = fs::temp_directory_path() /
            ("topo_ts_call_test_" + std::to_string(topo_getpid()) +
             "_" + std::to_string(reinterpret_cast<uintptr_t>(this)));
        fs::create_directories(tempDir_);
    }

    void TearDown() override {
        std::error_code ec;
        fs::remove_all(tempDir_, ec);
    }

    std::vector<DetectedCallSite> extract(const std::string& content) {
        auto path = tempDir_ / "src.ts";
        { std::ofstream ofs(path); ofs << content; }
        TypeScriptCallSiteExtractor extractor;
        return extractor.extractCallSites(path.string());
    }

    static const DetectedCallSite* findPattern(
        const std::vector<DetectedCallSite>& calls, const std::string& pat) {
        for (const auto& c : calls) if (c.calleePattern == pat) return &c;
        return nullptr;
    }
};

TEST_F(TypeScriptCallSiteExtractorTest, Eval_FlaggedAsEscape) {
    std::string src =
        "export function run() {\n"
        "    eval(\"x + 1\");\n"
        "}\n";
    auto calls = extract(src);
    const auto* c = findPattern(calls, "eval");
    ASSERT_NE(c, nullptr);
    EXPECT_EQ(c->unsafeLevel, UnsafeLevel::Escape);
    EXPECT_EQ(c->callerQualifiedName, "run");
}

TEST_F(TypeScriptCallSiteExtractorTest, NewFunction_FlaggedAsEscape) {
    std::string src =
        "export function make() {\n"
        "    const f = new Function(\"return 1\");\n"
        "    return f;\n"
        "}\n";
    auto calls = extract(src);
    const auto* c = findPattern(calls, "Function");
    ASSERT_NE(c, nullptr);
    EXPECT_EQ(c->unsafeLevel, UnsafeLevel::Escape);
}

TEST_F(TypeScriptCallSiteExtractorTest, DynamicImport_Synthetic) {
    std::string src =
        "export async function load() {\n"
        "    const m = await import(\"./plugin\");\n"
        "    return m;\n"
        "}\n";
    auto calls = extract(src);
    const auto* c = findPattern(calls, "__dynamic_import__");
    ASSERT_NE(c, nullptr);
    EXPECT_EQ(c->unsafeLevel, UnsafeLevel::Escape);
    EXPECT_EQ(c->callerQualifiedName, "load");
}

TEST_F(TypeScriptCallSiteExtractorTest, BareRequire_InFunctionBody) {
    std::string src =
        "export function late() {\n"
        "    const m = require(\"some-module\");\n"
        "    return m;\n"
        "}\n";
    auto calls = extract(src);
    // `require` is flagged as Escape regardless of form.
    const auto* c = findPattern(calls, "require");
    ASSERT_NE(c, nullptr);
    EXPECT_EQ(c->unsafeLevel, UnsafeLevel::Escape);
}

TEST_F(TypeScriptCallSiteExtractorTest, ChildProcessExec_Escape) {
    std::string src =
        "import * as cp from \"child_process\";\n"
        "export function runShell() {\n"
        "    child_process.exec(\"ls\");\n"
        "}\n";
    auto calls = extract(src);
    // Pattern captures `child_process.exec`; calleePattern derived from match.
    bool found = false;
    for (const auto& c : calls) {
        if (c.calleePattern.find("child_process.exec") != std::string::npos) {
            EXPECT_EQ(c.unsafeLevel, UnsafeLevel::Escape);
            found = true;
        }
    }
    EXPECT_TRUE(found) << "child_process.exec not detected";
}

TEST_F(TypeScriptCallSiteExtractorTest, FsReadFileSync_System) {
    std::string src =
        "import * as fs from \"fs\";\n"
        "export function read() {\n"
        "    return fs.readFileSync(\"/etc/hosts\");\n"
        "}\n";
    auto calls = extract(src);
    bool found = false;
    for (const auto& c : calls) {
        if (c.calleePattern.find("fs.readFileSync") != std::string::npos) {
            EXPECT_EQ(c.unsafeLevel, UnsafeLevel::System);
            found = true;
        }
    }
    EXPECT_TRUE(found) << "fs.readFileSync not detected";
}

TEST_F(TypeScriptCallSiteExtractorTest, Fetch_FlaggedAsSystem) {
    std::string src =
        "export async function getRemote() {\n"
        "    const r = await fetch(\"https://example.com\");\n"
        "    return r;\n"
        "}\n";
    auto calls = extract(src);
    const auto* c = findPattern(calls, "fetch");
    ASSERT_NE(c, nullptr);
    EXPECT_EQ(c->unsafeLevel, UnsafeLevel::System);
}

TEST_F(TypeScriptCallSiteExtractorTest, NewXMLHttpRequest_System) {
    std::string src =
        "export function reach() {\n"
        "    const x = new XMLHttpRequest();\n"
        "    return x;\n"
        "}\n";
    auto calls = extract(src);
    const auto* c = findPattern(calls, "XMLHttpRequest");
    ASSERT_NE(c, nullptr);
    EXPECT_EQ(c->unsafeLevel, UnsafeLevel::System);
}

TEST_F(TypeScriptCallSiteExtractorTest, ModuleScopeCaller) {
    // Eval at module scope; caller should be `<module>`.
    std::string src = "eval(\"1\");\n";
    auto calls = extract(src);
    const auto* c = findPattern(calls, "eval");
    ASSERT_NE(c, nullptr);
    EXPECT_EQ(c->callerQualifiedName, "<module>");
}

TEST_F(TypeScriptCallSiteExtractorTest, ClassMethodCaller) {
    std::string src =
        "export class Runner {\n"
        "    execute() {\n"
        "        eval(\"1\");\n"
        "    }\n"
        "}\n";
    auto calls = extract(src);
    const auto* c = findPattern(calls, "eval");
    ASSERT_NE(c, nullptr);
    // Caller attribution: `Class.method`.
    EXPECT_EQ(c->callerQualifiedName, "Runner.execute");
}

TEST_F(TypeScriptCallSiteExtractorTest, ClassMethodCaller_WithReturnTypeAnnotation) {
    // Regression: L1 method-shorthand regex must tolerate `: ReturnType` between
    // `)` and `{`. Without that, the method scope is never entered and the call
    // attributes to `<module>` instead of `Class.method`.
    std::string src =
        "export class Renderer {\n"
        "    render(id: number): number {\n"
        "        eval(\"1 + 1\");\n"
        "        return id * 2;\n"
        "    }\n"
        "}\n";
    auto calls = extract(src);
    const auto* c = findPattern(calls, "eval");
    ASSERT_NE(c, nullptr);
    EXPECT_EQ(c->callerQualifiedName, "Renderer.render");
}

TEST_F(TypeScriptCallSiteExtractorTest, ClassMethodCaller_WithModifierAndReturnType) {
    // public/private/static/async + return-type combination — regex must still match.
    std::string src =
        "export class Service {\n"
        "    public static async fetchUser(id: string): Promise<User> {\n"
        "        eval(\"x\");\n"
        "        return null as any;\n"
        "    }\n"
        "}\n";
    auto calls = extract(src);
    const auto* c = findPattern(calls, "eval");
    ASSERT_NE(c, nullptr);
    EXPECT_EQ(c->callerQualifiedName, "Service.fetchUser");
}

TEST_F(TypeScriptCallSiteExtractorTest, SafeCode_NoDetections) {
    std::string src =
        "export function add(a: number, b: number) {\n"
        "    return a + b;\n"
        "}\n";
    auto calls = extract(src);
    EXPECT_TRUE(calls.empty());
}
