#include "TypeScriptPlugin.h"
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
    fs::path launcher = fs::path(toolDir) / "topo-extract-typescript";
    if (!fs::exists(launcher)) return;
    const char* oldPath = std::getenv("PATH");
    std::string newPath = toolDir + ":" + (oldPath ? oldPath : "");
    setenv("PATH", newPath.c_str(), 1);
}

int main(int argc, char** argv) {
    topo::lang::registerTypeScriptPlugin();
    stageExtractorOnPath();
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
