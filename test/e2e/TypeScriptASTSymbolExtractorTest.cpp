// E2E tests for TypeScriptASTSymbolExtractor.
//
// These exercise the real path: the extractor spawns the staged
// `topo-extract-typescript` Node subprocess (the real `typescript` compiler
// AST) and parses its JSON reply — no hand-built SymbolTable. The suite
// SetUp() prepends the staged tool directory to PATH (so the bare-name spawn
// resolves) and skips cleanly when the tool is genuinely unavailable, the
// same environment-blocker pattern CppContainmentL2 uses for clangd.

#include "extract/TypeScriptASTSymbolExtractor.h"

#include <gtest/gtest.h>

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#ifndef TOPO_EXTRACT_TS_TOOL_DIR
#define TOPO_EXTRACT_TS_TOOL_DIR ""
#endif

namespace fs = std::filesystem;
using namespace topo::check;
using topo::Visibility;

// Fixture for the AST-based symbol extractor.
//
// Skip semantics: when topo-extract-typescript cannot be resolved+started
// (Node missing, tool not staged), SetUp() emits a single suite-level
// GTEST_SKIP. Environment-only blockers belong here, not inside each case.
// In a normal build (node + the staged tool present) the suite runs.
class TypeScriptASTSymbolExtractorE2E : public ::testing::Test {
protected:
    fs::path tempDir_;

    static void prependToolDirToPath() {
        const std::string toolDir = TOPO_EXTRACT_TS_TOOL_DIR;
        if (toolDir.empty()) return;
        fs::path launcher = fs::path(toolDir) / "topo-extract-typescript";
        if (!fs::exists(launcher)) return;
        const char* oldPath = std::getenv("PATH");
        std::string newPath = toolDir + ":" + (oldPath ? oldPath : "");
        setenv("PATH", newPath.c_str(), 1);
    }

    void SetUp() override {
        prependToolDirToPath();
        if (!TypeScriptASTSymbolExtractor::isAvailable()) {
            GTEST_SKIP() << "topo-extract-typescript unavailable (node missing "
                            "or the tool was not staged) — the AST symbol "
                            "extractor needs it to run.";
        }
        tempDir_ = fs::temp_directory_path() /
                   ("topo_ts_ast_sym_" +
                    std::to_string(reinterpret_cast<uintptr_t>(this)));
        fs::create_directories(tempDir_);
    }

    void TearDown() override {
        std::error_code ec;
        fs::remove_all(tempDir_, ec);
    }

    std::string writeFile(const std::string& name, const std::string& content) {
        auto path = tempDir_ / name;
        std::ofstream ofs(path);
        ofs << content;
        ofs.close();
        return path.string();
    }

    static const HostSymbol* find(const std::vector<HostSymbol>& syms,
                                  const std::string& qualified) {
        for (const auto& s : syms) {
            if (s.qualifiedName == qualified) return &s;
        }
        return nullptr;
    }

    static std::vector<std::string> qnames(const std::vector<HostSymbol>& syms) {
        std::vector<std::string> out;
        for (const auto& s : syms) out.push_back(s.qualifiedName);
        std::sort(out.begin(), out.end());
        return out;
    }
};

TEST_F(TypeScriptASTSymbolExtractorE2E, ExportedFunctionAndClassMembers) {
    std::string file = writeFile("a.ts",
        "export function topLevel(x: number): number { return x; }\n"
        "export class Renderer {\n"
        "  constructor() {}\n"
        "  render(): void {}\n"
        "  private helper(): void {}\n"
        "  static make(): Renderer { return new Renderer(); }\n"
        "}\n"
        "function notExported(): void {}\n");

    TypeScriptASTSymbolExtractor extractor;
    auto syms = extractor.extractSymbols(file);

    EXPECT_EQ(qnames(syms),
              (std::vector<std::string>{
                  "Renderer", "Renderer.constructor", "Renderer.helper",
                  "Renderer.make", "Renderer.render", "topLevel"}));

    const HostSymbol* topLevel = find(syms, "topLevel");
    ASSERT_NE(topLevel, nullptr);
    EXPECT_EQ(topLevel->kind, HostSymbolKind::Function);
    EXPECT_EQ(topLevel->hostVisibility, Visibility::Public);

    const HostSymbol* renderer = find(syms, "Renderer");
    ASSERT_NE(renderer, nullptr);
    EXPECT_EQ(renderer->kind, HostSymbolKind::Class);

    const HostSymbol* helper = find(syms, "Renderer.helper");
    ASSERT_NE(helper, nullptr);
    EXPECT_EQ(helper->kind, HostSymbolKind::Method);
    EXPECT_EQ(helper->enclosingClass, "Renderer");
    EXPECT_EQ(helper->hostVisibility, Visibility::Private);
    EXPECT_FALSE(helper->isStatic);

    const HostSymbol* make = find(syms, "Renderer.make");
    ASSERT_NE(make, nullptr);
    EXPECT_TRUE(make->isStatic);

    const HostSymbol* ctor = find(syms, "Renderer.constructor");
    ASSERT_NE(ctor, nullptr);
    EXPECT_EQ(ctor->kind, HostSymbolKind::Constructor);
    EXPECT_EQ(ctor->simpleName, "constructor");
}

TEST_F(TypeScriptASTSymbolExtractorE2E, ExportRenamingEmitsAliasedNames) {
    std::string file = writeFile("rename.ts",
        "function _impl(x: number): number { return x * 2; }\n"
        "function _helper(y: number): number { return y + 1; }\n"
        "export { _impl as publicApi, _helper as otherApi };\n");

    TypeScriptASTSymbolExtractor extractor;
    auto syms = extractor.extractSymbols(file);

    // The aliased (exported) names, never the internal `_impl` / `_helper`.
    EXPECT_EQ(qnames(syms),
              (std::vector<std::string>{"otherApi", "publicApi"}));
    for (const auto& s : syms) {
        EXPECT_EQ(s.kind, HostSymbolKind::Function);
    }
}

TEST_F(TypeScriptASTSymbolExtractorE2E, ReexportStarEmitsNothing) {
    std::string file = writeFile("index.ts", "export * from \"./helpers\";\n");
    TypeScriptASTSymbolExtractor extractor;
    EXPECT_TRUE(extractor.extractSymbols(file).empty());
}

TEST_F(TypeScriptASTSymbolExtractorE2E, NestedNamespacePrefixesInnerSymbols) {
    std::string file = writeFile("ns.ts",
        "export namespace Outer {\n"
        "  export namespace Inner {\n"
        "    export function compute(x: number): number { return x * 3; }\n"
        "  }\n"
        "}\n");
    TypeScriptASTSymbolExtractor extractor;
    auto syms = extractor.extractSymbols(file);
    ASSERT_EQ(syms.size(), 1u);
    EXPECT_EQ(syms[0].qualifiedName, "Outer.Inner.compute");
    EXPECT_EQ(syms[0].simpleName, "compute");
}

TEST_F(TypeScriptASTSymbolExtractorE2E, CommonJsExportsAreExtracted) {
    std::string named = writeFile("cjs.ts",
        "function aImpl() {}\nfunction bImpl() {}\n"
        "module.exports.a = aImpl;\n"
        "exports.b = bImpl;\n");
    TypeScriptASTSymbolExtractor extractor;
    EXPECT_EQ(qnames(extractor.extractSymbols(named)),
              (std::vector<std::string>{"a", "b"}));

    std::string bulk = writeFile("cjs_bulk.ts",
        "function aImpl() {}\nfunction bImpl() {}\n"
        "module.exports = { a: aImpl, bImpl };\n");
    EXPECT_EQ(qnames(extractor.extractSymbols(bulk)),
              (std::vector<std::string>{"a", "bImpl"}));
}

TEST_F(TypeScriptASTSymbolExtractorE2E, AmbientDeclarationsAreSkipped) {
    std::string file = writeFile("ambient.ts",
        "declare function legacyFunction(id: number): string;\n"
        "declare class LegacyShape { width: number; }\n"
        "declare module \"vendor\" {\n"
        "  export function vendorConnect(url: string): boolean;\n"
        "}\n"
        "export function realFunction(x: number): number { return x; }\n");
    TypeScriptASTSymbolExtractor extractor;
    auto syms = extractor.extractSymbols(file);
    ASSERT_EQ(syms.size(), 1u);
    EXPECT_EQ(syms[0].qualifiedName, "realFunction");
}

TEST_F(TypeScriptASTSymbolExtractorE2E, InterfaceAndTypeAliasMapToDistinctKinds) {
    std::string file = writeFile("types.ts",
        "export interface Shape { area(): number; }\n"
        "export type Id = number;\n");
    TypeScriptASTSymbolExtractor extractor;
    auto syms = extractor.extractSymbols(file);
    ASSERT_EQ(syms.size(), 2u);
    const HostSymbol* shape = find(syms, "Shape");
    ASSERT_NE(shape, nullptr);
    EXPECT_EQ(shape->kind, HostSymbolKind::Interface);
    const HostSymbol* id = find(syms, "Id");
    ASSERT_NE(id, nullptr);
    EXPECT_EQ(id->kind, HostSymbolKind::TypeAlias);
}

TEST_F(TypeScriptASTSymbolExtractorE2E, ExportedVariablesEmitVariableKind) {
    std::string file = writeFile("vars.ts",
        "export const PI = 3.14;\n"
        "export let counter = 0;\n");
    TypeScriptASTSymbolExtractor extractor;
    auto syms = extractor.extractSymbols(file);
    ASSERT_EQ(syms.size(), 2u);
    for (const auto& s : syms) {
        EXPECT_EQ(s.kind, HostSymbolKind::Variable);
    }
}

TEST_F(TypeScriptASTSymbolExtractorE2E, IsAvailableProbeSucceedsWhenStaged) {
    // The fixture SetUp() already gated on this, but assert it explicitly so
    // a regression in the probe surfaces as a clear failure rather than a
    // silent skip of the whole suite.
    EXPECT_TRUE(TypeScriptASTSymbolExtractor::isAvailable());
}
