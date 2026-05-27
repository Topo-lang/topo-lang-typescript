add_library(TopoTypeScriptCheck STATIC TypeScriptCheckRunner.cpp)
add_library(topo::lang-typescript::TopoTypeScriptCheck ALIAS TopoTypeScriptCheck)

target_include_directories(TopoTypeScriptCheck PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
    $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}/topo-lang-typescript/topo-check/runner>
)
target_link_libraries(TopoTypeScriptCheck PUBLIC topo::lang::TopoLang)
topo_set_compiler_flags(TopoTypeScriptCheck)

install(TARGETS TopoTypeScriptCheck
    EXPORT topo-lang-typescriptTargets
    ARCHIVE  DESTINATION ${CMAKE_INSTALL_LIBDIR}
    INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/topo-lang-typescript/topo-check/runner
)
install(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/topo-lang-typescript/topo-check/runner
    FILES_MATCHING PATTERN "*.h"
)
