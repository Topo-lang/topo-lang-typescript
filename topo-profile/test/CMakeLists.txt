# Node.js span-emitter fixture for topo-profile.
#
# Mirrors topo-lang-python/topo-profile: the fixture is a thin Node script
# that emits three NDJSON spans matching libtopo-observe's wire shape.
# CMake stages the .mjs file in the build tree and generates a POSIX
# wrapper that invokes `node <fixture>`.

find_program(NODE_EXECUTABLE node)
if(NOT NODE_EXECUTABLE)
    message(STATUS "topo-lang-typescript/topo-profile: node not found on PATH; "
                   "skipping span fixture.")
    return()
endif()

set(_FIXTURE_SRC "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/spansDemo.mjs")
set(_FIXTURE_DIR "${CMAKE_CURRENT_BINARY_DIR}")
set(_FIXTURE_MJS "${_FIXTURE_DIR}/spansDemo.mjs")
set(_WRAPPER     "${_FIXTURE_DIR}/spans_demo_ts.sh")

configure_file("${_FIXTURE_SRC}" "${_FIXTURE_MJS}" COPYONLY)

file(GENERATE OUTPUT "${_WRAPPER}"
     CONTENT "#!/bin/sh\nexec \"${NODE_EXECUTABLE}\" \"${_FIXTURE_MJS}\" \"$@\"\n")
add_custom_command(
    OUTPUT "${_WRAPPER}.stamp"
    COMMAND ${CMAKE_COMMAND} -E touch "${_WRAPPER}.stamp"
    COMMAND chmod +x "${_WRAPPER}"
    DEPENDS "${_FIXTURE_MJS}" "${_WRAPPER}"
    VERBATIM)

add_custom_target(spans_demo_ts ALL DEPENDS "${_WRAPPER}.stamp")
set_target_properties(spans_demo_ts PROPERTIES
    TOPO_FIXTURE_PATH "${_WRAPPER}")
