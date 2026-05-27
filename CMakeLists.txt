cmake_minimum_required(VERSION 3.20)

project(topo-lang-typescript
    VERSION 0.1.0
    DESCRIPTION "Topo TypeScript language support — check, build orchestrator, plugin, V8-family glue, init templates"
    HOMEPAGE_URL "https://github.com/topo-lang/topo-lang-typescript"
    LANGUAGES CXX
)

# topo-lang-typescript: TypeScript language support.
#
# Layering:
#   - C++ libs (analysis, runner, init, plugin) and the C++ topo-build-typescript
#     orchestrator ship by default; they need topo-core + topo-lang + topo-v8
#     (V8-family shared infrastructure: TsServerBridge, V8Codegen, AST check
#     primitives, source-code transforms) plus a host C++ compiler.
#   - The runtime payload (runtime/ — currently a README placeholder; the npm
#     package ships later), the Node-implemented topo-extract-typescript +
#     contract-pass transforms (visibility / containment-guard / stage-assert),
#     and the topo-debug-typescript launcher are all staged at build time and
#     interpreted at runtime by Node.js.
#   - L2 deep containment requires `typescript-language-server` at runtime
#     (exactly as C++ L2 needs `clangd`); L1 falls back to the regex
#     `TypeScriptSymbolExtractor` (lives in topo-v8) when L2 is unavailable.
#
# Build-time Node tooling (npm install of the staged transforms, AST
# extractor staging) is gated behind TOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR.
# When npm/node is on PATH the gate defaults ON (matches Python's widest-
# install philosophy); on hosts without npm the gate must be flipped OFF
# to skip the staging steps. The pure-C++ analysis / plugin / build
# orchestrator always ships.
#
# TypeScript has no LLVM or JVM backend coupling, so there is no
# TOPO_LANG_TYPESCRIPT_ENABLE_<backend> gate beyond the Node one.

include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(TopoLangTypeScriptCompilerFlags)

# ── Upstream Topo packages ────────────────────────────
# Guards make this CMakeLists usable both standalone (find_package finds the
# installed config package) and as an add_subdirectory inside the meta-repo
# unified build (the targets already exist, so we skip the find_package).
if(NOT TARGET topo::core::TopoBasic)
    find_package(topo-core CONFIG REQUIRED)
endif()
if(NOT TARGET topo::lang::TopoLang)
    find_package(topo-lang CONFIG REQUIRED)
endif()
if(NOT TARGET topo::v8::Topov8Placeholder)
    find_package(topo-v8 CONFIG REQUIRED)
endif()

# ── External dependencies ─────────────────────────────
find_package(nlohmann_json CONFIG REQUIRED)

# ── Node tooling gate ─────────────────────────────────
# When ON, the build:
#   - stages topo-extract-typescript next to topo-build-typescript and runs
#     `npm install` to populate its node_modules
#   - stages the 3 contract-pass transforms (visibility/containment-guard/
#     stage-assert) next to topo-build-typescript and runs `npm install`
#     in each
#   - configures topo-debug-typescript (Node-DAP/CDP launcher) when Node >= 22
#     is found
#   - stages the topo-profile span-emitter fixture (Node script)
#
# Detect npm + node automatically; default the gate ON only if both are
# resolvable so a missing toolchain doesn't fail the build.
find_program(_TOPO_LANG_TS_NPM_PROBE  npm)
find_program(_TOPO_LANG_TS_NODE_PROBE node)
if(_TOPO_LANG_TS_NPM_PROBE AND _TOPO_LANG_TS_NODE_PROBE)
    set(_TOPO_LANG_TS_NODE_DEFAULT ON)
else()
    set(_TOPO_LANG_TS_NODE_DEFAULT OFF)
endif()
option(TOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR
    "Stage the Node-implemented topo-extract-typescript and source-rewriting transforms next to topo-build-typescript (requires npm + node on PATH)"
    ${_TOPO_LANG_TS_NODE_DEFAULT})

if(TOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR
    AND NOT (_TOPO_LANG_TS_NPM_PROBE AND _TOPO_LANG_TS_NODE_PROBE))
    message(FATAL_ERROR
        "TOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR is ON but npm/node was not "
        "found on PATH. Install Node.js (>= 22 for topo-debug-typescript) or "
        "configure with -DTOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR=OFF.")
endif()

message(STATUS "topo-lang-typescript: Node-coupled staging "
               "(extractor + 3 transforms + debug launcher + profile fixture) "
               "= ${TOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR}")

# ── Subdirs ───────────────────────────────────────────
# Order: analysis + runner + init + lang first, then topo-build (the executable
# whose binary dir hosts staged Node tools), then the gated Node-staging
# subdirs.
add_subdirectory(topo-check/analysis)
add_subdirectory(topo-check/runner)
add_subdirectory(topo-init)
add_subdirectory(topo-lang)
add_subdirectory(topo-build)

if(TOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR)
    # Staged after topo-build: the extractor + transform staging hangs off
    # topo-build-typescript's binary dir.
    add_subdirectory(topo-check/extractor)
    add_subdirectory(topo-debug)
    add_subdirectory(topo-profile)
endif()

# ── Tests ─────────────────────────────────────────────
option(TOPO_LANG_TYPESCRIPT_BUILD_TESTS "Build topo-lang-typescript tests" ON)
if(TOPO_LANG_TYPESCRIPT_BUILD_TESTS AND (PROJECT_IS_TOP_LEVEL OR TOPO_META_DRIVING_TESTS))
    enable_testing()
    include(FetchContent)
    FetchContent_Declare(googletest
        GIT_REPOSITORY https://github.com/google/googletest.git
        GIT_TAG v1.15.2)
    set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(googletest)
    include(GoogleTest)
    add_subdirectory(test)
endif()

# ── Install / export ──────────────────────────────────
install(EXPORT topo-lang-typescriptTargets
    FILE topo-lang-typescriptTargets.cmake
    NAMESPACE topo::lang-typescript::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/topo-lang-typescript
)

configure_package_config_file(
    ${CMAKE_CURRENT_SOURCE_DIR}/cmake/topo-lang-typescriptConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/topo-lang-typescriptConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/topo-lang-typescript
)

write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/topo-lang-typescriptConfigVersion.cmake
    VERSION       ${PROJECT_VERSION}
    COMPATIBILITY SameMajorVersion
)

install(FILES
    ${CMAKE_CURRENT_BINARY_DIR}/topo-lang-typescriptConfig.cmake
    ${CMAKE_CURRENT_BINARY_DIR}/topo-lang-typescriptConfigVersion.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/topo-lang-typescript
)
