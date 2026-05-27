// Unit tests for TypeScriptSymbolExtractor.
//
// Each test writes a short .ts file to a temp directory, invokes the extractor
// directly, then asserts the returned HostSymbol vector.  Covers:
//   - export function / export default function / export async function
//   - export class + method visibility modifiers
//   - export interface / export type alias
//   - export const/let/var
//   - export { A, B as C } (list form)
//   - export * from ... (re-export — should NOT produce a symbol)
//   - export namespace N { export function f() {} } (qualified name)

#include "TypeScriptSymbolExtractor.h"

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

class TypeScriptSymbolExtractorTest : public ::testing::Test {
protected:
    fs::path tempDir_;

    void SetUp() override {
        tempDir_ = fs::temp_directory_path() /
            ("topo_ts_symbol_test_" + std::to_string(topo_getpid()) +
             "_" + std::to_string(reinterpret_cast<uintptr_t>(this)));
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

    std::vector<HostSymbol> extract(const std::string& content,
                                    const std::string& name = "test.ts") {
        auto path = writeFile(name, content);
        TypeScriptSymbolExtractor extractor;
        return extractor.extractSymbols(path);
    }

    static const HostSymbol* find(const std::vector<HostSymbol>& syms,
                                  const std::string& simpleName) {
        for (const auto& s : syms) if (s.simpleName == simpleName) return &s;
        return nullptr;
    }
};

TEST_F(TypeScriptSymbolExtractorTest, ExportFunction) {
    auto syms = extract("export function foo() { return 1; }\n");
    ASSERT_EQ(syms.size(), 1u);
    EXPECT_EQ(syms[0].simpleName, "foo");
    EXPECT_EQ(syms[0].qualifiedName, "foo");
    EXPECT_EQ(syms[0].kind, HostSymbolKind::Function);
    ASSERT_TRUE(syms[0].hostVisibility.has_value());
    EXPECT_EQ(*syms[0].hostVisibility, topo::Visibility::Public);
}

TEST_F(TypeScriptSymbolExtractorTest, ExportDefaultFunction) {
    auto syms = extract("export default function main() { }\n");
    ASSERT_EQ(syms.size(), 1u);
    EXPECT_EQ(syms[0].simpleName, "main");
    EXPECT_EQ(syms[0].kind, HostSymbolKind::Function);
}

TEST_F(TypeScriptSymbolExtractorTest, ExportAsyncFunction) {
    auto syms = extract("export async function loadData() { return []; }\n");
    ASSERT_EQ(syms.size(), 1u);
    EXPECT_EQ(syms[0].simpleName, "loadData");
    EXPECT_EQ(syms[0].kind, HostSymbolKind::Function);
}

TEST_F(TypeScriptSymbolExtractorTest, ExportClassWithMethods) {
    std::string src =
        "export class Foo {\n"
        "    bar() { return 1; }\n"
        "    baz(x: number) { return x; }\n"
        "}\n";
    auto syms = extract(src);
    const auto* cls = find(syms, "Foo");
    ASSERT_NE(cls, nullptr);
    EXPECT_EQ(cls->kind, HostSymbolKind::Class);
    EXPECT_EQ(cls->qualifiedName, "Foo");

    const auto* bar = find(syms, "bar");
    ASSERT_NE(bar, nullptr);
    EXPECT_EQ(bar->kind, HostSymbolKind::Method);
    EXPECT_EQ(bar->qualifiedName, "Foo.bar");
    EXPECT_EQ(bar->enclosingClass, "Foo");

    const auto* baz = find(syms, "baz");
    ASSERT_NE(baz, nullptr);
    EXPECT_EQ(baz->qualifiedName, "Foo.baz");
}

TEST_F(TypeScriptSymbolExtractorTest, ClassMethodVisibility) {
    std::string src =
        "export class Service {\n"
        "    public runPublic() {}\n"
        "    private runPrivate() {}\n"
        "    protected runProtected() {}\n"
        "    runDefault() {}\n"
        "}\n";
    auto syms = extract(src);

    const auto* pub = find(syms, "runPublic");
    ASSERT_NE(pub, nullptr);
    ASSERT_TRUE(pub->hostVisibility.has_value());
    EXPECT_EQ(*pub->hostVisibility, topo::Visibility::Public);

    const auto* pri = find(syms, "runPrivate");
    ASSERT_NE(pri, nullptr);
    ASSERT_TRUE(pri->hostVisibility.has_value());
    EXPECT_EQ(*pri->hostVisibility, topo::Visibility::Private);

    const auto* prot = find(syms, "runProtected");
    ASSERT_NE(prot, nullptr);
    ASSERT_TRUE(prot->hostVisibility.has_value());
    EXPECT_EQ(*prot->hostVisibility, topo::Visibility::Protected);

    const auto* def = find(syms, "runDefault");
    ASSERT_NE(def, nullptr);
    ASSERT_TRUE(def->hostVisibility.has_value());
    EXPECT_EQ(*def->hostVisibility, topo::Visibility::Public);  // default => public
}

TEST_F(TypeScriptSymbolExtractorTest, ExportInterface) {
    auto syms = extract("export interface Bar { id: number; }\n");
    ASSERT_GE(syms.size(), 1u);
    const auto* bar = find(syms, "Bar");
    ASSERT_NE(bar, nullptr);
    EXPECT_EQ(bar->kind, HostSymbolKind::Interface);
}

TEST_F(TypeScriptSymbolExtractorTest, ExportTypeAlias) {
    auto syms = extract("export type ID = number | string;\n");
    ASSERT_EQ(syms.size(), 1u);
    EXPECT_EQ(syms[0].simpleName, "ID");
    EXPECT_EQ(syms[0].kind, HostSymbolKind::TypeAlias);
}

TEST_F(TypeScriptSymbolExtractorTest, ExportConstLetVar) {
    std::string src =
        "export const x = 1;\n"
        "export let y = 2;\n"
        "export var z = 3;\n";
    auto syms = extract(src);
    ASSERT_EQ(syms.size(), 3u);
    EXPECT_NE(find(syms, "x"), nullptr);
    EXPECT_NE(find(syms, "y"), nullptr);
    EXPECT_NE(find(syms, "z"), nullptr);
    for (const auto& s : syms) {
        EXPECT_EQ(s.kind, HostSymbolKind::Variable);
    }
}

TEST_F(TypeScriptSymbolExtractorTest, ExportList_GroupedAndAliased) {
    std::string src =
        "function _a() {}\n"
        "function _b() {}\n"
        "export { _a as A, _b as B };\n";
    auto syms = extract(src);
    // Only the export list produces exported symbols; non-exported _a/_b
    // don't appear.
    EXPECT_NE(find(syms, "A"), nullptr);
    EXPECT_NE(find(syms, "B"), nullptr);
    EXPECT_EQ(find(syms, "_a"), nullptr);
    EXPECT_EQ(find(syms, "_b"), nullptr);
}

TEST_F(TypeScriptSymbolExtractorTest, ReexportStar_EmitsNoSymbol) {
    auto syms = extract("export * from \"./mod\";\n");
    // Re-export * has no named symbol to emit.
    EXPECT_TRUE(syms.empty())
        << "export * from ... should NOT produce a symbol (got " << syms.size() << ")";
}

TEST_F(TypeScriptSymbolExtractorTest, NestedNamespace_QualifiedName) {
    // Namespaces themselves are scope containers — they do NOT produce
    // HostSymbols. Inner functions pick up the namespace chain in their
    // qualifiedName so completeness can match nested .topo declarations.
    std::string src =
        "export namespace N {\n"
        "    export function f() {}\n"
        "}\n";
    auto syms = extract(src);
    EXPECT_EQ(find(syms, "N"), nullptr) << "namespace N should not be a symbol";
    const auto* f = find(syms, "f");
    ASSERT_NE(f, nullptr);
    EXPECT_EQ(f->qualifiedName, "N.f");
}

TEST_F(TypeScriptSymbolExtractorTest, DeeplyNestedNamespace_QualifiedName) {
    // Multi-level nesting: `Outer.Inner.compute`.
    std::string src =
        "export namespace Outer {\n"
        "    export namespace Inner {\n"
        "        export function compute(x: number): number { return x; }\n"
        "    }\n"
        "}\n";
    auto syms = extract(src);
    ASSERT_EQ(syms.size(), 1u) << "only `compute` should be emitted";
    EXPECT_EQ(syms[0].simpleName, "compute");
    EXPECT_EQ(syms[0].qualifiedName, "Outer.Inner.compute");
}

TEST_F(TypeScriptSymbolExtractorTest, EmptyFileNoSymbols) {
    auto syms = extract("// empty module\n");
    EXPECT_TRUE(syms.empty());
}

TEST_F(TypeScriptSymbolExtractorTest, NonExportedNotReported) {
    // Only `export`ed declarations should be visible.  Non-exported
    // top-level functions are implementation details.
    std::string src =
        "function hidden() {}\n"
        "export function shown() {}\n";
    auto syms = extract(src);
    // Regex is strict about `export` prefix: only `shown` should appear.
    ASSERT_EQ(syms.size(), 1u);
    EXPECT_EQ(syms[0].simpleName, "shown");
}

// --- CommonJS export forms -------------------------------------------

TEST_F(TypeScriptSymbolExtractorTest, CommonJS_NamedExport_Module) {
    std::string src =
        "function _impl(x) { return x; }\n"
        "module.exports.doThing = _impl;\n";
    auto syms = extract(src);
    ASSERT_EQ(syms.size(), 1u);
    EXPECT_EQ(syms[0].simpleName, "doThing");
    EXPECT_EQ(syms[0].kind, HostSymbolKind::Function);
}

TEST_F(TypeScriptSymbolExtractorTest, CommonJS_NamedExport_Bare) {
    std::string src =
        "exports.alpha = function(x) { return x; };\n"
        "exports.beta = (x) => x * 2;\n";
    auto syms = extract(src);
    ASSERT_EQ(syms.size(), 2u);
    EXPECT_NE(find(syms, "alpha"), nullptr);
    EXPECT_NE(find(syms, "beta"), nullptr);
}

TEST_F(TypeScriptSymbolExtractorTest, CommonJS_BulkExport) {
    std::string src =
        "function foo() {}\n"
        "function bar() {}\n"
        "const BAZ = 42;\n"
        "module.exports = { foo, bar, BAZ };\n";
    auto syms = extract(src);
    ASSERT_EQ(syms.size(), 3u);
    EXPECT_NE(find(syms, "foo"), nullptr);
    EXPECT_NE(find(syms, "bar"), nullptr);
    EXPECT_NE(find(syms, "BAZ"), nullptr);
}

TEST_F(TypeScriptSymbolExtractorTest, CommonJS_BulkExport_Rebinding) {
    std::string src =
        "function _impl() {}\n"
        "module.exports = { publicName: _impl };\n";
    auto syms = extract(src);
    // The bulk form captures the exported key; the internal binding is
    // not a separate symbol.
    ASSERT_EQ(syms.size(), 1u);
    EXPECT_EQ(syms[0].simpleName, "publicName");
}

// --- .d.ts ambient declarations ---------------------------------------

TEST_F(TypeScriptSymbolExtractorTest, DTS_DeclareFunctionNotEmitted) {
    // Ambient `declare function X(...)` in a .d.ts file is NOT a host
    // implementation -- it is a type stub. The extractor must not emit
    // a HostSymbol for it, or completeness check would flag it as an
    // orphan implementation.
    std::string src =
        "declare function fromNative(id: number): string;\n"
        "declare class ExternalType { length: number; }\n"
        "declare const DEFAULT_ID: number;\n";
    auto syms = extract(src, "types.d.ts");
    EXPECT_TRUE(syms.empty())
        << "declare forms must not produce HostSymbols (got " << syms.size() << ")";
}
