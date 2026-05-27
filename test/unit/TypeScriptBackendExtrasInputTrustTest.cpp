// topo-build-typescript per-value backendExtras validation tests.
//
// Spawns the actual topo-build-typescript binary with hand-crafted
// BackendRequest JSON to assert that wrong-typed backendExtras values
// are rejected before any extractor/transform subprocess is spawned.
// Mirrors the topo-jvm input-trust pattern: every backend tool must
// reject malformed backendExtras with a uniform diagnostic shape
// ("error: backendExtras.<key>: expected <type>, got <actual>") rather
// than silently coercing or letting a downstream Node subprocess crash.

#include "topo/Platform/Process.h"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

#ifdef _WIN32
int testPid() { return _getpid(); }
#else
int testPid() { return getpid(); }
#endif

class TypeScriptBackendExtrasInputTrust : public ::testing::Test {
protected:
    fs::path testDir;

    void SetUp() override {
        testDir = fs::temp_directory_path() /
                  ("topo-ts-extras-trust_" + std::to_string(testPid()) + "_" +
                   std::to_string(reinterpret_cast<std::uintptr_t>(this)));
        fs::create_directories(testDir);
    }

    void TearDown() override {
        std::error_code ec;
        fs::remove_all(testDir, ec);
    }

    json makeRequest(const json& backendExtras) const {
        json j = json::object();
        j["outputPath"] = (testDir / "out").string();
        j["tempDir"] = (testDir / "tmp").string();
        j["language"] = "typescript";
        j["config"] = json::object();
        j["topoMetadata"] = json::object();
        j["visibilityEntries"] = json::array();
        j["backendExtras"] = backendExtras;
        return j;
    }

    topo::platform::CapturedProcessResult invoke(const json& req) const {
        fs::path reqPath = testDir / "request.json";
        std::ofstream(reqPath) << req.dump();
        return topo::platform::runProcessCapture(
            TOPO_BUILD_TYPESCRIPT_EXE, {reqPath.string()}, false);
    }
};

} // namespace

TEST_F(TypeScriptBackendExtrasInputTrust, NodePathMustBeString) {
    json extras = json::object();
    extras["nodePath"] = 100;
    auto result = invoke(makeRequest(extras));

    EXPECT_NE(result.exitCode, 0);
    EXPECT_NE(result.stderrOutput.find("backendExtras.nodePath"),
              std::string::npos)
        << "expected diagnostic mentioning 'backendExtras.nodePath'; "
        << "stderr was:\n" << result.stderrOutput;
    EXPECT_NE(result.stderrOutput.find("expected string"), std::string::npos)
        << "expected 'expected string' phrase; stderr was:\n"
        << result.stderrOutput;
}

TEST_F(TypeScriptBackendExtrasInputTrust, TsconfigPathMustBeString) {
    json extras = json::object();
    extras["tsconfigPath"] = false;
    auto result = invoke(makeRequest(extras));

    EXPECT_NE(result.exitCode, 0);
    EXPECT_NE(result.stderrOutput.find("backendExtras.tsconfigPath"),
              std::string::npos)
        << "expected diagnostic mentioning 'backendExtras.tsconfigPath'; "
        << "stderr was:\n" << result.stderrOutput;
}

TEST_F(TypeScriptBackendExtrasInputTrust, PackageManagerMustBeString) {
    json extras = json::object();
    extras["packageManager"] = json::array({"npm"});
    auto result = invoke(makeRequest(extras));

    EXPECT_NE(result.exitCode, 0);
    EXPECT_NE(result.stderrOutput.find("backendExtras.packageManager"),
              std::string::npos)
        << "expected diagnostic mentioning 'backendExtras.packageManager'; "
        << "stderr was:\n" << result.stderrOutput;
}
