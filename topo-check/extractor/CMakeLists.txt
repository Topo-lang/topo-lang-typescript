# topo-extract-typescript: transpile-source extractor.
#
# TranspileDriver spawns this by the bare name `topo-extract-typescript`
# (PATH lookup via execvp/CreateProcess), the same contract the compiled
# topo-extract-cpp / topo-extract-rust binaries satisfy. This tool is
# Node-backed, so a launcher shim of that exact name execs `node index.mjs`
# from a staged copy that carries its own npm-installed node_modules.
#
# Staged into topo-build-typescript's binary directory so a single binary
# directory holds the whole TS toolset and no separate install root needs
# to go on PATH. The body lives in a sibling subdir (…-tool/) so it does
# not collide with the bare-name launcher file placed beside the binary.
#
# Implemented as a standalone custom target (not a POST_BUILD on
# topo-build-typescript — add_custom_command(TARGET) only works in the
# directory that created the target). Consumers add_dependencies() on
# `topo-extract-typescript-stage` and on `topo-build-typescript` (for its
# binary dir to exist).

if(NOT TARGET topo-build-typescript)
    return()
endif()

# Windows-skip: the chained `cmake -E copy_directory` + `npm.cmd install` +
# `cmake -E copy` POST_BUILD step reproducibly exits 127 on GHA windows-2022
# inside the nested cmd.exe / applocal.ps1 invocation. The extractor itself
# is Node-only and is exercised by monorepo CI; standalone Windows builds
# topo-build-typescript fine, just without the staged Node launcher.
# Downstream e2e tests detect the absent launcher and self-skip.
if(WIN32)
    message(STATUS "topo-lang-typescript: topo-extract-typescript staging "
        "disabled on Windows (POST_BUILD npm chain trips exit 127 in CI). "
        "e2e tests that need the launcher will self-skip.")
    return()
endif()

find_program(NPM_EXECUTABLE NAMES npm.cmd npm REQUIRED
    DOC "npm CLI used to install topo-extract-typescript's typescript dependency")

set(_extractSrc ${CMAKE_CURRENT_SOURCE_DIR})
set(_binDir $<TARGET_FILE_DIR:topo-build-typescript>)
set(_extractDst ${_binDir}/topo-extract-typescript-tool)

if(WIN32)
    set(_launcherName topo-extract-typescript.cmd)
else()
    set(_launcherName topo-extract-typescript)
endif()

# Copy the tool, npm install its typescript dependency (idempotent against
# package-lock.json), place the launcher beside the binary, and on POSIX
# mark both launcher copies executable so PATH resolution can exec them.
add_custom_target(topo-extract-typescript-stage ALL
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${_extractSrc} ${_extractDst}
    COMMAND ${NPM_EXECUTABLE} install --omit=dev --no-audit --no-fund --silent
        --prefix ${_extractDst}
    COMMAND ${CMAKE_COMMAND} -E copy
        ${_extractDst}/${_launcherName} ${_binDir}/${_launcherName}
    COMMENT "Staging topo-extract-typescript + npm install"
    VERBATIM
)
add_dependencies(topo-extract-typescript-stage topo-build-typescript)

if(NOT WIN32)
    add_custom_command(TARGET topo-extract-typescript-stage POST_BUILD
        COMMAND chmod +x
            ${_binDir}/${_launcherName}
            ${_extractDst}/topo-extract-typescript
        COMMENT "Marking topo-extract-typescript launcher executable"
        VERBATIM
    )
endif()
