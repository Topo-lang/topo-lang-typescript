#include "TypeScriptPlugin.h"

#include "topo/Platform/Platform.h"

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <string>

#ifndef TOPO_EXTRACT_TS_TOOL_DIR
#define TOPO_EXTRACT_TS_TOOL_DIR ""
#endif

namespace fs = std::filesystem;

// Prepend the staged topo-extract-typescript directory to PATH so the
// TypeScript check provider's AST-based L1 symbol extractor can resolve the
// launcher by its bare name (the same PATH contract TranspileDriver uses).
// When the directory is unset or the launcher is absent, PATH is left
// untouched and the provider falls back to the regex extractor.
static void stageExtractorOnPath() {
    const std::string toolDir = TOPO_EXTRACT_TS_TOOL_DIR;
    if (toolDir.empty()) return;
    // The staged launcher is `.cmd` on Windows, extensionless on POSIX — probe
    // the platform-correct name so this does not silently bail out on Windows
    // (a bare CreateProcess cannot run a `.cmd`).
    const std::string launcherName =
        std::string("topo-extract-typescript") +
        (topo::platform::IsWindows ? ".cmd" : "");
    fs::path launcher = fs::path(toolDir) / launcherName;
    if (!fs::exists(launcher)) return;
    const char* oldPath = std::getenv("PATH");
    // PATH entries are ';'-separated on Windows, ':' on POSIX.
    std::string newPath = toolDir +
                          std::string(topo::platform::PathSeparator) +
                          (oldPath ? oldPath : "");
#ifdef _WIN32
    // MSVC has no setenv(); _putenv_s is its in-process equivalent.
    _putenv_s("PATH", newPath.c_str());
#else
    setenv("PATH", newPath.c_str(), 1);
#endif
}

int main(int argc, char** argv) {
    topo::lang::registerTypeScriptPlugin();
    stageExtractorOnPath();
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
