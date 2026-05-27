# project-level TypeScript fixtures for topo-debug-typescript.
#
# Counterpart of topo-lang-{cpp,rust,java,python}/topo-debug/test/fixtures/
# project_{simple,multi}. Unlike tinyVector.mjs (a single .mjs file driven
# directly by the adapter), these fixtures exercise the declaration-driven
# path end-to-end: `topo build` parses main.topo, runs topo-build-typescript's
# completeness check over `src/main.ts`, then topo-build itself writes
# main.topo-dbg.json (the view registry); the adapter's --target is a
# separate `main.mjs` because V8's CDP Debugger.setBreakpointByUrl needs a
# URL that matches what Node parsed at runtime — Node 26 happily strips
# types from `.ts` files but the parsed-script URL no longer matches the
# `file://...ts` URL we hand to setBreakpointByUrl, so the breakpoint stays
# unresolved and the adapter times out at 30s.
#
# Each fixture is staged into the build tree at configure time so
# `topo build` writes its outputs (`main.topo-dbg.json`, `main.topo-passes/`,
# etc.) there rather than polluting the source checkout.

set(_PROJECT_SIMPLE_TS_SRC ${CMAKE_CURRENT_SOURCE_DIR}/fixtures/project_simple)
set(TOPO_DEBUG_TYPESCRIPT_PROJECT_SIMPLE_DIR
    ${CMAKE_CURRENT_BINARY_DIR}/fixtures/project_simple
    CACHE INTERNAL "Project-simple TypeScript fixture build dir")
file(MAKE_DIRECTORY ${TOPO_DEBUG_TYPESCRIPT_PROJECT_SIMPLE_DIR})
file(MAKE_DIRECTORY ${TOPO_DEBUG_TYPESCRIPT_PROJECT_SIMPLE_DIR}/src)
configure_file(${_PROJECT_SIMPLE_TS_SRC}/Topo.toml
    ${TOPO_DEBUG_TYPESCRIPT_PROJECT_SIMPLE_DIR}/Topo.toml COPYONLY)
configure_file(${_PROJECT_SIMPLE_TS_SRC}/main.topo
    ${TOPO_DEBUG_TYPESCRIPT_PROJECT_SIMPLE_DIR}/main.topo COPYONLY)
configure_file(${_PROJECT_SIMPLE_TS_SRC}/main.mjs
    ${TOPO_DEBUG_TYPESCRIPT_PROJECT_SIMPLE_DIR}/main.mjs COPYONLY)
configure_file(${_PROJECT_SIMPLE_TS_SRC}/src/main.ts
    ${TOPO_DEBUG_TYPESCRIPT_PROJECT_SIMPLE_DIR}/src/main.ts COPYONLY)

set(_PROJECT_MULTI_TS_SRC ${CMAKE_CURRENT_SOURCE_DIR}/fixtures/project_multi)
set(TOPO_DEBUG_TYPESCRIPT_PROJECT_MULTI_DIR
    ${CMAKE_CURRENT_BINARY_DIR}/fixtures/project_multi
    CACHE INTERNAL "Project-multi TypeScript fixture build dir")
file(MAKE_DIRECTORY ${TOPO_DEBUG_TYPESCRIPT_PROJECT_MULTI_DIR})
file(MAKE_DIRECTORY ${TOPO_DEBUG_TYPESCRIPT_PROJECT_MULTI_DIR}/src)
configure_file(${_PROJECT_MULTI_TS_SRC}/Topo.toml
    ${TOPO_DEBUG_TYPESCRIPT_PROJECT_MULTI_DIR}/Topo.toml COPYONLY)
configure_file(${_PROJECT_MULTI_TS_SRC}/main.topo
    ${TOPO_DEBUG_TYPESCRIPT_PROJECT_MULTI_DIR}/main.topo COPYONLY)
configure_file(${_PROJECT_MULTI_TS_SRC}/main.mjs
    ${TOPO_DEBUG_TYPESCRIPT_PROJECT_MULTI_DIR}/main.mjs COPYONLY)
configure_file(${_PROJECT_MULTI_TS_SRC}/src/main.ts
    ${TOPO_DEBUG_TYPESCRIPT_PROJECT_MULTI_DIR}/src/main.ts COPYONLY)
