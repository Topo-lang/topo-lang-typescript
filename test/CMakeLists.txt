# topo-lang-typescript test suite (standalone).
#
# Mirrors topo-lang-python/test/CMakeLists.txt at smaller scale. The L1
# AST extractor + safe-catalog + V8 codegen tests run unconditionally;
# checker-e2e and functional-e2e suites require TopoCheckRunner /
# the `topo-build` CLI / E2eHarness.cpp — none of which are exported by
# topo-core today (deferred to a later cleanup of the topo-core split) —
# so they are skipped in standalone mode and continue to run from the
# monorepo / topo-cli once that repo lifts.

# MinGW on GHA: cached upstream topo-install may have been linked against
# a different libstdc++/libgcc ABI than C:\mingw64\bin\ currently provides,
# tripping STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) when gtest_discover_tests
# launches each binary. Static-link the C++ runtime for every test exe in
# this directory so they're hermetic.
if(MINGW)
    add_link_options(-static -static-libgcc -static-libstdc++)
endif()

# --- Unit tests: L1 extractor fidelity on inline fixtures ---
add_executable(topo-lang-typescript-tests
    unit/TestMain.cpp
    unit/TypeScriptAnalysisProviderTest.cpp
    unit/TypeScriptSymbolExtractorTest.cpp
    unit/TypeScriptImportExtractorTest.cpp
    unit/TypeScriptCallSiteExtractorTest.cpp
    unit/TypeScriptSafeCatalogTest.cpp
    unit/TypeScriptProviderFallbackNoticeTest.cpp
    unit/V8CodegenGenericsTest.cpp
)
# TopoTypeScriptPlugin PUBLIC-propagates TopoTypeScriptAnalysis directly,
# which in turn brings TsServer + V8 AST extract on its PUBLIC interface.
# topo::v8::Placeholder (re-exported by the plugin) covers V8Codegen.
target_link_libraries(topo-lang-typescript-tests PRIVATE
    TopoTypeScriptPlugin
    GTest::gtest
)
target_compile_definitions(topo-lang-typescript-tests PRIVATE
    TOPO_TS_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures/unit"
)
topo_set_compiler_flags(topo-lang-typescript-tests)
# DISCOVERY_TIMEOUT 30: the 5s default aborts a clean build when post-link
# test enumeration competes with concurrent link jobs and times out
# flakily. TIMEOUT is the per-test run cap; DISCOVERY_TIMEOUT is the
# enumeration cap.
gtest_discover_tests(topo-lang-typescript-tests
    DISCOVERY_TIMEOUT 30
    PROPERTIES LABELS "toolchain\;typescript\;lang-typescript" TIMEOUT 60)

# --- CLI input-trust unit tests (per-value backendExtras validation) ---
# Spawns topo-build-typescript with hand-crafted request JSON files and
# asserts the exit code + stderr label. Tool process is fast — validation
# fires before any extractor/transform subprocess is spawned.
#
# Previously Windows-skipped (every test timed out at 30s on GHA windows-2022,
# the MinGW-host subprocess hang). Fixed in topo-core (raw-Win32 capture) + the
# build-time gcc PATH-prepend in the Test step so the spawned MinGW tool loads.
if(TARGET topo-build-typescript)
    add_executable(topo-build-typescript-input-trust-tests
        unit/TypeScriptBackendExtrasInputTrustTest.cpp
    )
    target_link_libraries(topo-build-typescript-input-trust-tests PRIVATE
        topo::core::TopoPlatform
        nlohmann_json::nlohmann_json
        GTest::gtest_main
    )
    target_compile_definitions(topo-build-typescript-input-trust-tests PRIVATE
        TOPO_BUILD_TYPESCRIPT_EXE="$<TARGET_FILE:topo-build-typescript>"
    )
    add_dependencies(topo-build-typescript-input-trust-tests topo-build-typescript)
    topo_set_compiler_flags(topo-build-typescript-input-trust-tests)
    gtest_discover_tests(topo-build-typescript-input-trust-tests
        DISCOVERY_TIMEOUT 30
        PROPERTIES LABELS "toolchain\;typescript\;lang-typescript" TIMEOUT 30)
endif()

# --- Checker E2E tests ---
# Lives in check-e2e/ as a self-gating, idempotent file so a meta-style
# super-build can re-add it after its topo-cli sibling configures; see
# check-e2e/CMakeLists.txt for the gating rationale. This inline add
# covers the standalone path (installed topo-cli on CMAKE_PREFIX_PATH)
# and self-skips with a STATUS message otherwise.
add_subdirectory(check-e2e)

# --- Functional E2E tests ---
# Drives the real `topo-build` CLI against the fixtures/e2e projects:
# backend dispatch, integrated-check exit codes + diagnostics, and the
# transform / sidecar / runtime-witness pipeline. topo-build/topo-check
# are topo-cli targets — a package DOWNSTREAM of this one — so the same
# two paths as the checker-e2e suite apply: in a super-build
# (NOT PROJECT_IS_TOP_LEVEL) the bare sibling targets resolve at
# generate time even though topo-cli configures later; standalone, an
# installed topo-cli on CMAKE_PREFIX_PATH provides the imported
# topo::cli:: executables (the verify-l2 CI job's path). The transform
# fixtures additionally need the staged Node contract-pass tools, so the
# suite shares the ts-tool-smoke gate (TOPO_LANG_TS_CONTRACT_PASSES_STAGED).
set(_func_topo_build "")
set(_func_topo_check "")
if(NOT PROJECT_IS_TOP_LEVEL)
    set(_func_topo_build topo-build)
    set(_func_topo_check topo-check)
else()
    if(NOT TARGET topo::cli::topo-build)
        find_package(topo-cli CONFIG QUIET)
    endif()
    if(TARGET topo::cli::topo-build)
        set(_func_topo_build topo::cli::topo-build)
        set(_func_topo_check topo::cli::topo-check)
    endif()
endif()
if(_func_topo_build AND TOPO_LANG_TS_CONTRACT_PASSES_STAGED AND TARGET topo-build-typescript)
    add_executable(topo-lang-typescript-functional-tests
        e2e/TypeScriptFunctionalTests.cpp
    )
    target_link_libraries(topo-lang-typescript-functional-tests PRIVATE
        topo::core::TopoPlatform
        nlohmann_json::nlohmann_json
        GTest::gtest_main
    )
    # TOPO_FUNC_E2E_TOOL_DIRS is ';'-separated (split at runtime): the
    # fixture prepends both dirs to PATH so topo-build resolves its
    # backend (topo-build-typescript) and the integrated-check topo-check
    # by bare name. $<SEMICOLON> keeps the list intact through the
    # COMPILE_DEFINITIONS property.
    target_compile_definitions(topo-lang-typescript-functional-tests PRIVATE
        TOPO_BUILD_EXE="$<TARGET_FILE:${_func_topo_build}>"
        TOPO_TS_E2E_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures/e2e"
        TOPO_FUNC_E2E_TOOL_DIRS="$<TARGET_FILE_DIR:topo-build-typescript>$<SEMICOLON>$<TARGET_FILE_DIR:${_func_topo_check}>"
    )
    add_dependencies(topo-lang-typescript-functional-tests topo-build-typescript)
    topo_set_compiler_flags(topo-lang-typescript-functional-tests)
    gtest_discover_tests(topo-lang-typescript-functional-tests
        DISCOVERY_TIMEOUT 30
        PROPERTIES LABELS "e2e\;functional\;lang-typescript" TIMEOUT 120)
else()
    message(STATUS "topo-lang-typescript tests: functional-e2e suite is gated off "
                   "(needs the topo-build CLI — super-build sibling or installed "
                   "topo-cli on CMAKE_PREFIX_PATH — plus staged contract-pass "
                   "transforms).")
endif()

# --- TS transform tool Node smoke tests ---
# Each tool ships its own smoke.test.mjs that drives the production tool via
# its JSON request/response protocol using node:test. Tests run against the
# build-dir tool copies (the POST_BUILD copies the tool sources; node_modules
# is installed by `npm install` — the CI workflow's dedicated post-build step,
# or manually in local/dev builds). Only run when contract-pass staging
# actually happened (TOPO_V8_TOOLS_DIR was provided) and the
# topo-extract-typescript launcher was staged.
if(TOPO_LANG_TS_CONTRACT_PASSES_STAGED AND TARGET topo-build-typescript)
    find_program(NODE_EXECUTABLE node REQUIRED
        DOC "node binary used to run TS transform tool smoke tests")
    foreach(_tool visibility-transform containment-guard-transform stage-assert-transform)
        add_test(
            NAME ts-tool-smoke.${_tool}
            COMMAND ${NODE_EXECUTABLE} --test smoke.test.mjs
            WORKING_DIRECTORY $<TARGET_FILE_DIR:topo-build-typescript>/${_tool}
        )
        set_tests_properties(ts-tool-smoke.${_tool} PROPERTIES
            LABELS "toolchain;typescript;ts-tool-smoke" TIMEOUT 60)
    endforeach()
endif()

if(TARGET topo-extract-typescript-stage AND TARGET topo-build-typescript)
    find_program(NODE_EXECUTABLE node REQUIRED
        DOC "node binary used to run TS transform tool smoke tests")
    # topo-extract-typescript stages under a distinct dir name (it ships a
    # bare-name launcher beside topo-build-typescript, so the tool body lives
    # in a sibling subdir to avoid colliding with that launcher file).
    add_test(
        NAME ts-tool-smoke.topo-extract-typescript
        COMMAND ${NODE_EXECUTABLE} --test smoke.test.mjs
        WORKING_DIRECTORY
            $<TARGET_FILE_DIR:topo-build-typescript>/topo-extract-typescript-tool
    )
    set_tests_properties(ts-tool-smoke.topo-extract-typescript PROPERTIES
        LABELS "toolchain;typescript;ts-tool-smoke" TIMEOUT 60)
endif()

# --- _toolchain.mjs resolution unit tests (no real toolchain needed) ---
# Stages fake binaries in temp dirs and pins every resolution tier
# (TOPO_BIN_DIR flat/nested/multi-config, PATH, strict-override raise),
# including the Windows story (.exe suffix + PATHEXT executability) on
# the windows-2022 lane — previously the mjs locator had no automated
# surface on any OS.
find_program(NODE_EXECUTABLE node)
if(NODE_EXECUTABLE)
    add_test(
        NAME ts-toolchain-resolution
        COMMAND ${NODE_EXECUTABLE} --test test_toolchain_resolution.test.mjs
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/../runtime/test
    )
    set_tests_properties(ts-toolchain-resolution PROPERTIES
        LABELS "toolchain;typescript" TIMEOUT 60)
endif()
