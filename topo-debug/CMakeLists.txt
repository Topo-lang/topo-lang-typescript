# topo-debug-typescript — Extract adapter for Node.js/V8.
#
# Drives a Node script under --inspect-brk via Chrome DevTools Protocol (CDP)
# over WebSocket and emits the debug wire records. Mirrors
# topo-lang-cpp/topo-debug's role for the V8 host family.
#
# Build outputs (under ${CMAKE_CURRENT_BINARY_DIR}):
#   - adapter.mjs                     (copied verbatim)
#   - topo-debug-typescript           (POSIX launcher, configured)
#   - topo-debug-typescript.cmd       (Windows launcher, configured)
#   - fixtures/tinyVector.mjs         (copied verbatim)
#
# Gating:
#   - Requires Node.js >= 22 (built-in WebSocket global).
#   - If Node is missing or too old, the target is skipped with a STATUS
#     message; the rest of the build is unaffected and e2e tests gated on
#     `TARGET topo-debug-typescript` simply won't be registered.

find_program(NODE_EXECUTABLE node)
if(NOT NODE_EXECUTABLE)
    message(STATUS "topo-debug-typescript: 'node' not found in PATH; "
                   "skipping build.")
    return()
endif()

execute_process(
    COMMAND "${NODE_EXECUTABLE}" --version
    OUTPUT_VARIABLE _NODE_VERSION_RAW
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE _NODE_VERSION_RC
)
if(NOT _NODE_VERSION_RC EQUAL 0)
    message(STATUS "topo-debug-typescript: '${NODE_EXECUTABLE} --version' failed; skipping.")
    return()
endif()

# Strip leading 'v' (e.g. "v22.4.0" -> "22.4.0") then take the major.
string(REGEX REPLACE "^v" "" _NODE_VERSION "${_NODE_VERSION_RAW}")
string(REGEX MATCH "^([0-9]+)" _NODE_MAJOR_MATCH "${_NODE_VERSION}")
set(_NODE_MAJOR "${CMAKE_MATCH_1}")
if(NOT _NODE_MAJOR OR _NODE_MAJOR LESS 22)
    message(STATUS "topo-debug-typescript: Node.js >= 22 required for built-in "
                   "WebSocket (found ${_NODE_VERSION_RAW}); skipping.")
    return()
endif()

message(STATUS "topo-debug-typescript: using ${NODE_EXECUTABLE} (${_NODE_VERSION_RAW})")

# Stage the adapter and fixture into the build tree so the launcher can
# resolve them by absolute path at runtime, regardless of CWD.
set(_ADAPTER_SRC      "${CMAKE_CURRENT_SOURCE_DIR}/adapter.mjs")
set(_ADAPTER_OUT      "${CMAKE_CURRENT_BINARY_DIR}/adapter.mjs")
set(_FIXTURE_SRC      "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/tinyVector.mjs")
set(_FIXTURE_OUT      "${CMAKE_CURRENT_BINARY_DIR}/fixtures/tinyVector.mjs")

configure_file(${_ADAPTER_SRC} ${_ADAPTER_OUT} COPYONLY)
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/fixtures")
configure_file(${_FIXTURE_SRC} ${_FIXTURE_OUT} COPYONLY)

# Export the staged adapter location for the launcher template substitution.
set(TOPO_DEBUG_TYPESCRIPT_ADAPTER "${_ADAPTER_OUT}")

# Configure POSIX + Windows launchers. The .in templates substitute
# @NODE_EXECUTABLE@ and @TOPO_DEBUG_TYPESCRIPT_ADAPTER@.
set(_LAUNCHER_OUT_POSIX  "${CMAKE_CURRENT_BINARY_DIR}/topo-debug-typescript")
set(_LAUNCHER_OUT_WIN    "${CMAKE_CURRENT_BINARY_DIR}/topo-debug-typescript.cmd")
configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/topo-debug-typescript.in"
    "${_LAUNCHER_OUT_POSIX}"
    @ONLY
)
configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/topo-debug-typescript.cmd.in"
    "${_LAUNCHER_OUT_WIN}"
    @ONLY
)
# `configure_file` doesn't set the executable bit; do it explicitly.
if(NOT WIN32)
    file(CHMOD "${_LAUNCHER_OUT_POSIX}"
        PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE
                    GROUP_READ GROUP_EXECUTE
                    WORLD_READ WORLD_EXECUTE)
endif()

# Expose the launcher path so the e2e tests can reference it directly.
set(TOPO_DEBUG_TYPESCRIPT_LAUNCHER "${_LAUNCHER_OUT_POSIX}"
    CACHE INTERNAL "Path to topo-debug-typescript launcher in the build tree")
set(TOPO_DEBUG_TYPESCRIPT_FIXTURE "${_FIXTURE_OUT}"
    CACHE INTERNAL "Path to tinyVector.mjs fixture in the build tree")

# Pure-staging custom target so `cmake --build build` always (re)stages on
# adapter/fixture/launcher source edits. The launcher itself is a configure-
# time output; the script + fixture are also configure-time copies, so this
# target has no build commands — it just expresses dependency so other
# subdirs can `add_dependencies(... topo-debug-typescript-stage)` if needed.
# Named `-stage` (not `topo-debug-typescript`) to avoid the dependency cycle
# Ninja detects when a custom target shares its name with a configure-time
# generated file in the same directory (the launcher script).
add_custom_target(topo-debug-typescript-stage ALL
    DEPENDS
        "${_ADAPTER_OUT}"
        "${_FIXTURE_OUT}"
        "${_LAUNCHER_OUT_POSIX}"
        "${_LAUNCHER_OUT_WIN}"
)

# stage project-level fixtures (project_simple / project_multi).
add_subdirectory(test)
