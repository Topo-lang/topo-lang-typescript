add_library(TopoTypeScriptAnalysis
    TypeScriptAnalysisProvider.cpp
    extract/TypeScriptASTSymbolExtractor.cpp
    catalog/TypeScriptSafePatterns.cpp
    catalog/TypeScriptUnsafeCatalog.cpp
    catalog/TypeScriptSafetyAnalyzer.cpp
)
add_library(topo::lang-typescript::TopoTypeScriptAnalysis ALIAS TopoTypeScriptAnalysis)

find_path(TOMLPLUSPLUS_INCLUDE_DIR toml++/toml.hpp REQUIRED)

target_include_directories(TopoTypeScriptAnalysis
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
        $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}/topo-lang-typescript/topo-check/analysis>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/catalog
        ${TOMLPLUSPLUS_INCLUDE_DIR}
)
# topo::core::TopoCheck propagates topo-core headers; topo::v8::TopoV8TsServer
# brings TsServerBridge.h on its INTERFACE_INCLUDE_DIRECTORIES; topo::v8::
# TopoV8AstExtract brings the V8 AST extractors. TopoCheck links TopoPlatform
# PRIVATE (not propagated), so the AST extractor — which spawns
# topo-extract-typescript via platform::PipedProcess and parses its JSON
# reply — needs TopoPlatform and nlohmann_json linked explicitly here.
target_link_libraries(TopoTypeScriptAnalysis
    PUBLIC
        topo::core::TopoCheck
        topo::v8::TopoV8TsServer
        topo::v8::TopoV8AstExtract
    PRIVATE
        topo::core::TopoPlatform
        nlohmann_json::nlohmann_json)
# TOPO_SOURCE_DIR is consulted by TypeScriptSafePatterns.cpp for source-tree
# catalog discovery (the env var TOPO_PATTERNS_DIR takes precedence). The
# in-source fallback looks for
# <TOPO_SOURCE_DIR>/topo-lang-typescript/topo-check/analysis/catalog/TypeScriptSafePatterns.toml,
# so in standalone mode we materialise a shim directory in the build tree
# that contains a `topo-lang-typescript` symlink back to this source root.
# Install-time consumers can override at runtime via TOPO_PATTERNS_DIR.
set(_TOPO_LANG_TYPESCRIPT_SHIM "${CMAKE_BINARY_DIR}/topo-source-shim")
file(MAKE_DIRECTORY "${_TOPO_LANG_TYPESCRIPT_SHIM}")
if(NOT EXISTS "${_TOPO_LANG_TYPESCRIPT_SHIM}/topo-lang-typescript")
    # Use PROJECT_SOURCE_DIR (this project's root) instead of CMAKE_SOURCE_DIR
    # so the shim resolves correctly when this CMakeLists is included via
    # add_subdirectory from a parent project (meta-repo unified build).
    file(CREATE_LINK "${PROJECT_SOURCE_DIR}"
        "${_TOPO_LANG_TYPESCRIPT_SHIM}/topo-lang-typescript" SYMBOLIC)
endif()
target_compile_definitions(TopoTypeScriptAnalysis PRIVATE
    TOPO_SOURCE_DIR="${_TOPO_LANG_TYPESCRIPT_SHIM}"
)
topo_set_compiler_flags(TopoTypeScriptAnalysis)

install(TARGETS TopoTypeScriptAnalysis
    EXPORT topo-lang-typescriptTargets
    ARCHIVE  DESTINATION ${CMAKE_INSTALL_LIBDIR}
    INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/topo-lang-typescript/topo-check/analysis
)
install(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/topo-lang-typescript/topo-check/analysis
    FILES_MATCHING PATTERN "*.h"
)
