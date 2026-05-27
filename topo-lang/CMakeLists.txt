add_library(TopoTypeScriptPlugin
    TypeScriptPlugin.cpp
)
add_library(topo::lang-typescript::TopoTypeScriptPlugin ALIAS TopoTypeScriptPlugin)

target_include_directories(TopoTypeScriptPlugin PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
    $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}/topo-lang-typescript/topo-lang>
)
# Linked PUBLIC targets already carry their include paths (TsServerBridge,
# V8Codegen, AST primitives via topo::v8::Placeholder), so the monorepo's
# explicit PRIVATE include shims are unnecessary in standalone mode.
target_link_libraries(TopoTypeScriptPlugin PUBLIC
    topo::lang::TopoLang
    TopoTypeScriptAnalysis
    TopoTypeScriptCheck
    TopoTypeScriptInit
    # V8 shared infrastructure. topo::v8::Topov8Placeholder re-exports the
    # real topo-v8/lib/* targets; the TypeScript plugin uses V8Codegen,
    # TsServerBridge, and the AST check primitives through this edge.
    topo::v8::Topov8Placeholder
)
topo_set_compiler_flags(TopoTypeScriptPlugin)

install(TARGETS TopoTypeScriptPlugin
    EXPORT topo-lang-typescriptTargets
    ARCHIVE  DESTINATION ${CMAKE_INSTALL_LIBDIR}
    INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/topo-lang-typescript/topo-lang
)
install(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/topo-lang-typescript/topo-lang
    FILES_MATCHING PATTERN "*.h"
)
