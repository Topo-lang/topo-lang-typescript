// Smoke test for topo-extract-typescript.
//
// Drives the production tool through its real stdin→stdout protocol and
// asserts the lifted TranspileModule uses the lowercase discriminator
// vocabulary the topo-core deserializer expects, and that an unliftable
// declared symbol fails loudly instead of producing a partial Model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tool = join(here, "index.mjs");

function run(tsSource, request) {
    const dir = mkdtempSync(join(tmpdir(), "topo-extract-ts-"));
    const src = join(dir, "input.ts");
    writeFileSync(src, tsSource);
    const req = { files: [src], symbolTable: {}, ...request };
    try {
        const out = execFileSync("node", [tool], {
            input: JSON.stringify(req),
            encoding: "utf8",
        });
        return JSON.parse(out);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function runExpectFail(tsSource, request) {
    const dir = mkdtempSync(join(tmpdir(), "topo-extract-ts-fail-"));
    const src = join(dir, "input.ts");
    writeFileSync(src, tsSource);
    const req = { files: [src], symbolTable: {}, ...request };
    try {
        let exitCode = 0;
        try {
            execFileSync("node", [tool], {
                input: JSON.stringify(req),
                encoding: "utf8",
            });
        } catch (err) {
            exitCode = err.status;
        }
        assert.notEqual(exitCode, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("lifts a function with arithmetic into lowercase-kind JSON", () => {
    const mod = run(
        "export function add3(x: number): number { return x + 3; }\n",
        { functions: ["add3"] });
    assert.equal(mod.functions.length, 1);
    const fn = mod.functions[0];
    assert.equal(fn.qualifiedName, "add3");
    assert.equal(fn.fidelity, "source");
    assert.equal(fn.body[0].kind, "return");
    assert.equal(fn.body[0].value.kind, "binaryop");
    assert.equal(fn.body[0].value.op, "add");
    assert.equal(fn.body[0].value.lhs.kind, "varref");
    assert.equal(fn.body[0].value.rhs.kind, "literal");
    assert.equal(fn.body[0].value.rhs.litKind, "integer");
});

test("hex integer literal containing e/E lifts as integer, not float", () => {
    // Regression: the decimal float heuristic `/[.eE]/` previously misread
    // hex digits as a fraction/exponent, tagging `0xE1` / `0xBEEF` as float.
    const mod = run(
        "export function masks(): number { return 0xE1 + 0xBEEF; }\n",
        { functions: ["masks"] });
    const ret = mod.functions[0].body[0].value;
    assert.equal(ret.kind, "binaryop");
    assert.equal(ret.lhs.kind, "literal");
    assert.equal(ret.lhs.litKind, "integer");
    assert.equal(ret.lhs.value, "0xE1");
    assert.equal(ret.rhs.litKind, "integer");
    assert.equal(ret.rhs.value, "0xBEEF");
    assert.equal(mod.functions[0].fidelity, "source");
});

test("binary/octal radix literals lift as integer", () => {
    const mod = run(
        "export function radix(): number { return 0b1010 + 0o17; }\n",
        { functions: ["radix"] });
    const ret = mod.functions[0].body[0].value;
    assert.equal(ret.lhs.litKind, "integer");
    assert.equal(ret.rhs.litKind, "integer");
});

test("decimal float with exponent still lifts as float", () => {
    const mod = run(
        "export function f(): number { return 1.5e3; }\n",
        { functions: ["f"] });
    assert.equal(mod.functions[0].body[0].value.litKind, "float");
});

test("self-update in expression position with arithmetic op lowers to compoundassign", () => {
    // `x = x + 1` as a for-incrementor is an assignment in EXPRESSION position,
    // which routes through lowerSelfAssign (the statement-level `x = ...` form
    // emits a dedicated `assign` node and never reaches lowerSelfAssign).
    const mod = run(
        "export function acc(n: number): number {\n" +
        "  let s: number = 0;\n" +
        "  for (let i: number = 0; i < n; s = s + 1) {}\n" +
        "  return s;\n" +
        "}\n",
        { functions: ["acc"] });
    const fn = mod.functions[0];
    const forStmt = fn.body.find((b) => b.kind === "for");
    assert.equal(forStmt.increment.kind, "compoundassign");
    assert.equal(forStmt.increment.op, "add");
    assert.equal(fn.fidelity, "source");
});

test("self-update in expression position with comparison op declines, marked unsupported", () => {
    // Regression: `x = x < 5` previously lowered to a nonsensical
    // `<`-compound-assign tagged source-fidelity. It must now decline and be
    // recorded as unsupported so no wrong-but-valid node reaches the Model.
    const mod = run(
        "export function cmp(x: number): number {\n" +
        "  for (let i: number = 0; i < 3; x = x < 5) {}\n" +
        "  return x;\n" +
        "}\n",
        { functions: ["cmp"] });
    const fn = mod.functions[0];
    assert.equal(fn.fidelity, "inferred");
    assert.ok(fn.unsupported.some((u) => /assignment/.test(u)),
        `expected an assignment-unsupported note, got: ${JSON.stringify(fn.unsupported)}`);
    // The for-incrementor degrades to an unsupported expr, never a
    // comparison-flavoured compoundassign.
    const forStmt = fn.body.find((b) => b.kind === "for");
    assert.equal(forStmt.increment.kind, "unsupported");
    const json = JSON.stringify(fn.body);
    assert.ok(!/compoundassign/.test(json) ||
        !/"op":"(eq|noteq|less|greater|lesseq|greatereq|and|or)"/.test(json));
});

test("self-update in expression position with logical op declines compoundassign", () => {
    const mod = run(
        "export function band(x: number): number {\n" +
        "  for (let i: number = 0; i < 3; x = x && 0) {}\n" +
        "  return x;\n" +
        "}\n",
        { functions: ["band"] });
    const fn = mod.functions[0];
    assert.equal(fn.fidelity, "inferred");
    assert.ok(fn.unsupported.some((u) => /assignment/.test(u)));
    const forStmt = fn.body.find((b) => b.kind === "for");
    assert.equal(forStmt.increment.kind, "unsupported");
});

test("self-update in expression position with bitwise op still lowers to compoundassign", () => {
    const mod = run(
        "export function mask(x: number): number {\n" +
        "  for (let i: number = 0; i < 3; x = x & 7) {}\n" +
        "  return x;\n" +
        "}\n",
        { functions: ["mask"] });
    const fn = mod.functions[0];
    const forStmt = fn.body.find((b) => b.kind === "for");
    assert.equal(forStmt.increment.kind, "compoundassign");
    assert.equal(forStmt.increment.op, "bitand");
    assert.equal(fn.fidelity, "source");
});

test("namespaced function keyed with :: separator", () => {
    const mod = run(
        "namespace m { export function f(n: number): number { return n; } }\n",
        { functions: ["m::f"] });
    assert.equal(mod.functions.length, 1);
    assert.equal(mod.functions[0].qualifiedName, "m::f");
});

test("control flow lifts to if/for/while kinds", () => {
    const mod = run(
        "export function g(n: number): number {\n" +
        "  let s: number = 0;\n" +
        "  for (let i: number = 0; i < n; i = i + 1) { s = s + i; }\n" +
        "  if (s > 10) { return s; } else { return 0; }\n" +
        "}\n",
        { functions: ["g"] });
    const body = mod.functions[0].body;
    assert.equal(body[0].kind, "vardecl");
    assert.equal(body[1].kind, "for");
    assert.equal(body[2].kind, "if");
    assert.ok(Array.isArray(body[2].elseBody));
});

test("async function is recorded as unsupported, fidelity downgraded", () => {
    // Aligned with C++/Rust/Java: a SOURCE extractor's approximate emission
    // tags as "inferred" (not "recovered" — that's reserved for decompilers
    // lifting from IR/bytecode). See FnLift.fidelity() in index.mjs.
    const mod = run(
        "export async function h(): Promise<number> { return 1; }\n",
        { functions: ["h"] });
    const fn = mod.functions[0];
    assert.equal(fn.fidelity, "inferred");
    assert.ok(fn.unsupported.some((u) => /async/.test(u)));
});

test("missing declared symbol fails loudly (no partial Model)", () => {
    runExpectFail(
        "export function present(): number { return 0; }\n",
        { functions: ["absent"] });
});

test("generic function recovers bare type-param names into templateParams", () => {
    const mod = run(
        "export function identity<T>(x: T): T { return x; }\n",
        { functions: ["identity"] });
    const fn = mod.functions[0];
    assert.equal(fn.qualifiedName, "identity");
    assert.deepEqual(fn.templateParams, [{ kind: "type", name: "T" }]);
    assert.equal(fn.fidelity, "source");
});

test("single-bound type param captures bound and stays source-fidelity", () => {
    const mod = run(
        "export function pick<T extends number>(x: T): T { return x; }\n",
        { functions: ["pick"] });
    const fn = mod.functions[0];
    // Single trait-bound MVP: `<T extends number>` is now captured into the
    // wire `bound` field rather than dropped. `number` maps to `f64` per
    // typeFromNode (the same mapping Topo applies to parameter/return type
    // annotations, so the bound stays semantically consistent).
    assert.deepEqual(fn.templateParams, [{
        kind: "type",
        name: "T",
        bound: { nameParts: ["f64"] },
    }]);
    assert.equal(fn.fidelity, "source");
    assert.deepEqual(fn.unsupported, []);
});

test("default-only type param captures default and stays source-fidelity", () => {
    // `<T = X>` is legal on TS function type parameters; the extractor
    // captures it as the wire `default: TypeNode` (parallel to `bound`).
    // `number` maps to `f64` per the TS→Topo type mapping the function
    // signature already uses.
    const mod = run(
        "export function id<T = number>(x: T): T { return x; }\n",
        { functions: ["id"] });
    const fn = mod.functions[0];
    assert.deepEqual(fn.templateParams, [{
        kind: "type",
        name: "T",
        default: { nameParts: ["f64"] },
    }]);
    assert.equal(fn.fidelity, "source");
});

test("non-generic function has no templateParams key", () => {
    const mod = run(
        "export function plain(x: number): number { return x; }\n",
        { functions: ["plain"] });
    assert.equal(mod.functions[0].templateParams, undefined);
});

test("class extends and implements lift to baseClasses + baseClassKinds", () => {
    const mod = run(
        "export class Dog extends Animal implements Comparable, Serializable {}\n",
        {});
    assert.equal(mod.types.length, 1);
    const ty = mod.types[0];
    assert.equal(ty.qualifiedName, "Dog");
    assert.deepEqual(ty.baseClasses.map((b) => b.nameParts[0]),
                     ["Animal", "Comparable", "Serializable"]);
    assert.deepEqual(ty.baseClassKinds, ["class", "interface", "interface"]);
});

test("interface-extends-interface tags every parent as interface (no class base)", () => {
    const mod = run(
        "export interface Comparable2 extends Comparable, Serializable {}\n",
        {});
    const ty = mod.types[0];
    assert.deepEqual(ty.baseClasses.map((b) => b.nameParts[0]),
                     ["Comparable", "Serializable"]);
    assert.deepEqual(ty.baseClassKinds, ["interface", "interface"]);
});

test("interface-only class has implements but no extends-class", () => {
    const mod = run(
        "export class Handler implements Runnable {}\n",
        {});
    const ty = mod.types[0];
    assert.deepEqual(ty.baseClasses.map((b) => b.nameParts[0]), ["Runnable"]);
    assert.deepEqual(ty.baseClassKinds, ["interface"]);
});

test("plain class without bases omits baseClasses/baseClassKinds keys", () => {
    const mod = run("export class Plain { x: number; }\n", {});
    const ty = mod.types[0];
    assert.equal(ty.qualifiedName, "Plain");
    assert.equal(ty.baseClasses, undefined);
    assert.equal(ty.baseClassKinds, undefined);
    assert.deepEqual(ty.fields, [{ type: { nameParts: ["f64"] }, name: "x", fidelity: "source" }]);
});

test("class fields lift with their type annotations", () => {
    const mod = run(
        "export class Point { x: number; y: number; label: string; }\n",
        {});
    const ty = mod.types[0];
    assert.equal(ty.fields.length, 3);
    assert.equal(ty.fields[0].name, "x");
    assert.deepEqual(ty.fields[0].type.nameParts, ["f64"]);
    assert.equal(ty.fields[2].name, "label");
    assert.deepEqual(ty.fields[2].type.nameParts, ["string"]);
});

test("class generic type parameters recover bare names into templateParams", () => {
    const mod = run("export class Box<T> { value: T; }\n", {});
    const ty = mod.types[0];
    assert.deepEqual(ty.templateParams, [{ kind: "type", name: "T" }]);
    assert.equal(ty.fidelity, "source");
});

test("class generic with default captures default + stays source", () => {
    // PEP-696-equivalent: `<T = X>` on a class is legal in TS. The
    // extractor captures it as the wire `default: TypeNode`; the rest of
    // the class lifts as before so no fidelity downgrade is triggered.
    const mod = run("export class Box<T = number> { value: T; }\n", {});
    const ty = mod.types[0];
    assert.deepEqual(ty.templateParams, [{
        kind: "type",
        name: "T",
        default: { nameParts: ["f64"] },
    }]);
    assert.equal(ty.fidelity, "source");
});

test("class generic with single bound captures bound + stays source", () => {
    // Single trait-bound MVP: `<T extends number>` on a class now lifts
    // `number → f64` into the wire `bound`, parallel to function-decl
    // handling; no fidelity downgrade is needed because nothing was dropped.
    // (Field type kept as a plain T[] to avoid `readonly` triggering the
    // TypeOperator unsupported path and downgrading for an unrelated reason.)
    const mod = run("export class Sortable<T extends number> { items: T[]; }\n", {});
    const ty = mod.types[0];
    assert.deepEqual(ty.templateParams, [{
        kind: "type",
        name: "T",
        bound: { nameParts: ["f64"] },
    }]);
    assert.equal(ty.fidelity, "source");
});

test("class generic with intersection bound captures bounds list", () => {
    // Intersection `<T extends A & B>` graduates from the legacy `bound`
    // key to the new `bounds: [TypeNode]` list. Each branch passes through
    // typeFromNode (so name parts include any TS→Topo primitive mapping).
    const mod = run(
        "interface A {}\ninterface B {}\n"
        + "export class Sortable<T extends A & B> { items: T[]; }\n",
        {});
    const ty = mod.types.find((t) => t.qualifiedName === "Sortable");
    assert.ok(ty, `expected Sortable; got: ${JSON.stringify(mod.types.map(t => t.qualifiedName))}`);
    assert.deepEqual(ty.templateParams, [{
        kind: "type",
        name: "T",
        bounds: [{ nameParts: ["A"] }, { nameParts: ["B"] }],
    }]);
    assert.equal(ty.fidelity, "source");
});

test("function generic with intersection bound captures bounds list", () => {
    // Function-decl side mirrors class-side: the extractor reuses
    // liftTypeParams so both call-sites get the same `bounds: [TypeNode]`
    // wire shape on intersection.
    const mod = run(
        "interface A {}\ninterface B {}\n"
        + "export function pick<T extends A & B>(x: T): T { return x; }\n",
        { functions: ["pick"] });
    const fn = mod.functions[0];
    assert.deepEqual(fn.templateParams, [{
        kind: "type",
        name: "T",
        bounds: [{ nameParts: ["A"] }, { nameParts: ["B"] }],
    }]);
    assert.equal(fn.fidelity, "source");
});

test("namespaced class qualifies with :: like functions", () => {
    const mod = run(
        "namespace m { export class Inner extends Base {} }\n",
        {});
    const ty = mod.types.find((t) => t.qualifiedName === "m::Inner");
    assert.ok(ty, `expected m::Inner in types, got: ${JSON.stringify(mod.types)}`);
    assert.deepEqual(ty.baseClasses.map((b) => b.nameParts[0]), ["Base"]);
    assert.deepEqual(ty.baseClassKinds, ["class"]);
});

test("class with no body extracted independently of requested functions filter", () => {
    // The functions filter targets functions only; type extraction is
    // unconditional so referenced bases stay resolvable across modules.
    const mod = run(
        "export class A {}\nexport function fn(): void {}\n",
        { functions: ["fn"] });
    assert.equal(mod.functions.length, 1);
    assert.equal(mod.types.length, 1);
    assert.equal(mod.types[0].qualifiedName, "A");
});

// ---------------------------------------------------------------------------
// "symbols" mode — L1 host-symbol extraction for topo-check. Drives the same
// tool through the {"mode":"symbols",...} request and asserts the AST walk
// emits exactly the exported-only HostSymbol set the regex extractor emits.
// ---------------------------------------------------------------------------

// Run the tool in symbols mode against one inline source file; returns the
// parsed {symbols:[...]} response.
function runSymbols(tsSource) {
    const dir = mkdtempSync(join(tmpdir(), "topo-extract-ts-sym-"));
    const src = join(dir, "input.ts");
    writeFileSync(src, tsSource);
    try {
        const out = execFileSync("node", [tool], {
            input: JSON.stringify({ mode: "symbols", files: [src] }),
            encoding: "utf8",
        });
        return JSON.parse(out);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("symbols mode: empty files request returns an empty symbols array", () => {
    const out = execFileSync("node", [tool], {
        input: JSON.stringify({ mode: "symbols", files: [] }),
        encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(out), { symbols: [] });
});

test("symbols mode: export function and class with members", () => {
    const res = runSymbols(
        "export function topLevel(x: number): number { return x; }\n" +
        "export class Renderer {\n" +
        "  constructor() {}\n" +
        "  render(): void {}\n" +
        "  private helper(): void {}\n" +
        "  static make(): Renderer { return new Renderer(); }\n" +
        "}\n" +
        "function notExported(): void {}\n");
    const names = res.symbols.map((s) => s.qualifiedName).sort();
    assert.deepEqual(names, [
        "Renderer", "Renderer.constructor", "Renderer.helper",
        "Renderer.make", "Renderer.render", "topLevel",
    ]);
    const helper = res.symbols.find((s) => s.simpleName === "helper");
    assert.equal(helper.kind, "method");
    assert.equal(helper.visibility, "private");
    assert.equal(helper.enclosingClass, "Renderer");
    const make = res.symbols.find((s) => s.simpleName === "make");
    assert.equal(make.isStatic, true);
    const ctor = res.symbols.find((s) => s.kind === "constructor");
    assert.equal(ctor.simpleName, "constructor");
});

test("symbols mode: export renaming emits the aliased names only", () => {
    const res = runSymbols(
        "function _impl(x: number): number { return x * 2; }\n" +
        "function _helper(y: number): number { return y + 1; }\n" +
        "export { _impl as publicApi, _helper as otherApi };\n");
    const names = res.symbols.map((s) => s.simpleName).sort();
    assert.deepEqual(names, ["otherApi", "publicApi"]);
});

test("symbols mode: export * from emits nothing", () => {
    const res = runSymbols("export * from \"./helpers\";\n");
    assert.deepEqual(res.symbols, []);
});

test("symbols mode: nested exported namespace prefixes inner symbols", () => {
    const res = runSymbols(
        "export namespace Outer {\n" +
        "  export namespace Inner {\n" +
        "    export function compute(x: number): number { return x * 3; }\n" +
        "  }\n" +
        "}\n");
    assert.equal(res.symbols.length, 1);
    assert.equal(res.symbols[0].qualifiedName, "Outer.Inner.compute");
});

test("symbols mode: CommonJS module.exports.X and bulk forms", () => {
    const res = runSymbols(
        "function aImpl() {}\nfunction bImpl() {}\nfunction cImpl() {}\n" +
        "module.exports.a = aImpl;\n" +
        "exports.b = bImpl;\n");
    const named = res.symbols.map((s) => s.simpleName).sort();
    assert.deepEqual(named, ["a", "b"]);

    const bulk = runSymbols(
        "function aImpl() {}\nfunction bImpl() {}\n" +
        "module.exports = { a: aImpl, bImpl };\n");
    assert.deepEqual(bulk.symbols.map((s) => s.simpleName).sort(),
                     ["a", "bImpl"]);
});

test("symbols mode: computed key recovers a string-literal name, drops dynamic", () => {
    // Regression: `{ ["dyn"]: m }` previously emitted the literal source text
    // `["dyn"]` as the symbol name. A string-literal computed key has a static
    // name (`dyn`); a non-literal computed key (`[k]`) is dynamic and must be
    // dropped rather than emitted as an invalid name.
    const res = runSymbols(
        "function impl() {}\nconst k = \"runtime\";\n" +
        "module.exports = { [\"dyn\"]: impl, [k]: impl, plain: impl };\n");
    const names = res.symbols.map((s) => s.simpleName).sort();
    assert.deepEqual(names, ["dyn", "plain"]);
    // No symbol carries the raw bracket-source as a name.
    assert.ok(!res.symbols.some((s) => /[[\]]/.test(s.qualifiedName)),
        `unexpected bracketed name: ${JSON.stringify(names)}`);
});

test("symbols mode: every emitted field carries its contract JSON type", () => {
    // Producer-side guard for the C++ deserializer contract: the AST extractor
    // must always emit string qualifiedName/simpleName/kind/file/enclosingClass,
    // a numeric line, and a boolean isStatic. A type-mismatched field would make
    // the C++ side's entry.value<T>() throw and (via the worker catch(...))
    // silently drop the whole completeness check.
    const res = runSymbols(
        "export function topLevel(x: number): number { return x; }\n" +
        "export class C { static make(): void {} private hid(): void {} }\n");
    assert.ok(res.symbols.length > 0);
    for (const s of res.symbols) {
        assert.equal(typeof s.qualifiedName, "string");
        assert.equal(typeof s.simpleName, "string");
        assert.equal(typeof s.kind, "string");
        assert.equal(typeof s.file, "string");
        assert.equal(typeof s.line, "number");
        assert.equal(typeof s.isStatic, "boolean");
        assert.equal(typeof s.enclosingClass, "string");
        assert.equal(typeof s.visibility, "string");
    }
});

test("symbols mode: declare ambient declarations are skipped", () => {
    const res = runSymbols(
        "declare function legacyFunction(id: number): string;\n" +
        "declare class LegacyShape { width: number; }\n" +
        "declare module \"vendor\" {\n" +
        "  export function vendorConnect(url: string): boolean;\n" +
        "}\n" +
        "export function realFunction(x: number): number { return x; }\n");
    assert.deepEqual(res.symbols.map((s) => s.simpleName), ["realFunction"]);
});

test("symbols mode: interface and type alias map to dedicated kinds", () => {
    // Interface / type alias now lift to their own discriminator kinds
    // (`interface` / `typealias`) rather than the previous shared
    // `class` fallback, which lost that kind distinction. The
    // CompletenessCheck side routes both through the same
    // type-symbol lookup path, so `.topo` `class Foo` continues to
    // match a TS `interface Foo`.
    const res = runSymbols(
        "export interface Shape { area(): number; }\n" +
        "export type Id = number;\n" +
        "export const PI = 3.14;\n");
    const kinds = Object.fromEntries(
        res.symbols.map((s) => [s.simpleName, s.kind]));
    assert.deepEqual(kinds, {
        Shape: "interface",
        Id: "typealias",
        PI: "variable",
    });
});
