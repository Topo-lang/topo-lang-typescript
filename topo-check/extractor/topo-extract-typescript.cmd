@echo off
rem Windows launcher shim — see topo-extract-typescript (POSIX) for rationale.
rem Staged-beside-binary layout keeps the tool body in a sibling subdir;
rem in-tree layout has index.mjs right next to this shim.
if exist "%~dp0topo-extract-typescript-tool\index.mjs" (
    node "%~dp0topo-extract-typescript-tool\index.mjs" %*
) else (
    node "%~dp0index.mjs" %*
)
