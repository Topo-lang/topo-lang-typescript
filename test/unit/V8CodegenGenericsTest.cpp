// V8CodegenGenericsTest — V8Codegen `tsGenericsImpl` rendering proofs for the
// TS type-parameter feature surface (bound + default). The extractor side is
// covered by `topo-check/extractor/smoke.test.mjs`; this binary asserts the
// emitter renders what those wire shapes round-trip into.
//
// Mirrors PythonEmitterStdlibTest.cpp / TranspileRustGenerics in
// TranspileNewConstructsTest.cpp — direct construction of TranspileModule
// avoids any extractor/JSON dependency.
#include "V8Codegen.h"
#include "topo/Transpile/TranspileModel.h"
#include <gtest/gtest.h>

using namespace topo::transpile;
using topo::Parameter;
using topo::TemplateParamDecl;
using topo::TypeNode;

namespace {

TypeNode tsNamed(std::initializer_list<std::string> parts) {
    TypeNode n;
    n.nameParts.assign(parts.begin(), parts.end());
    return n;
}

TemplateParamDecl tsTypeParam(const std::string& name) {
    TemplateParamDecl tp;
    tp.kind = TemplateParamDecl::TypeParam;
    tp.name = name;
    return tp;
}

} // namespace

// --- bare type parameter --------------------------------------------------

TEST(V8CodegenGenerics, UnboundedTypeParamByteIdenticalToPreBoundsOutput) {
    TranspileModule mod;
    TranspileType ty;
    ty.qualifiedName = "Box";
    ty.templateParams.push_back(tsTypeParam("T"));
    mod.types.push_back(std::move(ty));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(code.find("export class Box<T>"), std::string::npos)
        << "Generated:\n" << code;
    EXPECT_EQ(code.find("<T extends"), std::string::npos)
        << "no bound expected for bare type param; got:\n" << code;
    EXPECT_EQ(code.find("<T ="), std::string::npos)
        << "no default expected for bare type param; got:\n" << code;
}

// --- single-bound (existing feature, regression coverage) ------------------

TEST(V8CodegenGenerics, GenericClassWithSingleBoundEmitsExtends) {
    TranspileModule mod;
    TranspileType ty;
    ty.qualifiedName = "Sortable";
    auto tp = tsTypeParam("T");
    tp.constraintType = tsNamed({"Comparable"});
    ty.templateParams.push_back(tp);
    mod.types.push_back(std::move(ty));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(code.find("export class Sortable<T extends Comparable>"),
              std::string::npos)
        << "Generated:\n" << code;
}

// --- default `<T = X>` (new) ----------------------------------------------

TEST(V8CodegenGenerics, GenericClassWithDefaultEmitsAssign) {
    // PEP-696-equivalent: TS allows `<T = X>` on classes. The emitter must
    // render the default verbatim.
    TranspileModule mod;
    TranspileType ty;
    ty.qualifiedName = "Box";
    auto tp = tsTypeParam("T");
    tp.defaultType = tsNamed({"number"});
    ty.templateParams.push_back(tp);
    mod.types.push_back(std::move(ty));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(code.find("export class Box<T = number>"), std::string::npos)
        << "Generated:\n" << code;
}

TEST(V8CodegenGenerics, GenericFunctionWithDefaultEmitsAssign) {
    // TS allows defaults on function type parameters as well; the emitter
    // shares the same helper across class and function sites.
    TranspileModule mod;
    TranspileFunction fn;
    fn.qualifiedName = "id";
    auto tp = tsTypeParam("T");
    tp.defaultType = tsNamed({"string"});
    fn.templateParams.push_back(tp);
    mod.functions.push_back(std::move(fn));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(code.find("export function id<T = string>("), std::string::npos)
        << "Generated:\n" << code;
}

// --- Intersection multi-bound: `<T extends A & B>` ---

TEST(V8CodegenGenerics, GenericClassWithIntersectionBoundEmitsAmpersand) {
    TranspileModule mod;
    TranspileType ty;
    ty.qualifiedName = "Sortable";
    auto tp = tsTypeParam("T");
    tp.constraintType = tsNamed({"Comparable"});
    tp.extraBounds.push_back(tsNamed({"Serializable"}));
    ty.templateParams.push_back(tp);
    mod.types.push_back(std::move(ty));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(
        code.find("export class Sortable<T extends Comparable & Serializable>"),
        std::string::npos)
        << "Generated:\n" << code;
}

TEST(V8CodegenGenerics, GenericFunctionWithIntersectionBoundEmitsAmpersand) {
    TranspileModule mod;
    TranspileFunction fn;
    fn.qualifiedName = "pick";
    auto tp = tsTypeParam("T");
    tp.constraintType = tsNamed({"Number"});
    tp.extraBounds.push_back(tsNamed({"Comparable"}));
    fn.templateParams.push_back(tp);
    mod.functions.push_back(std::move(fn));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(
        code.find("export function pick<T extends Number & Comparable>("),
        std::string::npos)
        << "Generated:\n" << code;
}

TEST(V8CodegenGenerics, SingleBoundEmitWithExtraBoundsEmptyByteIdentical) {
    // Single-bound (extraBounds empty) must emit byte-identical to the
    // pre-multi-bound output — no stray ` & ` artefact.
    TranspileModule mod;
    TranspileType ty;
    ty.qualifiedName = "Box";
    auto tp = tsTypeParam("T");
    tp.constraintType = tsNamed({"Comparable"});
    ty.templateParams.push_back(tp);
    mod.types.push_back(std::move(ty));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(code.find("export class Box<T extends Comparable>"),
              std::string::npos)
        << "Generated:\n" << code;
    EXPECT_EQ(code.find("Comparable &"), std::string::npos)
        << "no stray ` & ` after single bound:\n" << code;
}

TEST(V8CodegenGenerics, BoundAndDefaultEmitInExtendsThenAssignOrder) {
    // When a TS type parameter carries both a bound and a default, the
    // surface form is `<T extends Bound = Default>`. The emitter renders
    // bound first, then `=`.
    TranspileModule mod;
    TranspileFunction fn;
    fn.qualifiedName = "pick";
    auto tp = tsTypeParam("T");
    tp.constraintType = tsNamed({"Comparable"});
    tp.defaultType = tsNamed({"number"});
    fn.templateParams.push_back(tp);
    mod.functions.push_back(std::move(fn));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(
        code.find("export function pick<T extends Comparable = number>("),
        std::string::npos)
        << "Generated:\n" << code;
}

// --- Rust lifetime drop (silent) ------------------------------------------

// `pub struct Holder<'a, T: 'a> { ... }` (Rust surface form) → wire model
// carries one kind=Lifetime entry + one TypeParam whose bound is `'a`. TS
// has no lifetime concept; both pieces must vanish without any drop note.
TEST(V8CodegenGenerics, LifetimeParamDroppedSilently) {
    TranspileModule mod;
    TranspileType ty;
    ty.qualifiedName = "Holder";
    TemplateParamDecl la;
    la.kind = TemplateParamDecl::LifetimeParam;
    la.name = "a";
    auto t = tsTypeParam("T");
    t.constraintType = tsNamed({"'a"});
    ty.templateParams.push_back(la);
    ty.templateParams.push_back(t);
    mod.types.push_back(std::move(ty));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(code.find("export class Holder<T>"), std::string::npos)
        << "TS clause must reduce to `<T>` (lifetime + lifetime bound "
           "silently dropped). Got:\n" << code;
    EXPECT_EQ(code.find("'a"), std::string::npos)
        << "TS output must not carry any `'a`. Got:\n" << code;
    EXPECT_EQ(code.find("TOPO-TRANSPILE"), std::string::npos)
        << "Lifetime drop must be silent (no drop note). Got:\n" << code;
}

// --- HRTB (`for<'a, 'b> Fn(...)`) silently dropped ------------------------

TEST(V8CodegenGenerics, HrtbLifetimesDroppedSilently) {
    // Build a function module mirroring the RustEmitter HRTB case:
    // `<F: Fn(...) with hrtbLifetimes={"a"}>`. TS has no HRTB concept;
    // the prefix and the apostrophe must NOT leak into the TS output and
    // the drop must be silent (no `for<` comment).
    TranspileModule mod;
    TranspileFunction fn;
    fn.qualifiedName = "map";
    fn.returnType = tsNamed({"void"});
    Parameter p;
    p.name = "_f";
    p.type = tsNamed({"F"});
    fn.params.push_back(p);

    auto t = tsTypeParam("F");
    TypeNode bound = tsNamed({"Fn"});
    bound.hrtbLifetimes = {"a"};
    t.constraintType = bound;
    fn.templateParams.push_back(t);

    mod.functions.push_back(std::move(fn));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_EQ(code.find("for<"), std::string::npos)
        << "TS output must not carry HRTB `for<` prefix. Got:\n" << code;
    EXPECT_EQ(code.find("'a"), std::string::npos)
        << "TS output must not carry any `'a`. Got:\n" << code;
}

// --- Non-stdlib i64 / u64 / int64_t / uint64_t still emit bigint -----------
//
// Regression test for the lossy fallback path: when a TypeNode arrives
// without `stdlibId` (e.g. a wire payload whose deserializer skipped
// the field, or a host type-binding override that lists `"i64"` as a
// literal name) the `mapPrimitiveType` legacy path must still emit
// `bigint`, not `number` — otherwise the upper 11 bits of precision
// are silently lost at the language boundary.

TEST(V8CodegenPrimitives, NonStdlibI64EmitsBigint) {
    TranspileModule mod;
    TranspileFunction fn;
    fn.qualifiedName = "asI64";
    fn.returnType = tsNamed({"i64"});           // no stdlibId — legacy path
    mod.functions.push_back(std::move(fn));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(code.find(": bigint"), std::string::npos)
        << "i64 fallback must render as bigint. Got:\n" << code;
    EXPECT_EQ(code.find(": number"), std::string::npos)
        << "i64 must NOT render as number (53-bit mantissa loses upper 11 "
           "bits). Got:\n" << code;
}

TEST(V8CodegenPrimitives, NonStdlibU64EmitsBigint) {
    TranspileModule mod;
    TranspileFunction fn;
    fn.qualifiedName = "asU64";
    fn.returnType = tsNamed({"u64"});
    mod.functions.push_back(std::move(fn));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(code.find(": bigint"), std::string::npos)
        << "u64 fallback must render as bigint. Got:\n" << code;
}

TEST(V8CodegenPrimitives, NonStdlibInt64TEmitsBigint) {
    TranspileModule mod;
    TranspileFunction fn;
    fn.qualifiedName = "asInt64";
    fn.returnType = tsNamed({"int64_t"});
    mod.functions.push_back(std::move(fn));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(code.find(": bigint"), std::string::npos)
        << "int64_t fallback must render as bigint. Got:\n" << code;
}

TEST(V8CodegenPrimitives, NonStdlibI32StaysNumber) {
    // Lower-width integers are precision-safe inside the 53-bit mantissa,
    // so they continue to render as `number` (the agreement point between
    // the legacy and stdlib paths).
    TranspileModule mod;
    TranspileFunction fn;
    fn.qualifiedName = "asI32";
    fn.returnType = tsNamed({"i32"});
    mod.functions.push_back(std::move(fn));

    std::string code = V8Codegen().emit(mod).code;
    EXPECT_NE(code.find(": number"), std::string::npos)
        << "i32 should remain number. Got:\n" << code;
}
