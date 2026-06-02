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

# Stages on ALL platforms (Windows included). The `npm install` that populates
# the tool's node_modules/typescript is NOT run from the staging custom command
# in a standalone build: npm reproducibly exits 127 when invoked from a CMake
# command on GHA windows-2022 (the nested cmd.exe / applocal.ps1 layer — the
# same root cause the contract-pass transforms hit). In the standalone per-repo
# build the CI workflow installs node_modules out-of-band with a dedicated
# `cd <tool-dir> && npm install` step. In the meta full-stack build (embedded
# mode, local + POSIX) there is no such workflow step, so an npm POST_BUILD is
# attached at the bottom of this file, gated to embedded + POSIX, so the meta's
# ts-tool-smoke.topo-extract-typescript node test keeps a populated node_modules.
# This staging target itself only copies the tool body + places the launcher.

set(_extractSrc ${CMAKE_CURRENT_SOURCE_DIR})
set(_binDir $<TARGET_FILE_DIR:topo-build-typescript>)
set(_extractDst ${_binDir}/topo-extract-typescript-tool)

if(WIN32)
    set(_launcherName topo-extract-typescript.cmd)
else()
    set(_launcherName topo-extract-typescript)
endif()

# Copy the tool body, place the launcher beside the binary, and on POSIX mark
# both launcher copies executable so PATH resolution can exec them. The
# typescript dependency is npm-installed into ${_extractDst} by the CI
# workflow's dedicated post-build step (see the comment above), not here.
add_custom_target(topo-extract-typescript-stage ALL
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${_extractSrc} ${_extractDst}
    COMMAND ${CMAKE_COMMAND} -E copy
        ${_extractDst}/${_launcherName} ${_binDir}/${_launcherName}
    COMMENT "Staging topo-extract-typescript (node_modules installed out-of-band)"
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

# Meta full-stack build accommodation. In a standalone build
# (PROJECT_IS_TOP_LEVEL) node_modules is installed by the CI workflow step; the
# meta build embeds this clone (PROJECT_IS_TOP_LEVEL is FALSE) and has no such
# step, so install node_modules here so its ts-tool-smoke.topo-extract-typescript
# node test (`node --test smoke.test.mjs`, which spawns `node index.mjs`) can
# import 'typescript'. POSIX only — the meta build runs locally on POSIX, and
# this avoids the windows-2022 npm-from-CMake failure entirely. When the
# extractor is staged, ENABLE_NODE_EXTRACTOR's npm/node probe already passed, so
# npm is present.
if(NOT PROJECT_IS_TOP_LEVEL AND NOT WIN32)
    find_program(NPM_EXECUTABLE NAMES npm npm.cmd)
    if(NPM_EXECUTABLE)
        add_custom_command(TARGET topo-extract-typescript-stage POST_BUILD
            COMMAND ${NPM_EXECUTABLE} install --omit=dev --no-audit --no-fund --silent
            WORKING_DIRECTORY ${_extractDst}
            COMMENT "meta build: npm install for staged topo-extract-typescript"
            VERBATIM
        )
    endif()
endif()
