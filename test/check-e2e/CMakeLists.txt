# Checker E2E suite (completeness + containment incl. the
# TypeScriptContainmentL2 deep cases + visibility + purity +
# stage-isolation + import-path + the AST-based L1 symbol-extractor e2e)
# — in its own file so a meta-style super-build can re-add it AFTER its
# topo-cli sibling configures (the inline add from ../CMakeLists.txt
# self-skips there: no topo::cli::TopoCheckRunner exists yet at
# lang-package configure time, and the meta puts no installed topo-cli
# on the prefix). Self-gating + idempotent: safe to add_subdirectory()
# twice — whichever pass first finds the runner defines the suite.
#
# MinGW note: ../CMakeLists.txt's dir-scoped static-link options reach
# this suite only via the inline path; a meta-late re-add lacks them
# (moot today — the meta build never runs on MinGW).

if(TARGET topo-lang-typescript-check-tests)
    return()
endif()

# TestMain.cpp must call topo::lang::registerTypeScriptPlugin() before
# tests run, so the suite cannot stand without the plugin. Defensive only
# — TopoTypeScriptPlugin builds unconditionally in every configure of
# this package.
if(NOT TARGET TopoTypeScriptPlugin)
    message(STATUS "topo-lang-typescript tests: checker-e2e suite "
                   "(topo-lang-typescript-check-tests) skipped — "
                   "TopoTypeScriptPlugin not in scope.")
    return()
endif()

# The suite links TopoCheckRunner + its CheckRunner.h, defined by topo-cli
# (topo::cli::TopoCheckRunner) — a package DOWNSTREAM of this one (a hard
# dependency would be a circular edge). Two paths in:
#   * meta build — topo-cli's in-tree alias satisfies the gate on the meta
#     root's late re-add of this dir;
#   * standalone — an installed topo-cli on CMAKE_PREFIX_PATH exports the
#     runner. This is what the verify-l2 CI job uses, so the tsserver L2
#     deep cases actually RUN on a public surface instead of being
#     meta-only.
if(NOT TARGET topo::cli::TopoCheckRunner)
    find_package(topo-cli CONFIG QUIET)
endif()
if(NOT TARGET topo::cli::TopoCheckRunner)
    message(STATUS "topo-lang-typescript tests: checker-e2e suite is gated off "
                   "in standalone mode (topo-cli config providing TopoCheckRunner "
                   "not on CMAKE_PREFIX_PATH).")
    return()
endif()

# Sources and fixtures stay in test/e2e + test/fixtures; anchor on this
# file's parent so both the inline and the meta-late add resolve them.
get_filename_component(_test_root "${CMAKE_CURRENT_SOURCE_DIR}" DIRECTORY)

add_executable(topo-lang-typescript-check-tests
    ${_test_root}/e2e/TestMain.cpp
    ${_test_root}/e2e/TypeScriptCompletenessTest.cpp
    ${_test_root}/e2e/TypeScriptContainmentTest.cpp
    ${_test_root}/e2e/TypeScriptVisibilityTest.cpp
    ${_test_root}/e2e/TypeScriptPurityTest.cpp
    ${_test_root}/e2e/TypeScriptStageIsolationTest.cpp
    ${_test_root}/e2e/TypeScriptImportPathTest.cpp
    ${_test_root}/e2e/TypeScriptASTSymbolExtractorTest.cpp
)
target_link_libraries(topo-lang-typescript-check-tests PRIVATE
    topo::cli::TopoCheckRunner TopoTypeScriptPlugin
    GTest::gtest
)
target_compile_definitions(topo-lang-typescript-check-tests PRIVATE
    TOPO_TEST_FIXTURES_DIR="${_test_root}/fixtures/check"
)
# Hand the test the staged topo-extract-typescript directory so
# TestMain.cpp can prepend it to PATH: the TypeScript check provider
# then resolves the AST-based L1 symbol extractor by bare name (the
# same contract the transpile path uses). Gating on
# topo-extract-typescript-stage ensures the launcher was staged before
# the test executes (node_modules is populated by `npm install` — the
# CI workflow's dedicated post-build step, or manually in local/dev
# builds). Without the staged tool the provider falls back to the
# regex extractor and the AST e2e suite emits a suite-level skip.
if(TARGET topo-build-typescript AND TARGET topo-extract-typescript-stage)
    target_compile_definitions(topo-lang-typescript-check-tests PRIVATE
        TOPO_EXTRACT_TS_TOOL_DIR="$<TARGET_FILE_DIR:topo-build-typescript>"
    )
    add_dependencies(topo-lang-typescript-check-tests topo-extract-typescript-stage)
endif()
topo_set_compiler_flags(topo-lang-typescript-check-tests)
# The L2 deep cases drive TsServerBridge — typescript-language-server
# must be on PATH or the suite emits a single suite-level GTEST_SKIP.
# TIMEOUT 180: each L2 case boots its own tsserver instance, which
# dominates the 60s default on CI runners.
gtest_discover_tests(topo-lang-typescript-check-tests
    DISCOVERY_TIMEOUT 30
    PROPERTIES LABELS "toolchain\;typescript\;checker\;lang-typescript" TIMEOUT 180)
