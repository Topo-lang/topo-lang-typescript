add_executable(topo-build-typescript
    main.cpp
)
# TopoTypeScriptAnalysis PUBLIC-propagates topo::core::TopoCheck → TopoSema /
# TopoAnalysis; topo::core::TopoBuildLib PUBLIC-propagates TopoPlatform /
# TopoSema / topo::lang::TopoLang. topo::v8::TopoV8AstExtract brings the
# V8 AST extractors used by main.cpp.
target_link_libraries(topo-build-typescript PRIVATE
    TopoTypeScriptAnalysis
    topo::core::TopoBuildLib
    topo::v8::TopoV8AstExtract
    nlohmann_json::nlohmann_json
)
# main.cpp uses bare-name includes for the V8 extractor headers (e.g.
# "TypeScriptSymbolExtractor.h"); topo::v8::TopoV8AstExtract carries that
# include directory on its INTERFACE_INCLUDE_DIRECTORIES so no explicit
# include path is needed in standalone mode.
topo_set_compiler_flags(topo-build-typescript)
topo_apply_std_pch(topo-build-typescript)

install(TARGETS topo-build-typescript
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

# ── Node contract-pass staging (gated) ────────────────
# All three contract-pass tools (visibility-transform, containment-guard-
# transform, stage-assert-transform) are Node tools that import the
# `typescript` package. They live in topo-v8's source tree but aren't
# part of topo-v8's CMake install set today, so in standalone mode we
# need TOPO_V8_TOOLS_DIR to point at a tree that contains them (e.g.
# `…/topo-v8-split/tools/`). If not provided, the staging POST_BUILD step
# is skipped with a STATUS message and the related ts-tool-smoke tests
# are gated off in test/CMakeLists.txt.
#
# Gated additionally by the top-level Node toggle: when
# TOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR is OFF (or npm is missing)
# the staging is unconditionally skipped.
option(TOPO_LANG_TYPESCRIPT_REQUIRE_CONTRACT_PASSES
    "Fail configure if the contract-pass transforms cannot be staged (no silent skip)" OFF)

if(TOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR)
    set(TOPO_V8_TOOLS_DIR "" CACHE PATH
        "Directory containing the topo-v8 Node tools (visibility-transform, containment-guard-transform, stage-assert-transform). When set, topo-build-typescript stages and npm-installs each tool beside its binary.")

    if(TOPO_V8_TOOLS_DIR)
        set(_visTransformSrc ${TOPO_V8_TOOLS_DIR}/visibility-transform)
        set(_cgTransformSrc  ${TOPO_V8_TOOLS_DIR}/containment-guard-transform)
        set(_saTransformSrc  ${TOPO_V8_TOOLS_DIR}/stage-assert-transform)
        if(NOT (EXISTS ${_visTransformSrc} AND EXISTS ${_cgTransformSrc} AND EXISTS ${_saTransformSrc}))
            if(TOPO_LANG_TYPESCRIPT_REQUIRE_CONTRACT_PASSES)
                message(FATAL_ERROR
                    "topo-lang-typescript: TOPO_V8_TOOLS_DIR=${TOPO_V8_TOOLS_DIR} is missing one or "
                    "more of visibility-transform / containment-guard-transform / stage-assert-transform, "
                    "but TOPO_LANG_TYPESCRIPT_REQUIRE_CONTRACT_PASSES=ON — refusing to build with the "
                    "contract-pass transforms unverified.")
            endif()
            message(WARNING
                "topo-lang-typescript: TOPO_V8_TOOLS_DIR=${TOPO_V8_TOOLS_DIR} is "
                "missing one or more of visibility-transform / containment-guard-transform / "
                "stage-assert-transform. Skipping contract-pass staging.")
            set(TOPO_V8_TOOLS_DIR "")
        endif()
    endif()

    if(TOPO_V8_TOOLS_DIR)
        set(_visTransformDst $<TARGET_FILE_DIR:topo-build-typescript>/visibility-transform)
        set(_cgTransformDst  $<TARGET_FILE_DIR:topo-build-typescript>/containment-guard-transform)
        set(_saTransformDst  $<TARGET_FILE_DIR:topo-build-typescript>/stage-assert-transform)

        # Copy each transform tool next to the binary. The `npm install` that
        # populates each tool's node_modules/typescript is performed by the CI
        # workflow (a dedicated bash step after Build), not here: invoking
        # npm.cmd from a CMake POST_BUILD exits 127 on GHA windows-2022 inside
        # the nested cmd.exe / vcpkg applocal.ps1 wrapper. node_modules is only
        # needed at ctest time (the Node smoke tests `import 'typescript'`), so
        # a post-build install satisfies every consumer. Local/dev: run
        # `npm install --omit=dev --prefix <build-dir>/topo-build/<tool>` after
        # building (the ts-tool-smoke tests fail loudly without it).
        add_custom_command(TARGET topo-build-typescript POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                ${_visTransformSrc}
                ${_visTransformDst}
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                ${_cgTransformSrc}
                ${_cgTransformDst}
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                ${_saTransformSrc}
                ${_saTransformDst}
            COMMENT "Staging contract-pass tools (visibility, containment-guard, stage-assert)"
            VERBATIM
        )
        set(TOPO_LANG_TS_CONTRACT_PASSES_STAGED ON
            CACHE INTERNAL "Contract-pass transforms staged beside topo-build-typescript")
        message(STATUS "topo-lang-typescript: staging contract-pass transforms from ${TOPO_V8_TOOLS_DIR}")
    else()
        if(TOPO_LANG_TYPESCRIPT_REQUIRE_CONTRACT_PASSES)
            message(FATAL_ERROR
                "topo-lang-typescript: TOPO_V8_TOOLS_DIR not set but "
                "TOPO_LANG_TYPESCRIPT_REQUIRE_CONTRACT_PASSES=ON — refusing to build with "
                "contract-pass transforms unverified (set -DTOPO_V8_TOOLS_DIR=<path-to-topo-v8/tools>).")
        endif()
        set(TOPO_LANG_TS_CONTRACT_PASSES_STAGED OFF
            CACHE INTERNAL "Contract-pass transforms staged beside topo-build-typescript")
        message(STATUS "topo-lang-typescript: TOPO_V8_TOOLS_DIR not set — "
                       "contract-pass transform staging skipped "
                       "(set -DTOPO_V8_TOOLS_DIR=<path-to-topo-v8/tools> to enable).")
    endif()
else()
    if(TOPO_LANG_TYPESCRIPT_REQUIRE_CONTRACT_PASSES)
        message(FATAL_ERROR
            "topo-lang-typescript: TOPO_LANG_TYPESCRIPT_REQUIRE_CONTRACT_PASSES=ON but "
            "TOPO_LANG_TYPESCRIPT_ENABLE_NODE_EXTRACTOR is OFF — cannot stage contract-pass transforms.")
    endif()
    set(TOPO_LANG_TS_CONTRACT_PASSES_STAGED OFF
        CACHE INTERNAL "Contract-pass transforms staged beside topo-build-typescript")
endif()

# Node-level smoke tests for the 3 TS transform tools are registered in
# topo-lang-typescript/test/CMakeLists.txt (which is added after the
# top-level `enable_testing()` so add_test() calls take effect).
