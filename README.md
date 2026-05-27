# topo-lang-typescript -- TypeScript Language Support

TypeScript-specific thin shell over the V8-family shared infrastructure
in the [`topo-v8`](https://github.com/topo-lang/topo-v8) package.
`topo-build-typescript` is a self-contained check + declaration-
enforcement driver — no LLVM, no JVM. It runs the six .topo checks
against TS source and, when `[transforms.<name>]` is configured, shells
out to the corresponding Node tool shipped by `topo-v8` (under its
`tools/` tree) to rewrite host source for declaration enforcement
(currently just VisibilityPass).

New declaration-enforcement passes are added incrementally, one at a
time, as concrete need arises.

## Structure

Second-level directories are named after the `topo-<tool>` they serve.
Shared V8-family infrastructure (TsServerBridge, AST extractors, source
Codegen) lives in the `topo-v8` package — only TS-specific components
live here. Linked via `find_package(topo-v8 CONFIG REQUIRED)` →
`topo::v8::TopoV8TsServer` / `TopoV8AstExtract` / `TopoV8Codegen`.

| Directory | Serves | Purpose |
|-----------|--------|---------|
| runtime/ | — | Placeholder. Runtime ships as an npm package (not yet in repo). |
| topo-check/analysis/ | topo-check | TypeScriptAnalysisProvider + TS-specific catalog (safe patterns / unsafe catalog / safety analyzer). AST extractors are imported from `topo::v8::TopoV8AstExtract`. |
| topo-check/runner/ | topo-check | TypeScriptCheckRunner -- language-specific check orchestration |
| topo-build/ | topo-build | `topo-build-typescript` executable source — self-contained check-only build driver |
| topo-init/ | topo-init | TypeScript project template provider |
| topo-lang/ | topo-lang | TypeScriptPlugin -- registers all components with the language-plugin framework; constructs V8Codegen and TsServerBridge from the imported `topo::v8::*` targets |
| examples/ | — | quickstart project |

History — relocated to the `topo-v8` package (pre-split refactor):
- `topo-lsp/TsServerBridge` → `topo::v8::TopoV8TsServer`
- `topo-transpile/TypeScriptEmitter` → `topo::v8::TopoV8Codegen`
- `topo-check/analysis/extract/Typescript*Extractor` → `topo::v8::TopoV8AstExtract`

### Note on `topo-check/extractor/` (intentionally absent)

Unlike C++/Rust/Java/Python, TypeScript has no `topo-check/extractor/`
directory. L2 deep analysis is provided exclusively by the tsserver LSP
bridge in `topo-v8` (`topo::v8::TopoV8TsServer`), which already fronts
`typescript-language-server` + `typescript` — the same dependencies a
Node extractor subprocess would require. A second extractor path would
not be a weaker fallback, only duplication. A future transpile-from-
TypeScript capability will add a function-body extractor when the reverse
direction (TS → TranspileModel) lands; at that point the extractor will be
modeled on `topo-extract-python`, not on the deleted call-site scaffold.

## Build (standalone)

Requires upstream `topo-core`, `topo-lang`, and `topo-v8` installed to a
shared prefix, plus a vcpkg toolchain for `nlohmann_json` + `tomlplusplus`:

```bash
cmake -S . -B build -G Ninja \
    -DCMAKE_PREFIX_PATH=/path/to/topo-install \
    -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
    -DTOPO_LANG_TYPESCRIPT_BUILD_TESTS=ON
cmake --build build
ctest --test-dir build --output-on-failure --timeout 120
```

The Node-coupled staging (topo-extract-typescript launcher, three
contract-pass transforms beside `topo-build-typescript`, the
topo-debug-typescript launcher, the topo-profile fixture) is gated by
`TOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR` (auto-detected: ON when
both `npm` and `node` are on PATH). The contract-pass transforms also
need `-DTOPO_V8_TOOLS_DIR=<path-to-topo-v8/tools>`; without that, the
staging is skipped and the `ts-tool-smoke.*` ctests are gated off
(topo-v8's tools/ tree isn't part of its install set today).

L2 deep containment runs through `typescript-language-server`, which is
a runtime dependency rather than a build dependency. When that package
is not on PATH the analysis provider emits an explicit "L2 unavailable"
warning and L1 (AST-based via `topo-extract-typescript`, falling back
to the regex extractor in topo-v8) still runs.

## Downstream usage

```cmake
find_package(topo-lang-typescript CONFIG REQUIRED)
target_link_libraries(<tgt> PRIVATE topo::lang-typescript::TopoTypeScriptPlugin)
```

Exported targets:
- `topo::lang-typescript::TopoTypeScriptAnalysis`
- `topo::lang-typescript::TopoTypeScriptCheck`
- `topo::lang-typescript::TopoTypeScriptInit`
- `topo::lang-typescript::TopoTypeScriptPlugin`
