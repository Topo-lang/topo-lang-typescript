// topo-extract-typescript — lifts TypeScript source into a TranspileModule,
// and (in "symbols" mode) extracts exported declarations for topo-check L1.
//
// Subprocess protocol (driven by topo-core TranspileDriver / the
// TypeScriptASTSymbolExtractor):
//
//   Transpile mode (no `mode`, or `mode` !== "symbols"):
//     stdin  → JSON { "files": [...], "functions": [...], "symbolTable": {...} }
//     stdout → JSON TranspileModule { "types": [...], "functions": [...] }
//
//   Symbols mode (`mode` === "symbols"):
//     stdin  → JSON { "mode": "symbols", "files": [...] }
//     stdout → JSON { "symbols": [ {qualifiedName, simpleName, kind, file,
//                     line, enclosingClass, isStatic, visibility}, ... ] }
//
// The transpile-mode JSON node shapes are authoritatively defined by
// topo-core's TranspileModelJson.cpp deserializer. Discriminator strings are
// lowercase ("varref", "binaryop", "literal", ...) and must match it
// byte-for-byte — the C++ side rejects nothing but silently degrades unknown
// kinds to Unsupported, so divergence corrupts the lifted Model rather than
// erroring.
//
// A declared symbol whose body cannot be faithfully reconstructed is never
// silently dropped: the construct is recorded in the function's `unsupported`
// list and the function fidelity is downgraded, so the caller can refuse a
// partial Model instead of emitting wrong target code.

import ts from "typescript";

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on("data", (c) => chunks.push(c));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        process.stdin.on("error", reject);
    });
}

// ---------------------------------------------------------------------------
// Per-function lift state — collects `unsupported` notes and tracks whether
// the body had to fall back, so fidelity reflects reconstruction quality.
// ---------------------------------------------------------------------------

class FnLift {
    constructor() {
        this.unsupported = [];
        this.degraded = false;
    }
    note(msg) {
        this.unsupported.push(msg);
        this.degraded = true;
    }
    fidelity() {
        // Cross-extractor Fidelity convention: a SOURCE extractor that
        // emits an approximate shape because the source feature is
        // outside the MVP uses
        // "inferred". `recovered` is reserved for decompilers
        // (LLVMLifter / JVMLifter), where the input is a genuinely lossy
        // form (IR / bytecode). Earlier the TS extractor used "recovered"
        // uniformly for any degraded lift; that diverged from
        // C++/Rust/Java and forced cross-language consumers to special-case
        // TS. Aligned here so the tag has a single meaning everywhere.
        return this.degraded ? "inferred" : "source";
    }
}

// ---------------------------------------------------------------------------
// TypeNode — the .topo declaration is the contract for signatures, so the
// extractor maps TS annotations into the same nameParts vocabulary the
// emitters expect. Unannotated positions yield an empty/void node, which the
// emitters treat as inferred.
// ---------------------------------------------------------------------------

function typeNode(nameParts) {
    return { nameParts };
}

// Map a TS type annotation to a Topo stdlib-ish nameParts vector. Only the
// scalar/parametric set the equivalence harness exercises is mapped; anything
// else is passed through by its source text so the emitter (not this tool)
// decides whether it can render it.
function typeFromNode(node, lift) {
    if (!node) return typeNode(["void"]);
    switch (node.kind) {
        case ts.SyntaxKind.NumberKeyword:
            return typeNode(["f64"]);
        case ts.SyntaxKind.BooleanKeyword:
            return typeNode(["bool"]);
        case ts.SyntaxKind.StringKeyword:
            return typeNode(["string"]);
        case ts.SyntaxKind.VoidKeyword:
        case ts.SyntaxKind.UndefinedKeyword:
            return typeNode(["void"]);
        case ts.SyntaxKind.BigIntKeyword:
            return typeNode(["i64"]);
        case ts.SyntaxKind.ArrayType: {
            const inner = typeFromNode(node.elementType, lift);
            return { nameParts: ["slice"], ...arrParam(inner) };
        }
        case ts.SyntaxKind.TypeReference: {
            const name = node.typeName ? node.typeName.getText() : "auto";
            return typeNode([name]);
        }
        default:
            if (lift) lift.note(`type annotation '${node.getText()}'`);
            return typeNode([node.getText ? node.getText() : "auto"]);
    }
}

// TranspileModelJson encodes parametric types via templateArgs; the harness
// only needs scalars so we keep arrays minimal but well-formed.
function arrParam(inner) {
    return { templateArgs: [inner] };
}

// ---------------------------------------------------------------------------
// Expression lift — emits the lowercase "kind" discriminators that
// TranspileModelJson.cpp's exprKindFromStr() recognises.
// ---------------------------------------------------------------------------

const BINOP = {
    [ts.SyntaxKind.PlusToken]: "add",
    [ts.SyntaxKind.MinusToken]: "sub",
    [ts.SyntaxKind.AsteriskToken]: "mul",
    [ts.SyntaxKind.SlashToken]: "div",
    [ts.SyntaxKind.PercentToken]: "mod",
    [ts.SyntaxKind.EqualsEqualsToken]: "eq",
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: "eq",
    [ts.SyntaxKind.ExclamationEqualsToken]: "noteq",
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "noteq",
    [ts.SyntaxKind.LessThanToken]: "less",
    [ts.SyntaxKind.GreaterThanToken]: "greater",
    [ts.SyntaxKind.LessThanEqualsToken]: "lesseq",
    [ts.SyntaxKind.GreaterThanEqualsToken]: "greatereq",
    [ts.SyntaxKind.AmpersandAmpersandToken]: "and",
    [ts.SyntaxKind.BarBarToken]: "or",
    [ts.SyntaxKind.AmpersandToken]: "bitand",
    [ts.SyntaxKind.BarToken]: "bitor",
    [ts.SyntaxKind.CaretToken]: "bitxor",
    [ts.SyntaxKind.LessThanLessThanToken]: "shl",
    [ts.SyntaxKind.GreaterThanGreaterThanToken]: "shr",
    [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: "shr",
};

// Compound-assignment token → base BinaryOp string, for the CompoundAssign node.
const COMPOUND = {
    [ts.SyntaxKind.PlusEqualsToken]: "add",
    [ts.SyntaxKind.MinusEqualsToken]: "sub",
    [ts.SyntaxKind.AsteriskEqualsToken]: "mul",
    [ts.SyntaxKind.SlashEqualsToken]: "div",
    [ts.SyntaxKind.PercentEqualsToken]: "mod",
    [ts.SyntaxKind.AmpersandEqualsToken]: "bitand",
    [ts.SyntaxKind.BarEqualsToken]: "bitor",
    [ts.SyntaxKind.CaretEqualsToken]: "bitxor",
    [ts.SyntaxKind.LessThanLessThanEqualsToken]: "shl",
    [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: "shr",
};

// The base-op strings that have a genuine compound-assignment form. Only
// arithmetic / bitwise / shift ops qualify — comparison (eq/less/...) and
// logical (and/or) BINOP entries have no `<op>=` counterpart, so lowering
// `x = x < y` to a `<`-compound-assign would fabricate a node with no source
// meaning. Derived from COMPOUND so the two stay in lockstep.
const COMPOUND_BASE_OPS = new Set(Object.values(COMPOUND));

function unsupportedExpr(desc) {
    // Same convention as FnLift.fidelity(): a SOURCE extractor's
    // approximate emission tags as "inferred", not "recovered". See the
    // Fidelity convention note in FnLift.fidelity above.
    return { kind: "unsupported", fidelity: "inferred", description: desc };
}

function lit(litKind, value) {
    return { kind: "literal", fidelity: "source", litKind, value };
}

// `x = x <binop> rhs`  ≡  CompoundAssign(x, <binop>, rhs). Returns null when
// the assignment is not a self-update reducible to a compound form, so the
// caller can record it as genuinely unsupported instead of misrepresenting it.
function lowerSelfAssign(node, lift) {
    const target = node.left;
    const rhs = node.right;
    if (!ts.isBinaryExpression(rhs)) return null;
    const op = BINOP[rhs.operatorToken.kind];
    if (op === undefined) return null;
    // Only ops with a real `<op>=` form may become a CompoundAssign. A
    // comparison/logical RHS (`x = x < 5`, `x = x && y`) has no compound
    // counterpart, so decline and let the caller record it as unsupported
    // rather than emit a nonsensical `<`/`and`-compound-assign.
    if (!COMPOUND_BASE_OPS.has(op)) return null;
    // Require the LHS to reappear as the left operand of the RHS binop,
    // compared by source text (covers identifiers and simple member/index).
    if (rhs.left.getText() !== target.getText()) return null;
    return {
        kind: "compoundassign", fidelity: "source",
        op,
        target: liftExpr(target, lift),
        value: liftExpr(rhs.right, lift),
    };
}

function liftExpr(node, lift) {
    switch (node.kind) {
        case ts.SyntaxKind.NumericLiteral: {
            const t = node.getText();
            // Radix-prefixed literals (0x.../0b.../0o...) are always integers
            // and never carry a fraction/exponent, yet their digits can
            // legitimately contain e/E (hex) or b (binary marker). Classify
            // them as integer up front so the decimal float heuristic below
            // does not misread `0xE1` / `0xBEEF` as a float.
            return /^0[xXbBoO]/.test(t)
                ? lit("integer", t)
                : /[.eE]/.test(t)
                    ? lit("float", t)
                    : lit("integer", t);
        }
        case ts.SyntaxKind.BigIntLiteral:
            return lit("integer", node.getText().replace(/n$/, ""));
        case ts.SyntaxKind.StringLiteral:
        case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
            return lit("string", node.text);
        case ts.SyntaxKind.TrueKeyword:
            return lit("boolean", "true");
        case ts.SyntaxKind.FalseKeyword:
            return lit("boolean", "false");
        case ts.SyntaxKind.Identifier:
            return { kind: "varref", fidelity: "source", name: node.text };
        case ts.SyntaxKind.ParenthesizedExpression:
            return liftExpr(node.expression, lift);
        case ts.SyntaxKind.PrefixUnaryExpression: {
            let op;
            if (node.operator === ts.SyntaxKind.MinusToken) op = "negate";
            else if (node.operator === ts.SyntaxKind.ExclamationToken) op = "not";
            else if (node.operator === ts.SyntaxKind.TildeToken) op = "bitnot";
            else if (node.operator === ts.SyntaxKind.PlusPlusToken) op = "preincrement";
            else if (node.operator === ts.SyntaxKind.MinusMinusToken) op = "predecrement";
            else {
                lift.note(`prefix operator ${ts.SyntaxKind[node.operator]}`);
                return unsupportedExpr("prefix unary");
            }
            return {
                kind: "unaryop", fidelity: "source", op,
                operand: liftExpr(node.operand, lift),
            };
        }
        case ts.SyntaxKind.PostfixUnaryExpression: {
            const op = node.operator === ts.SyntaxKind.PlusPlusToken
                ? "postincrement" : "postdecrement";
            return {
                kind: "unaryop", fidelity: "source", op,
                operand: liftExpr(node.operand, lift),
            };
        }
        case ts.SyntaxKind.BinaryExpression: {
            const k = node.operatorToken.kind;
            if (k === ts.SyntaxKind.EqualsToken) {
                // The Model has no plain assignment-expression node, only
                // CompoundAssign. A self-update `x = x <op> rhs` (the common
                // for-incrementor / accumulator shape) is exactly `x <op>= rhs`
                // and lowers faithfully. Anything else genuinely cannot be
                // represented as an expression — record honestly.
                const lowered = lowerSelfAssign(node, lift);
                if (lowered) return lowered;
                lift.note("assignment used as expression");
                return unsupportedExpr("assignment expression");
            }
            if (COMPOUND[k] !== undefined) {
                return {
                    kind: "compoundassign", fidelity: "source",
                    op: COMPOUND[k],
                    target: liftExpr(node.left, lift),
                    value: liftExpr(node.right, lift),
                };
            }
            const op = BINOP[k];
            if (op === undefined) {
                lift.note(`binary operator ${ts.SyntaxKind[k]}`);
                return unsupportedExpr("binary operator");
            }
            return {
                kind: "binaryop", fidelity: "source", op,
                lhs: liftExpr(node.left, lift),
                rhs: liftExpr(node.right, lift),
            };
        }
        case ts.SyntaxKind.ConditionalExpression:
            return {
                kind: "ternary", fidelity: "source",
                condition: liftExpr(node.condition, lift),
                trueExpr: liftExpr(node.whenTrue, lift),
                falseExpr: liftExpr(node.whenFalse, lift),
            };
        case ts.SyntaxKind.CallExpression: {
            const args = node.arguments.map((a) => liftExpr(a, lift));
            const callee = node.expression;
            // CallExpr.callee is a plain string in the wire format; method
            // calls collapse to "obj.method" textual callee.
            return {
                kind: "call", fidelity: "source",
                callee: callee.getText(),
                args,
            };
        }
        case ts.SyntaxKind.PropertyAccessExpression:
            return {
                kind: "memberaccess", fidelity: "source",
                object: liftExpr(node.expression, lift),
                member: node.name.getText(),
            };
        case ts.SyntaxKind.ElementAccessExpression:
            return {
                kind: "index", fidelity: "source",
                object: liftExpr(node.expression, lift),
                index: liftExpr(node.argumentExpression, lift),
            };
        case ts.SyntaxKind.AsExpression:
        case ts.SyntaxKind.TypeAssertionExpression:
        case ts.SyntaxKind.NonNullExpression:
            // Type-only wrappers carry no runtime semantics — pass through.
            return liftExpr(node.expression, lift);
        case ts.SyntaxKind.AwaitExpression:
            lift.note("await expression");
            return unsupportedExpr("await");
        case ts.SyntaxKind.ArrowFunction:
        case ts.SyntaxKind.FunctionExpression:
            lift.note("inline function/closure expression");
            return unsupportedExpr("closure");
        default:
            lift.note(`expression '${ts.SyntaxKind[node.kind]}'`);
            return unsupportedExpr(ts.SyntaxKind[node.kind]);
    }
}

// ---------------------------------------------------------------------------
// Statement lift — lowercase "kind" per stmtKindFromStr().
// ---------------------------------------------------------------------------

function liftBlock(block, lift) {
    const out = [];
    for (const s of block.statements) out.push(liftStmt(s, lift));
    return out;
}

function liftStmt(node, lift) {
    switch (node.kind) {
        case ts.SyntaxKind.VariableStatement: {
            const decls = node.declarationList.declarations;
            if (decls.length !== 1) {
                lift.note("multi-binding variable declaration");
                return exprStmtUnsupported("multi-binding var");
            }
            const d = decls[0];
            if (!ts.isIdentifier(d.name)) {
                lift.note("destructuring declaration");
                return exprStmtUnsupported("destructuring");
            }
            const stmt = {
                kind: "vardecl", fidelity: "source",
                type: typeFromNode(d.type, lift),
                name: d.name.text,
            };
            if (d.initializer) stmt.init = liftExpr(d.initializer, lift);
            return stmt;
        }
        case ts.SyntaxKind.ExpressionStatement: {
            const e = node.expression;
            if (ts.isBinaryExpression(e) &&
                e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                return {
                    kind: "assign", fidelity: "source",
                    target: liftExpr(e.left, lift),
                    value: liftExpr(e.right, lift),
                };
            }
            return {
                kind: "exprstmt", fidelity: "source",
                expr: liftExpr(e, lift),
            };
        }
        case ts.SyntaxKind.ReturnStatement: {
            const s = { kind: "return", fidelity: "source" };
            if (node.expression) s.value = liftExpr(node.expression, lift);
            return s;
        }
        case ts.SyntaxKind.IfStatement: {
            const s = {
                kind: "if", fidelity: "source",
                condition: liftExpr(node.expression, lift),
                thenBody: liftBranch(node.thenStatement, lift),
            };
            if (node.elseStatement) {
                s.elseBody = ts.isIfStatement(node.elseStatement)
                    ? [liftStmt(node.elseStatement, lift)]
                    : liftBranch(node.elseStatement, lift);
            }
            return s;
        }
        case ts.SyntaxKind.ForStatement: {
            const s = { kind: "for", fidelity: "source" };
            if (node.initializer) {
                s.init = ts.isVariableDeclarationList(node.initializer)
                    ? liftStmt(
                        ts.factory.createVariableStatement(
                            undefined, node.initializer),
                        lift)
                    : {
                        kind: "exprstmt", fidelity: "source",
                        expr: liftExpr(node.initializer, lift),
                    };
            }
            if (node.condition) s.condition = liftExpr(node.condition, lift);
            if (node.incrementor) s.increment = liftExpr(node.incrementor, lift);
            s.body = liftBranch(node.statement, lift);
            return s;
        }
        case ts.SyntaxKind.WhileStatement:
            return {
                kind: "while", fidelity: "source",
                condition: liftExpr(node.expression, lift),
                body: liftBranch(node.statement, lift),
            };
        case ts.SyntaxKind.BreakStatement:
            return { kind: "break", fidelity: "source" };
        case ts.SyntaxKind.ContinueStatement:
            return { kind: "continue", fidelity: "source" };
        case ts.SyntaxKind.Block:
            // A bare nested block — flatten into its statements is wrong for
            // scoping, so wrap as an if(true) is also wrong; the harness
            // never produces this, so record honestly.
            lift.note("bare nested block");
            return exprStmtUnsupported("nested block");
        default:
            lift.note(`statement '${ts.SyntaxKind[node.kind]}'`);
            return exprStmtUnsupported(ts.SyntaxKind[node.kind]);
    }
}

function liftBranch(node, lift) {
    if (ts.isBlock(node)) return liftBlock(node, lift);
    return [liftStmt(node, lift)];
}

function exprStmtUnsupported(desc) {
    return {
        kind: "exprstmt", fidelity: "inferred",
        expr: unsupportedExpr(desc),
    };
}

// ---------------------------------------------------------------------------
// Module traversal — collect functions by qualified name. The .topo
// declaration keys symbols with "::" namespace separators (SemanticAnalyzer),
// so a function inside `namespace a { namespace b { ... } }` is keyed
// "a::b::fn" to match what TranspileDriver sends in `request.functions`.
// ---------------------------------------------------------------------------

function collectFunctions(sourceFile) {
    const collected = new Map();

    function visit(node, ns) {
        if (ts.isModuleDeclaration(node) && node.body &&
            ts.isModuleBlock(node.body)) {
            const childNs = ns.concat(node.name.getText());
            for (const s of node.body.statements) visit(s, childNs);
            return;
        }
        if (ts.isFunctionDeclaration(node) && node.name && node.body) {
            const qname = ns.concat(node.name.text).join("::");
            collected.set(qname, node);
            return;
        }
        if (ts.isClassDeclaration(node) && node.name) {
            const childNs = ns.concat(node.name.text);
            for (const m of node.members) {
                if (ts.isMethodDeclaration(m) && m.name && m.body) {
                    const qname = childNs.concat(m.name.getText()).join("::");
                    collected.set(qname, m);
                }
            }
            return;
        }
    }

    for (const s of sourceFile.statements) visit(s, []);
    return collected;
}

// ---------------------------------------------------------------------------
// Type collection — class / interface declarations lift into TranspileType
// entries so cross-language transpile (e.g. TS source → Java target) can
// carry the inheritance hierarchy. The .topo declaration syntax does not
// distinguish class from interface; the discriminator is recorded only in
// baseClassKinds so language-specific emitters (Java: `extends` vs
// `implements`; TS/V8Codegen: same) can place each base precisely.
// ---------------------------------------------------------------------------

// Translate a TS `typeParameters` clause into the wire-format templateParams
// array. Captures `<T extends Bound>` as the wire `bound: TypeNode` and
// `<T = X>` (legal on classes, interfaces, and functions in TS) as
// `default: TypeNode`. The default TypeNode passes through `typeFromNode`
// so qualified / parameterised defaults (`Box<number>`) round-trip into
// V8Codegen. ownerLabel is retained for future downgrade notes on
// unsupported shapes (no current call-site routes default to it).
function liftTypeParams(tps, lift, _ownerLabel) {
    const out = [];
    if (!tps) return out;
    for (const tp of tps) {
        const entry = { kind: "type", name: tp.name.text };
        if (tp.constraint) {
            // Intersection `<T extends A & B>` surfaces as IntersectionType
            // on the AST. The wire `bounds: [TypeNode]` carries each branch
            // in source order; single-bound stays on the legacy `bound`.
            if (tp.constraint.kind === ts.SyntaxKind.IntersectionType) {
                entry.bounds = tp.constraint.types.map(
                    (t) => typeFromNode(t, lift));
            } else {
                entry.bound = typeFromNode(tp.constraint, lift);
            }
        }
        if (tp.default) {
            entry.default = typeFromNode(tp.default, lift);
        }
        out.push(entry);
    }
    return out;
}

// Build the heritage record `{ baseClasses, baseClassKinds }` for a class or
// interface declaration. Class declarations may have an `extends` clause
// (single class base, kind=class) and an `implements` clause (multiple
// interface bases, kind=interface). Interface declarations only have
// `extends` clauses whose targets are interfaces — the discriminator is
// `interface` for all of them, so a transpiled interface type carries no
// Class base and never produces a spurious `extends Base` downstream (same
// invariant the Java extractor guarantees).
function collectHeritage(decl, lift, isInterface) {
    const baseClasses = [];
    const baseClassKinds = [];
    const clauses = decl.heritageClauses;
    if (!clauses) return { baseClasses, baseClassKinds };
    for (const clause of clauses) {
        const isExtends = clause.token === ts.SyntaxKind.ExtendsKeyword;
        // For an interface declaration, `extends` parents are interfaces;
        // for a class declaration, `extends` is a single class, `implements`
        // is an interface list.
        const kind = isInterface ? "interface" : (isExtends ? "class" : "interface");
        for (const t of clause.types) {
            // t is ExpressionWithTypeArguments — wrap into a TypeReference-like
            // shape for typeFromNode. The expression text is the type name;
            // typeArguments carry generic instantiation.
            const name = t.expression ? t.expression.getText() : t.getText();
            const node = { nameParts: [name] };
            // Carry generic instantiation when present (e.g. `extends Box<T>`).
            if (t.typeArguments && t.typeArguments.length > 0) {
                node.templateArgs = t.typeArguments.map((a) => typeFromNode(a, lift));
            }
            baseClasses.push(node);
            baseClassKinds.push(kind);
        }
    }
    return { baseClasses, baseClassKinds };
}

// Lift class instance/static fields. TS `PropertyDeclaration` is
// straightforward; type annotation passes through `typeFromNode`. Method
// signatures, accessors, constructors, and index signatures are intentionally
// ignored — only data fields carry into TranspileType.fields, matching the
// Java extractor's convention.
function liftClassFields(members, lift) {
    const out = [];
    for (const m of members) {
        if (ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name)) {
            out.push({
                type: typeFromNode(m.type, lift),
                name: m.name.text,
                fidelity: "source",
            });
        }
    }
    return out;
}

// Interface members are PropertySignature (no body, just `name: T`). Method
// signatures are ignored — interfaces lift to TranspileType.fields only.
function liftInterfaceFields(members, lift) {
    const out = [];
    for (const m of members) {
        if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name)) {
            out.push({
                type: typeFromNode(m.type, lift),
                name: m.name.text,
                fidelity: "source",
            });
        }
    }
    return out;
}

function collectTypes(sourceFile) {
    const collected = [];

    function visit(node, ns) {
        if (ts.isModuleDeclaration(node) && node.body &&
            ts.isModuleBlock(node.body)) {
            const childNs = ns.concat(node.name.getText());
            for (const s of node.body.statements) visit(s, childNs);
            return;
        }
        if (ts.isClassDeclaration(node) && node.name) {
            const lift = new FnLift();
            const qname = ns.concat(node.name.text).join("::");
            const { baseClasses, baseClassKinds } = collectHeritage(node, lift, false);
            const templateParams = liftTypeParams(node.typeParameters, lift, `class '${node.name.text}'`);
            const fields = liftClassFields(node.members, lift);
            collected.push({
                qualifiedName: qname,
                fields,
                baseClasses,
                baseClassKinds,
                templateParams,
                fidelity: lift.fidelity(),
            });
            return;
        }
        if (ts.isInterfaceDeclaration(node) && node.name) {
            const lift = new FnLift();
            const qname = ns.concat(node.name.text).join("::");
            const { baseClasses, baseClassKinds } = collectHeritage(node, lift, true);
            const templateParams = liftTypeParams(node.typeParameters, lift, `interface '${node.name.text}'`);
            const fields = liftInterfaceFields(node.members, lift);
            collected.push({
                qualifiedName: qname,
                fields,
                baseClasses,
                baseClassKinds,
                templateParams,
                fidelity: lift.fidelity(),
            });
            return;
        }
    }

    for (const s of sourceFile.statements) visit(s, []);
    return collected;
}

// Serialize a TranspileType entry to the JSON shape the topo-core
// deserializer expects. Empty heritage / generics keys are omitted to keep
// pre-feature payloads byte-identical (same omit-when-empty idiom the C++
// and Java extractors follow).
function serializeType(t) {
    const out = {
        qualifiedName: t.qualifiedName,
        fields: t.fields,
        fidelity: t.fidelity,
    };
    if (t.baseClasses && t.baseClasses.length > 0) {
        out.baseClasses = t.baseClasses;
        out.baseClassKinds = t.baseClassKinds;
    }
    if (t.templateParams && t.templateParams.length > 0) {
        out.templateParams = t.templateParams;
    }
    return out;
}

function liftFunction(qname, decl) {
    const lift = new FnLift();
    const fn = {
        qualifiedName: qname,
        returnType: typeFromNode(decl.type, lift),
        params: [],
        body: [],
        unsupported: [],
        fidelity: "source",
    };

    for (const p of decl.parameters) {
        if (!ts.isIdentifier(p.name)) {
            lift.note("destructured parameter");
            fn.params.push({ name: "_arg", type: typeNode(["auto"]) });
            continue;
        }
        fn.params.push({
            name: p.name.text,
            type: typeFromNode(p.type, lift),
        });
    }

    if (decl.modifiers &&
        decl.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        lift.note("async function");
    }
    if (decl.typeParameters && decl.typeParameters.length > 0) {
        // Function-decl side mirrors liftTypeParams: captures
        // `<T extends Bound>` into the wire `bound` and `<T = X>` into
        // `default` (TS allows defaults on function type parameters).
        const tps = liftTypeParams(decl.typeParameters, lift, `function '${qname}'`);
        if (tps.length > 0) fn.templateParams = tps;
    }

    fn.body = liftBlock(decl.body, lift);
    fn.unsupported = lift.unsupported;
    fn.fidelity = lift.fidelity();
    return fn;
}

// ---------------------------------------------------------------------------
// Symbol extraction ("symbols" mode) — L1 host-symbol enumeration for
// topo-check. This walks the real `typescript` AST and must emit EXACTLY the
// exported symbols the regex TypeScriptSymbolExtractor emits, because the
// existing check fixtures are authored against exported-only output. See
// topo-v8/lib/Check/Extract/TypeScriptSymbolExtractor.cpp for the
// authoritative behaviour being reproduced here.
//
// Rules:
//   - export function F / export default function F  → Function (named only;
//     anonymous default is skipped).
//   - export class C → Class; each member MethodDeclaration → Method
//     (Constructor for ConstructorDeclaration). Only EXPORTED classes' members
//     are emitted; visibility from public/private/protected modifier (default
//     public); isStatic from the `static` modifier; enclosingClass = class
//     qualified name.
//   - export interface I → Interface. export type X = ... → TypeAlias.
//   - export const/let/var V → Variable; one symbol per declared identifier.
//   - export namespace/module N { ... } → the namespace itself is NOT emitted;
//     recurse into EXPORTED namespaces so inner symbols carry the `N.` prefix.
//   - export { A, B as C } → one Function per exported name (the alias).
//   - export * from "..." → emit nothing.
//   - CommonJS: module.exports.X = / exports.X = → emit X (Function);
//     module.exports = { A, B: c } → emit each object-literal property key.
//   - SKIP all ambient declarations: any node with the `declare` modifier and
//     the entire contents of `declare module "..." { ... }` string-named
//     module blocks.
//
// qualifiedName joins enclosing namespace + class names with `.` (DOT), then
// the simple name (e.g. `Outer.Inner.compute`, `Renderer.render`).
// ---------------------------------------------------------------------------

function hasModifier(node, kind) {
    return node.modifiers
        ? node.modifiers.some((m) => m.kind === kind)
        : false;
}

function isExported(node) {
    return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isDeclared(node) {
    return hasModifier(node, ts.SyntaxKind.DeclareKeyword);
}

function lineOf(node, sourceFile) {
    return sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile)).line + 1;
}

// Build `prefix.simple` where prefix is the enclosing namespace/class names
// joined with `.`. An empty prefix yields the bare simple name.
function qualify(prefix, simple) {
    return prefix ? `${prefix}.${simple}` : simple;
}

// Map a TS member modifier list to a "public" | "private" | "protected"
// visibility string (default "public", matching the regex extractor).
function memberVisibility(node) {
    if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return "private";
    if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return "protected";
    return "public";
}

// Emit Method/Constructor symbols for an EXPORTED class declaration.
function extractClassMembers(classNode, classQName, file, sourceFile, out) {
    for (const m of classNode.members) {
        if (ts.isConstructorDeclaration(m)) {
            out.push({
                qualifiedName: qualify(classQName, "constructor"),
                simpleName: "constructor",
                kind: "constructor",
                file,
                line: lineOf(m, sourceFile),
                enclosingClass: classQName,
                isStatic: false,
                visibility: memberVisibility(m),
            });
            continue;
        }
        if (ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name)) {
            out.push({
                qualifiedName: qualify(classQName, m.name.text),
                simpleName: m.name.text,
                kind: "method",
                file,
                line: lineOf(m, sourceFile),
                enclosingClass: classQName,
                isStatic: hasModifier(m, ts.SyntaxKind.StaticKeyword),
                visibility: memberVisibility(m),
            });
        }
    }
}

// `module.exports = { A, B: c }` — emit one Function per object-literal
// property key (the exported NAME, not the value identifier).
function extractCjsObjectLiteral(objExpr, file, sourceFile, line, out) {
    if (!ts.isObjectLiteralExpression(objExpr)) return;
    for (const prop of objExpr.properties) {
        let name = null;
        if (ts.isShorthandPropertyAssignment(prop) && prop.name) {
            name = prop.name.getText(sourceFile);
        } else if (ts.isPropertyAssignment(prop) && prop.name) {
            // Property key may be an Identifier or a string literal.
            name = ts.isStringLiteralLike(prop.name)
                ? prop.name.text
                : prop.name.getText(sourceFile);
        }
        if (name) {
            out.push({
                qualifiedName: name,
                simpleName: name,
                kind: "function",
                file,
                line,
                enclosingClass: "",
                isStatic: false,
                visibility: "public",
            });
        }
    }
}

// Handle a CommonJS `module.exports.X = ...` / `exports.X = ...` named-export
// expression statement. The whole-object `module.exports = {...}` form is
// handled separately by extractCjsBulkExport. Emits nothing otherwise.
function extractCjsExport(stmt, file, sourceFile, out) {
    if (!ts.isExpressionStatement(stmt)) return;
    const expr = stmt.expression;
    if (!ts.isBinaryExpression(expr) ||
        expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        return;
    }
    const lhs = expr.left;
    if (!ts.isPropertyAccessExpression(lhs) || !lhs.name) return;

    const obj = lhs.expression;
    // `module.exports.X = ...` — obj is the PropertyAccess `module.exports`.
    const isModuleExports =
        ts.isPropertyAccessExpression(obj) &&
        ts.isIdentifier(obj.expression) && obj.expression.text === "module" &&
        obj.name.text === "exports";
    // `exports.X = ...` — obj is the bare identifier `exports`.
    const isBareExports =
        ts.isIdentifier(obj) && obj.text === "exports";
    // Reject `module.exports = ...` itself (handled by the bulk form): there
    // `lhs` is `module.exports`, whose object is the identifier `module`.
    if (!isModuleExports && !isBareExports) return;

    const name = lhs.name.text;
    out.push({
        qualifiedName: name,
        simpleName: name,
        kind: "function",
        file,
        line: lineOf(stmt, sourceFile),
        enclosingClass: "",
        isStatic: false,
        visibility: "public",
    });
}

// `module.exports = { ... }` whole-object form. lhs is the PropertyAccess
// `module.exports`; this is checked separately from the `.X =` form above.
function extractCjsBulkExport(stmt, file, sourceFile, out) {
    if (!ts.isExpressionStatement(stmt)) return;
    const expr = stmt.expression;
    if (!ts.isBinaryExpression(expr) ||
        expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        return;
    }
    const lhs = expr.left;
    if (ts.isPropertyAccessExpression(lhs) &&
        ts.isIdentifier(lhs.expression) && lhs.expression.text === "module" &&
        lhs.name.text === "exports") {
        extractCjsObjectLiteral(
            expr.right, file, sourceFile, lineOf(stmt, sourceFile), out);
    }
}

// Walk one statement during symbol extraction. `nsPrefix` is the enclosing
// namespace/class qualified-name prefix (dot-joined), "" at module scope.
function extractFromStatement(stmt, nsPrefix, file, sourceFile, out) {
    // Ambient declarations (`declare ...`) carry no host implementation.
    if (isDeclared(stmt)) {
        return;
    }

    // export function F / export default function F
    if (ts.isFunctionDeclaration(stmt)) {
        if (!isExported(stmt)) return;
        if (!stmt.name) return; // anonymous default → skip
        const simple = stmt.name.text;
        out.push({
            qualifiedName: qualify(nsPrefix, simple),
            simpleName: simple,
            kind: "function",
            file,
            line: lineOf(stmt, sourceFile),
            enclosingClass: "",
            isStatic: false,
            visibility: "public",
        });
        return;
    }

    // export class C
    if (ts.isClassDeclaration(stmt)) {
        if (!isExported(stmt) || !stmt.name) return;
        const simple = stmt.name.text;
        const classQName = qualify(nsPrefix, simple);
        out.push({
            qualifiedName: classQName,
            simpleName: simple,
            kind: "class",
            file,
            line: lineOf(stmt, sourceFile),
            enclosingClass: "",
            isStatic: false,
            visibility: "public",
        });
        extractClassMembers(stmt, classQName, file, sourceFile, out);
        return;
    }

    // export interface I  → Interface
    // export type X = ... → TypeAlias
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
        if (!isExported(stmt) || !stmt.name) return;
        const simple = stmt.name.text;
        out.push({
            qualifiedName: qualify(nsPrefix, simple),
            simpleName: simple,
            kind: ts.isInterfaceDeclaration(stmt) ? "interface" : "typealias",
            file,
            line: lineOf(stmt, sourceFile),
            enclosingClass: "",
            isStatic: false,
            visibility: "public",
        });
        return;
    }

    // export const/let/var V  → Variable
    if (ts.isVariableStatement(stmt)) {
        if (!isExported(stmt)) return;
        for (const d of stmt.declarationList.declarations) {
            if (!d.name || !ts.isIdentifier(d.name)) continue;
            const simple = d.name.text;
            out.push({
                qualifiedName: qualify(nsPrefix, simple),
                simpleName: simple,
                kind: "variable",
                file,
                line: lineOf(stmt, sourceFile),
                enclosingClass: "",
                isStatic: false,
                visibility: "public",
            });
        }
        return;
    }

    // export namespace/module N { ... }
    if (ts.isModuleDeclaration(stmt)) {
        // `declare module "..."` (string-named ambient module) is skipped
        // wholesale: `isDeclared` above already filters it, but a plain
        // string-named module with no `declare` is also an ambient form.
        if (ts.isStringLiteral(stmt.name)) return;
        if (!isExported(stmt)) return; // only recurse into EXPORTED namespaces
        if (!stmt.body || !ts.isModuleBlock(stmt.body)) return;
        const childPrefix = qualify(nsPrefix, stmt.name.text);
        for (const inner of stmt.body.statements) {
            extractFromStatement(inner, childPrefix, file, sourceFile, out);
        }
        return;
    }

    // export { A, B as C }  and  export * from "..."
    if (ts.isExportDeclaration(stmt)) {
        // export * from "..."  → exportClause is undefined → emit nothing.
        if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) {
            return;
        }
        const line = lineOf(stmt, sourceFile);
        for (const spec of stmt.exportClause.elements) {
            // spec.name is the exported (aliased) name; spec.propertyName is
            // the original local name when `B as C` is used.
            const exported = spec.name.text;
            out.push({
                qualifiedName: qualify(nsPrefix, exported),
                simpleName: exported,
                kind: "function",
                file,
                line,
                enclosingClass: "",
                isStatic: false,
                visibility: "public",
            });
        }
        return;
    }

    // CommonJS export expression statements.
    if (ts.isExpressionStatement(stmt)) {
        extractCjsExport(stmt, file, sourceFile, out);
        extractCjsBulkExport(stmt, file, sourceFile, out);
        return;
    }
}

function extractSymbols(files) {
    const fsMod = globalThis.__topoFs;
    const symbols = [];
    for (const file of files) {
        let source;
        try {
            source = fsMod.readFileSync(file, "utf8");
        } catch (e) {
            // A file that cannot be read contributes no symbols; the C++
            // side surfaces missing-file conditions via its own collector.
            process.stderr.write(
                `topo-extract-typescript: cannot read ${file}: ${e.message}\n`);
            continue;
        }
        const sf = ts.createSourceFile(
            file, source, ts.ScriptTarget.ES2022, /*setParentNodes*/ true);
        for (const stmt of sf.statements) {
            extractFromStatement(stmt, "", file, sf, symbols);
        }
    }
    return { symbols };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runSymbolsMode(request) {
    const files = Array.isArray(request.files) ? request.files : [];
    const fs = await import("node:fs");
    globalThis.__topoFs = fs;
    const result = extractSymbols(files);
    process.stdout.write(JSON.stringify(result));
}

async function main() {
    const input = await readStdin();
    let request;
    try {
        request = JSON.parse(input);
    } catch (err) {
        process.stderr.write(
            `topo-extract-typescript: invalid JSON request: ${err.message}\n`);
        process.exit(1);
    }

    // Mode dispatch: `mode === "symbols"` runs L1 symbol extraction;
    // anything else (including an absent `mode`) keeps the transpile
    // behaviour unchanged for back-compat with TranspileDriver.
    if (request.mode === "symbols") {
        await runSymbolsMode(request);
        return;
    }

    const files = Array.isArray(request.files) ? request.files : [];
    const requested = new Set(
        Array.isArray(request.functions) ? request.functions : []);

    const fs = await import("node:fs");
    const functions = [];
    const types = [];
    const fatal = [];

    for (const file of files) {
        let source;
        try {
            source = fs.readFileSync(file, "utf8");
        } catch (e) {
            fatal.push(`cannot read ${file}: ${e.message}`);
            continue;
        }
        const sf = ts.createSourceFile(
            file, source, ts.ScriptTarget.ES2022, /*setParentNodes*/ true);
        const diags = sf.parseDiagnostics ?? [];
        if (diags.length > 0) {
            const msg = diags
                .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
                .join("; ");
            fatal.push(`parse error in ${file}: ${msg}`);
            continue;
        }

        const collected = collectFunctions(sf);
        for (const [qname, decl] of collected) {
            if (requested.size > 0 && !requested.has(qname)) continue;
            functions.push(liftFunction(qname, decl));
        }

        // Types are always collected (the .topo declaration owns the
        // requested-symbols set for FUNCTIONS only; cross-language transpile
        // needs the full type catalog so referenced bases resolve). Matches
        // the Java/C++ extractor pattern of always emitting the full
        // module.types array.
        for (const t of collectTypes(sf)) {
            types.push(t);
        }
    }

    // A declared symbol with no recoverable body is a contract breach: refuse
    // rather than emit a partial Model the caller can't tell is incomplete.
    if (requested.size > 0) {
        const got = new Set(functions.map((f) => f.qualifiedName));
        for (const want of requested) {
            if (!got.has(want)) {
                fatal.push(`declared symbol '${want}' not found in sources`);
            }
        }
    }

    if (fatal.length > 0) {
        for (const m of fatal) {
            process.stderr.write(`topo-extract-typescript: ${m}\n`);
        }
        process.exit(1);
    }

    const module = { types: types.map(serializeType), functions };
    process.stdout.write(JSON.stringify(module));
}

main().catch((err) => {
    process.stderr.write(`topo-extract-typescript: ${err.stack || err}\n`);
    process.exit(1);
});
