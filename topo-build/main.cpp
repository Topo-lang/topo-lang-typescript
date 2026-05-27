// topo-build-typescript -- Check+transform backend for TypeScript projects.
//
// Steps:
// 1. Parse BackendRequest JSON from argv[1]
// 2. Extract backendExtras: nodePath, tsconfigPath, packageManager
// 3. Collect .ts / .tsx source files (skip node_modules)
// 4. If !noVerify: run all checks (completeness, containment, visibility,
//    purity, stage-isolation, import-path)
// 5. Report diagnostics; exit 1 on error (unless warnOnly)

#include "topo/Build/BackendProtocol.h"

// Extractors
#include "TypeScriptSymbolExtractor.h"
#include "TypeScriptCallSiteExtractor.h"
#include "TypeScriptCallEdgeExtractor.h"
#include "TypeScriptSymbolAccessExtractor.h"
#include "TypeScriptImportExtractor.h"

// Check functions
#include "topo/Check/CheckTypes.h"
#include "topo/Check/CompletenessCheck.h"
#include "topo/Check/ContainmentCheck.h"
#include "topo/Check/VisibilityCheck.h"
#include "topo/Check/PurityCheck.h"
#include "topo/Check/StageIsolationCheck.h"
#include "topo/Analysis/ImportPathCheck.h"

// Config — FeatureMode / ContainmentConfig / PurityConfig / etc.
#include "topo/Build/PassConfig.h"
#include "topo/Platform/Process.h"
#include "topo/Platform/SharedLibrary.h"
#include "topo/Platform/TempFile.h"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <nlohmann/json.hpp>

#define TOML_HEADER_ONLY 1
#define TOML_EXCEPTIONS 0
#include <toml++/toml.hpp>

namespace fs = std::filesystem;

namespace {

bool pathContainsNodeModules(const fs::path& p) {
    for (const auto& part : p) {
        if (part == "node_modules") return true;
    }
    return false;
}

bool isTypeScriptExtension(const fs::path& p) {
    const auto ext = p.extension().string();
    return ext == ".ts" || ext == ".tsx";
}

topo::FeatureMode parseModeString(const std::string& s, topo::FeatureMode fallback) {
    if (s == "force") return topo::FeatureMode::Force;
    if (s == "auto") return topo::FeatureMode::Auto;
    if (s == "off") return topo::FeatureMode::Off;
    return fallback;
}

// ============================================================
// backendExtras per-value validators (TypeScript backend).
//
// Schema (all keys optional):
//   nodePath        string   override Node binary path
//   tsconfigPath    string   tsconfig.json location forwarded to verbose log
//   packageManager  string   npm/pnpm/yarn token used in verbose log
//
// Mirrors topo-build-llvm-cpp's pattern. Validation runs before any
// extractor/transform subprocess so a wrong-typed value surfaces with a
// key-pointing error rather than later as an empty `"node"` string
// substituted by `.value()`'s default.
// ============================================================

bool expectStringIfPresent(const nlohmann::json& extras, const char* key) {
    if (!extras.contains(key)) return true;
    const auto& v = extras.at(key);
    if (!v.is_string()) {
        std::cerr << "error: backendExtras." << key
                  << ": expected string, got " << v.type_name() << "\n";
        return false;
    }
    return true;
}

topo::FeatureMode readCheckMode(const std::string& tomlPath, const std::string& section) {
    try {
        auto tbl = toml::parse_file(tomlPath);
        if (auto v = tbl.at_path(section + ".mode").value<std::string>()) {
            return parseModeString(*v, topo::FeatureMode::Auto);
        }
    } catch (...) {}
    return topo::FeatureMode::Auto;
}

topo::FeatureMode readModeWithDefault(const std::string& tomlPath,
                                     const std::string& section,
                                     topo::FeatureMode defaultMode) {
    try {
        auto tbl = toml::parse_file(tomlPath);
        if (auto v = tbl.at_path(section + ".mode").value<std::string>()) {
            return parseModeString(*v, defaultMode);
        }
    } catch (...) {}
    return defaultMode;
}

} // namespace

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <request.json>\n"
                  << "  Check+transform backend invoked by topo-build. "
                     "Not intended for direct use.\n";
        return 1;
    }

    // --- Step 1: Parse backend request ---
    std::ifstream reqFile(argv[1]);
    if (!reqFile) {
        std::cerr << "error: cannot open '" << argv[1] << "'\n";
        return 1;
    }
    std::ostringstream buf;
    buf << reqFile.rdbuf();
    std::string reqJson = buf.str();
    reqFile.close();

    topo::build::BackendRequest req;
    if (!topo::build::deserializeBackendRequest(reqJson, req)) {
        std::cerr << "error: failed to parse backend request JSON\n";
        return 1;
    }

    bool verbose = req.verbose;

    // Per-value validation of backendExtras inputs. Centralised unknown-key
    // rejection (deserializeBackendRequest) is silent-tolerant for
    // TypeScript today, but every known key still has a fixed JSON type.
    if (!expectStringIfPresent(req.backendExtras, "nodePath")) return 1;
    if (!expectStringIfPresent(req.backendExtras, "tsconfigPath")) return 1;
    if (!expectStringIfPresent(req.backendExtras, "packageManager")) return 1;

    // --- Step 2: Extract backend extras ---
    std::string nodePath = req.backendExtras.value("nodePath", std::string("node"));
    std::string tsconfigPath = req.backendExtras.value("tsconfigPath", std::string());
    std::string packageManager = req.backendExtras.value("packageManager", std::string("npm"));

    if (verbose) {
        std::cerr << "[topo-build-typescript] node: " << nodePath << "\n";
        if (!tsconfigPath.empty())
            std::cerr << "[topo-build-typescript] tsconfig: " << tsconfigPath << "\n";
        std::cerr << "[topo-build-typescript] package manager: " << packageManager << "\n";
    }

    // --- Step 3: Collect .ts / .tsx source files ---
    std::vector<std::string> sourceFiles;
    for (const auto& src : req.sources) {
        fs::path srcPath(src);
        if (fs::is_directory(srcPath)) {
            for (auto it = fs::recursive_directory_iterator(srcPath);
                 it != fs::recursive_directory_iterator(); ++it) {
                const auto& entry = *it;
                if (entry.is_directory() && entry.path().filename() == "node_modules") {
                    it.disable_recursion_pending();
                    continue;
                }
                if (!entry.is_regular_file()) continue;
                if (isTypeScriptExtension(entry.path()) &&
                    !pathContainsNodeModules(entry.path())) {
                    sourceFiles.push_back(entry.path().string());
                }
            }
        } else if (isTypeScriptExtension(srcPath) &&
                   !pathContainsNodeModules(srcPath)) {
            sourceFiles.push_back(srcPath.string());
        }
    }
    std::sort(sourceFiles.begin(), sourceFiles.end());

    if (verbose) {
        std::cerr << "[topo-build-typescript] Found " << sourceFiles.size()
                  << " TypeScript source file(s)\n";
        for (const auto& f : sourceFiles)
            std::cerr << "  " << f << "\n";
    }

    // --- Read per-check modes from Topo.toml ---
    std::string tomlPath = "Topo.toml";
    auto visibilityMode = readCheckMode(tomlPath, "visibility");
    auto purityMode = readCheckMode(tomlPath, "purity");
    auto stageIsolationMode = readCheckMode(tomlPath, "stage_isolation");

    // --- Step 4: Run all checks ---
    if (!req.config.noVerify) {
        int totalErrors = 0;
        int totalWarnings = 0;
        int checkCount = 0;
        const int totalChecks = 6;

        auto reportDiag = [&](const topo::check::CheckResult& result) {
            for (const auto& diag : result.diagnostics) {
                const char* level = "note";
                if (diag.severity == topo::check::Severity::Error)
                    level = "error";
                else if (diag.severity == topo::check::Severity::Warning)
                    level = "warning";

                std::cerr << level << ": " << diag.message << "\n";
                if (!diag.file.empty()) {
                    std::cerr << "  --> " << diag.file;
                    if (diag.line > 0) std::cerr << ":" << diag.line;
                    std::cerr << "\n";
                }
            }
            totalErrors += result.errorCount;
            totalWarnings += result.warningCount;
        };

        // ---- [1/6] Completeness check ----
        checkCount++;
        std::cerr << "[" << checkCount << "/" << totalChecks
                  << "] Checking completeness...\n";
        {
            topo::check::TypeScriptSymbolExtractor extractor;
            auto hostSymbols = extractor.extractAll(sourceFiles);
            if (verbose) {
                std::cerr << "[  Extracted " << hostSymbols.size()
                          << " host symbol(s) ]\n";
            }
            topo::check::CompletenessConfig cfg;
            cfg.ignoreConstructors = true;
            cfg.ignoreMain = true;
            topo::check::CheckResult result;
            topo::check::checkCompleteness(hostSymbols, req.symbolTable,
                                           req.visibilityEntries, cfg, result);
            reportDiag(result);
        }

        // ---- [2/6] Containment check (L1) ----
        checkCount++;
        std::cerr << "[" << checkCount << "/" << totalChecks
                  << "] Checking containment...\n";
        {
            topo::ContainmentConfig cfg;
            cfg.mode = readCheckMode(tomlPath, "containment");

            topo::check::TypeScriptImportExtractor importExtractor;
            auto imports = importExtractor.extractAll(sourceFiles);

            topo::check::TypeScriptCallSiteExtractor callSiteExtractor;
            std::vector<topo::check::DetectedCallSite> callSites;
            for (const auto& f : sourceFiles) {
                auto sites = callSiteExtractor.extractCallSites(f);
                callSites.insert(callSites.end(), sites.begin(), sites.end());
            }

            if (verbose) {
                std::cerr << "[  Extracted " << imports.size()
                          << " import(s), " << callSites.size()
                          << " call site(s) ]\n";
            }

            topo::check::CheckResult result;
            topo::check::checkContainment(req.symbolTable, imports, callSites,
                                          cfg, result, ".");
            reportDiag(result);
        }

        // ---- [3/6] Visibility check ----
        checkCount++;
        std::cerr << "[" << checkCount << "/" << totalChecks
                  << "] Checking visibility...\n";
        if (visibilityMode != topo::FeatureMode::Off) {
            topo::check::TypeScriptCallEdgeExtractor edgeExtractor;
            std::vector<topo::check::CallEdge> callEdges;
            for (const auto& f : sourceFiles) {
                auto edges = edgeExtractor.extractCallEdges(f);
                callEdges.insert(callEdges.end(), edges.begin(), edges.end());
            }

            if (verbose) {
                std::cerr << "[  Extracted " << callEdges.size()
                          << " call edge(s) ]\n";
            }

            topo::check::CheckResult result;
            topo::check::checkVisibilityConsistency(req.symbolTable,
                                                     req.visibilityEntries,
                                                     callEdges, result);
            if (visibilityMode == topo::FeatureMode::Force) {
                for (auto& d : result.diagnostics) {
                    if (d.severity == topo::check::Severity::Warning)
                        d.severity = topo::check::Severity::Error;
                }
                result.errorCount += result.warningCount;
                result.warningCount = 0;
            }
            reportDiag(result);
        } else {
            std::cerr << "  Skipped (mode=off).\n";
        }

        // ---- [4/6] Purity check ----
        checkCount++;
        std::cerr << "[" << checkCount << "/" << totalChecks
                  << "] Checking purity...\n";
        if (purityMode != topo::FeatureMode::Off) {
            topo::check::TypeScriptSymbolAccessExtractor accessExtractor;
            std::vector<topo::check::SymbolAccess> accesses;
            for (const auto& f : sourceFiles) {
                auto acc = accessExtractor.extractSymbolAccesses(f);
                accesses.insert(accesses.end(), acc.begin(), acc.end());
            }

            if (verbose) {
                std::cerr << "[  Extracted " << accesses.size()
                          << " symbol access(es) ]\n";
            }

            topo::check::CheckResult result;
            topo::check::checkPurity(req.symbolTable, accesses, result);
            if (purityMode == topo::FeatureMode::Force) {
                for (auto& d : result.diagnostics) {
                    if (d.severity == topo::check::Severity::Warning)
                        d.severity = topo::check::Severity::Error;
                }
                result.errorCount += result.warningCount;
                result.warningCount = 0;
            }
            reportDiag(result);
        } else {
            std::cerr << "  Skipped (mode=off).\n";
        }

        // ---- [5/6] Stage-isolation check ----
        checkCount++;
        std::cerr << "[" << checkCount << "/" << totalChecks
                  << "] Checking stage isolation...\n";
        if (stageIsolationMode != topo::FeatureMode::Off) {
            topo::check::TypeScriptCallEdgeExtractor edgeExtractor;
            std::vector<topo::check::CallEdge> callEdges;
            for (const auto& f : sourceFiles) {
                auto edges = edgeExtractor.extractCallEdges(f);
                callEdges.insert(callEdges.end(), edges.begin(), edges.end());
            }

            if (verbose) {
                std::cerr << "[  Extracted " << callEdges.size()
                          << " call edge(s) ]\n";
            }

            topo::check::CheckResult result;
            topo::check::checkStageIsolation(req.symbolTable, callEdges, result);
            if (stageIsolationMode == topo::FeatureMode::Force) {
                for (auto& d : result.diagnostics) {
                    if (d.severity == topo::check::Severity::Warning)
                        d.severity = topo::check::Severity::Error;
                }
                result.errorCount += result.warningCount;
                result.warningCount = 0;
            }
            reportDiag(result);
        } else {
            std::cerr << "  Skipped (mode=off).\n";
        }

        // ---- [6/6] Import-path check ----
        checkCount++;
        std::cerr << "[" << checkCount << "/" << totalChecks
                  << "] Checking import paths...\n";
        {
            topo::analysis::ImportPathConfig ipCfg;
            ipCfg.projectDir = fs::current_path().string();
            ipCfg.searchDirs = req.includeDirs;
            ipCfg.language = topo::HostLanguage::TypeScript;
            ipCfg.warnOnly = false;

            topo::check::CheckResult result;
            topo::analysis::checkImportPaths(req.symbolTable, ipCfg, result);
            reportDiag(result);
        }

        bool hasError = totalErrors > 0 && !req.config.warnOnly;
        if (hasError) {
            std::cerr << "[topo-build-typescript] Check failed (" << totalErrors
                      << " error(s), " << totalWarnings << " warning(s)).\n";
            return 1;
        }

        if (totalErrors == 0 && totalWarnings == 0) {
            std::cerr << "[topo-build-typescript] All checks passed.\n";
        } else {
            std::cerr << "[topo-build-typescript] Checks completed ("
                      << totalWarnings << " warning(s)).\n";
        }
    } else if (verbose) {
        std::cerr << "[topo-build-typescript] Skipping verification (noVerify).\n";
    }

    // --- Step 5: Visibility transform (if enabled) ---
    //
    // Controlled by [transforms.visibility].mode in Topo.toml:
    //   off   → never run (default)
    //   auto  → run iff there is at least one non-public visibility entry
    //   force → always run (even when only public entries exist)
    //
    // Output is mirrored under the project's [build].output directory,
    // preserving each source file's path relative to the project root.
    // If output is unset, the transform skips with a warning rather than
    // overwriting source files in place.
    auto visibilityTransformMode = readModeWithDefault(
        tomlPath, "transforms.visibility", topo::FeatureMode::Off);

    auto simpleName = [](const std::string& qn) -> std::string {
        auto pos = qn.find_last_of(":.");
        return (pos != std::string::npos) ? qn.substr(pos + 1) : qn;
    };

    // .topo simple-name → action ("private"|"internal"). The TS symbol
    // extractor does NOT produce `::`-qualified names (TS modules are files,
    // not Topo namespaces), so qualified matching is unavailable. We match
    // by simple name and look up each host symbol's actual file from the
    // extractor's HostSymbol record.
    std::unordered_map<std::string, const char*> nameToAction;
    for (const auto& ve : req.visibilityEntries) {
        if (ve.visibility == topo::Visibility::Private)
            nameToAction[simpleName(ve.qualifiedName)] = "private";
        else if (ve.visibility == topo::Visibility::Internal)
            nameToAction[simpleName(ve.qualifiedName)] = "internal";
    }

    // file path → { simple name → "private"|"internal" }. File scoping
    // limits the blast radius vs. a project-wide simple-name map: only
    // files whose extractor sees a matching declaration are touched.
    //
    // Known limitation: if two .ts files both declare a top-level symbol
    // with the same simple name AND .topo specifies visibility for it
    // (e.g. `app::helper` private, `util::helper` public), both files
    // will be rewritten the same way. Disambiguation requires the
    // extractor to attach a namespace-qualified name matching .topo's
    // `::` convention — out of scope here.
    nlohmann::json fileVisibilityMaps = nlohmann::json::object();
    int nonPublicCount = 0;
    if (!nameToAction.empty()) {
        topo::check::TypeScriptSymbolExtractor extractor;
        auto hostSymbols = extractor.extractAll(sourceFiles);
        for (const auto& hs : hostSymbols) {
            if (hs.file.empty()) continue;
            auto it = nameToAction.find(hs.simpleName);
            if (it == nameToAction.end()) continue;
            fileVisibilityMaps[hs.file][hs.simpleName] = it->second;
            ++nonPublicCount;
        }
    }

    bool runTransform = false;
    if (visibilityTransformMode == topo::FeatureMode::Force) {
        runTransform = true;
    } else if (visibilityTransformMode == topo::FeatureMode::Auto) {
        runTransform = nonPublicCount > 0;
    }

    if (runTransform) {
        const bool isForce = (visibilityTransformMode == topo::FeatureMode::Force);
        std::string outRoot = !req.outputPath.empty()
                                  ? req.outputPath
                                  : req.config.outputPath;
        if (outRoot.empty()) {
            // force ⇒ build error; auto ⇒ warn-and-skip (auto must never break
            // builds whose Topo.toml lacks [build].output).
            const char* level = isForce ? "error" : "warning";
            std::cerr << level
                      << ": [transforms.visibility].mode is '"
                      << (isForce ? "force" : "auto")
                      << "' but [build].output is unset — refusing to "
                         "overwrite source files in place.\n";
            if (isForce) return 1;
        } else {
            std::cerr << "[topo-build-typescript] Running visibility transform...\n";

            // Resolve transform tool path relative to this binary. Use
            // platform getExecutableDir() which follows symlinks — topo-build
            // invokes us via a symlink, so argv[0].parent_path() points to the
            // wrong directory.
            std::string exeDir = topo::platform::getExecutableDir();
            fs::path toolDir = (exeDir.empty()
                                    ? fs::path(argv[0]).parent_path()
                                    : fs::path(exeDir)) /
                               "visibility-transform";
            fs::path toolPath = toolDir / "index.mjs";

            if (!fs::exists(toolPath)) {
                const char* level = isForce ? "error" : "warning";
                std::cerr << level << ": transform tool not found at "
                          << toolPath << "\n";
                if (isForce) return 1;
            } else {
                nlohmann::json files = nlohmann::json::array();
                for (const auto& f : sourceFiles) {
                    std::ifstream in(f);
                    if (!in) continue;
                    std::ostringstream oss;
                    oss << in.rdbuf();
                    files.push_back({
                        {"path", f},
                        {"content", oss.str()},
                    });
                }

                nlohmann::json request;
                request["files"] = files;
                request["fileVisibilityMaps"] = fileVisibilityMaps;

                std::string tmpPath =
                    (topo::platform::tempDirectory() / "topo-vis-transform.json").string();
                {
                    std::ofstream tmp(tmpPath);
                    tmp << request.dump();
                }

                auto result = topo::platform::runProcessCapture(
                    nodePath, {toolPath.string(), tmpPath});

                bool transformOk = false;
                if (result.exitCode != 0) {
                    const char* level = isForce ? "error" : "warning";
                    std::cerr << level << ": transform tool exited "
                              << result.exitCode << "\n" << result.stderrOutput;
                } else {
                    auto response = nlohmann::json::parse(
                        result.stdoutOutput.empty() ? "{}" : result.stdoutOutput);
                    if (response.value("success", false)) {
                        fs::path projectDir = fs::current_path();
                        fs::path outDirAbs = fs::absolute(fs::path(outRoot));

                        int writtenCount = 0;
                        for (const auto& r : response["results"]) {
                            if (!r.value("transformed", false)) continue;
                            std::string outputContent = r.value("outputContent", "");
                            if (outputContent.empty()) continue;

                            fs::path srcAbs = fs::absolute(
                                fs::path(r["path"].get<std::string>()));

                            // Mirror project-relative path under outDir.
                            // Falls back to filename if source lives outside the project.
                            fs::path relPath;
                            std::error_code relEc;
                            relPath = fs::relative(srcAbs, projectDir, relEc);
                            if (relEc || relPath.empty() ||
                                relPath.string().rfind("..", 0) == 0) {
                                relPath = srcAbs.filename();
                            }

                            fs::path dest = outDirAbs / relPath;
                            if (verbose) {
                                std::cerr << "[topo-build-typescript] Writing "
                                          << dest << "\n";
                            }
                            std::error_code mkEc;
                            fs::create_directories(dest.parent_path(), mkEc);
                            std::ofstream out(dest);
                            out << outputContent;
                            ++writtenCount;
                        }
                        std::cerr << "[topo-build-typescript] Transform complete ("
                                  << writtenCount << " file(s) written to "
                                  << outDirAbs.string() << ").\n";
                        transformOk = true;

                        // VisibilityPass sidecar.
                        // Write `<outRoot>.topo-passes/VisibilityPass.json` with
                        // the common header + rewrites list. Mirrors the
                        // LLVM-side `<output>.topo-passes/<PassName>.json`
                        // directory protocol so cross-backend `topo debug`
                        // consumers see the same shape. Sidecar writes are
                        // non-load-bearing: failure logs to stderr, build
                        // continues.
                        {
                            using nlohmann::json;
                            json sidecar = json::object();
                            json header = json::object();
                            header["pass"] = "VisibilityPass";
                            header["category"] = "COVERED";
                            header["fired"] = writtenCount > 0;
                            header["fired_count"] = writtenCount;
                            header["decision"] =
                                writtenCount > 0
                                    ? std::string(isForce ? "forced_applied"
                                                          : "auto_applied")
                                    : std::string("no_rewrites");
                            header["reason"] =
                                writtenCount > 0
                                    ? "rewrote private/internal declarations to "
                                      "_typo-prefixed names; runtime visibility "
                                      "enforced via emitted guards"
                                    : "transform ran but no source file required "
                                      "a visibility rewrite";
                            header["elapsed_ns"] = 0;
                            sidecar["header"] = std::move(header);

                            json rewrites = json::array();
                            for (const auto& r : response["results"]) {
                                if (!r.value("transformed", false)) continue;
                                std::string p = r.value("path", "");
                                if (p.empty()) continue;
                                fs::path srcAbs = fs::absolute(fs::path(p));
                                std::error_code relEc;
                                fs::path relPath =
                                    fs::relative(srcAbs, fs::current_path(),
                                                 relEc);
                                std::string hostFile =
                                    (relEc || relPath.empty() ||
                                     relPath.string().rfind("..", 0) == 0)
                                        ? srcAbs.filename().string()
                                        : relPath.string();
                                json row = json::object();
                                row["host_file"] = hostFile;
                                row["transformed"] = true;
                                rewrites.push_back(std::move(row));
                            }
                            sidecar["rewrites"] = std::move(rewrites);

                            fs::path sidecarDir =
                                fs::path(outRoot + ".topo-passes");
                            std::error_code mkEc;
                            fs::create_directories(sidecarDir, mkEc);
                            if (!mkEc) {
                                fs::path dest =
                                    sidecarDir / "VisibilityPass.json";
                                fs::path tmp = dest;
                                tmp += ".tmp";
                                {
                                    std::ofstream sf(tmp, std::ios::binary |
                                                              std::ios::trunc);
                                    if (sf) sf << sidecar.dump(2) << "\n";
                                }
                                std::error_code rnEc;
                                fs::rename(tmp, dest, rnEc);
                                if (rnEc) {
                                    std::cerr
                                        << "warning: failed to write "
                                        << dest.string() << ": "
                                        << rnEc.message() << "\n";
                                } else if (verbose) {
                                    std::cerr
                                        << "[topo-build-typescript] Sidecar: "
                                        << dest.string() << "\n";
                                }
                            } else if (verbose) {
                                std::cerr << "warning: cannot create "
                                          << sidecarDir.string() << ": "
                                          << mkEc.message() << "\n";
                            }
                        }
                    } else {
                        const char* level = isForce ? "error" : "warning";
                        std::cerr << level << ": transform failed: "
                                  << response.value("error", "unknown error")
                                  << "\n";
                    }
                }

                std::remove(tmpPath.c_str());

                if (isForce && !transformOk) return 1;
            }
        }
    }

    // --- Step 5b: Containment guard transform (if enabled) ---
    //
    // Controlled by [transforms.containment_guard].mode in Topo.toml:
    //   off   → never run (default)
    //   auto  → run iff there is at least one non-external function declared
    //   force → always run (even when only external functions exist)
    //
    // For each non-external function declared in .topo, the transform injects
    // a runtime guard that throws on use of restricted APIs (eval / new
    // Function / dynamic import() / Reflect.*) inside that function's body.
    // External functions are left untouched — they are the declared boundary
    // through which restricted APIs are *permitted* to flow. Pairs with
    // ContainmentCheck (static warnings) to give runtime enforcement.
    //
    // Output is mirrored under the project's [build].output directory,
    // preserving each source file's path relative to the project root.
    // If output is unset, the transform skips with a warning (auto) or fails
    // the build (force) rather than overwriting source files in place.
    auto containmentGuardMode = readModeWithDefault(
        tomlPath, "transforms.containment_guard", topo::FeatureMode::Off);

    // file path → list of non-external simple names declared in that file.
    // Functions whose .topo declaration is `external` are intentionally
    // excluded — they ARE the declared boundary and the guard would defeat
    // its own contract by blocking them.
    nlohmann::json fileGuardTargets = nlohmann::json::object();
    int nonExternalCount = 0;
    {
        // Collect the simple-name set of non-external .topo functions.
        // .topo `external` is a function-level modifier — not visibility —
        // so we read it off FunctionSymbol::isExternal regardless of the
        // declared Visibility.
        std::unordered_set<std::string> nonExternalSimpleNames;
        for (const auto& [_, fn] : req.symbolTable.functions()) {
            if (!fn.isExternal) {
                nonExternalSimpleNames.insert(fn.simpleName);
            }
        }

        if (!nonExternalSimpleNames.empty()) {
            // Map host TS function symbols back to their file by simple name.
            // Reuses TypeScriptSymbolExtractor (same pattern as visibility
            // transform); we run our own invocation rather than sharing
            // results — the two passes have independent lifecycles.
            topo::check::TypeScriptSymbolExtractor extractor;
            auto hostSymbols = extractor.extractAll(sourceFiles);
            for (const auto& hs : hostSymbols) {
                if (hs.file.empty()) continue;
                if (!nonExternalSimpleNames.count(hs.simpleName)) continue;
                fileGuardTargets[hs.file].push_back(hs.simpleName);
                ++nonExternalCount;
            }
        }
    }

    bool runGuardTransform = false;
    if (containmentGuardMode == topo::FeatureMode::Force) {
        runGuardTransform = true;
    } else if (containmentGuardMode == topo::FeatureMode::Auto) {
        runGuardTransform = nonExternalCount > 0;
    }

    if (runGuardTransform) {
        const bool isForce = (containmentGuardMode == topo::FeatureMode::Force);
        std::string outRoot = !req.outputPath.empty()
                                  ? req.outputPath
                                  : req.config.outputPath;
        if (outRoot.empty()) {
            const char* level = isForce ? "error" : "warning";
            std::cerr << level
                      << ": [transforms.containment_guard].mode is '"
                      << (isForce ? "force" : "auto")
                      << "' but [build].output is unset — refusing to "
                         "overwrite source files in place.\n";
            if (isForce) return 1;
        } else {
            std::cerr << "[topo-build-typescript] Running containment guard "
                         "transform...\n";

            std::string exeDir = topo::platform::getExecutableDir();
            fs::path toolDir = (exeDir.empty()
                                    ? fs::path(argv[0]).parent_path()
                                    : fs::path(exeDir)) /
                               "containment-guard-transform";
            fs::path toolPath = toolDir / "index.mjs";

            if (!fs::exists(toolPath)) {
                const char* level = isForce ? "error" : "warning";
                std::cerr << level << ": transform tool not found at "
                          << toolPath << "\n";
                if (isForce) return 1;
            } else {
                // Re-read source files from disk. If VisibilityPass already
                // wrote rewritten copies into dist/, those are the inputs
                // we ideally want to guard. But VisibilityPass writes to
                // outDir while keeping `sourceFiles` pointed at the original
                // src/ paths — so we read from src/ here. Composing the two
                // transforms cleanly is a follow-up (would require running
                // them via a single pipeline node, not two independent
                // subprocesses). For now: containment guard operates on the
                // pristine sources; the dist/ output from this pass replaces
                // visibility-transform's output if both target the same file.
                nlohmann::json files = nlohmann::json::array();
                for (const auto& f : sourceFiles) {
                    std::ifstream in(f);
                    if (!in) continue;
                    std::ostringstream oss;
                    oss << in.rdbuf();
                    files.push_back({
                        {"path", f},
                        {"content", oss.str()},
                    });
                }

                nlohmann::json request;
                request["files"] = files;
                request["fileGuardTargets"] = fileGuardTargets;

                std::string tmpPath =
                    (topo::platform::tempDirectory() /
                     "topo-cg-transform.json").string();
                {
                    std::ofstream tmp(tmpPath);
                    tmp << request.dump();
                }

                auto result = topo::platform::runProcessCapture(
                    nodePath, {toolPath.string(), tmpPath});

                bool transformOk = false;
                if (result.exitCode != 0) {
                    const char* level = isForce ? "error" : "warning";
                    std::cerr << level << ": transform tool exited "
                              << result.exitCode << "\n" << result.stderrOutput;
                } else {
                    auto response = nlohmann::json::parse(
                        result.stdoutOutput.empty() ? "{}" : result.stdoutOutput);
                    if (response.value("success", false)) {
                        fs::path projectDir = fs::current_path();
                        fs::path outDirAbs = fs::absolute(fs::path(outRoot));

                        int writtenCount = 0;
                        for (const auto& r : response["results"]) {
                            if (!r.value("transformed", false)) continue;
                            std::string outputContent = r.value("outputContent", "");
                            if (outputContent.empty()) continue;

                            fs::path srcAbs = fs::absolute(
                                fs::path(r["path"].get<std::string>()));

                            fs::path relPath;
                            std::error_code relEc;
                            relPath = fs::relative(srcAbs, projectDir, relEc);
                            if (relEc || relPath.empty() ||
                                relPath.string().rfind("..", 0) == 0) {
                                relPath = srcAbs.filename();
                            }

                            fs::path dest = outDirAbs / relPath;
                            if (verbose) {
                                std::cerr << "[topo-build-typescript] Writing "
                                          << dest << "\n";
                            }
                            std::error_code mkEc;
                            fs::create_directories(dest.parent_path(), mkEc);
                            std::ofstream out(dest);
                            out << outputContent;
                            ++writtenCount;
                        }
                        std::cerr << "[topo-build-typescript] Containment "
                                     "guard complete (" << writtenCount
                                  << " file(s) written to "
                                  << outDirAbs.string() << ").\n";
                        transformOk = true;

                        // ContainmentGuardPass sidecar.
                        // Same protocol as VisibilityPass: `<outRoot>.topo-
                        // passes/ContainmentGuardPass.json`. This Pass has a
                        // runtime profile (runtime guards throw when
                        // restricted APIs are touched), but the debug-
                        // side static record is still useful — the host-
                        // agnostic consumer treats every sidecar uniformly,
                        // and "did this Pass actually rewrite anything"
                        // is a routine query during build triage.
                        {
                            using nlohmann::json;
                            json sidecar = json::object();
                            json header = json::object();
                            header["pass"] = "ContainmentGuardPass";
                            header["category"] = "ENHANCE";
                            header["fired"] = writtenCount > 0;
                            header["fired_count"] = writtenCount;
                            header["decision"] =
                                writtenCount > 0
                                    ? std::string(isForce ? "forced_applied"
                                                          : "auto_applied")
                                    : std::string("no_rewrites");
                            header["reason"] =
                                writtenCount > 0
                                    ? "injected runtime guards on non-"
                                      "external functions to throw on use "
                                      "of restricted APIs (eval / new "
                                      "Function / dynamic import / "
                                      "Reflect.*)"
                                    : "transform ran but no file required a "
                                      "containment guard rewrite";
                            header["elapsed_ns"] = 0;
                            sidecar["header"] = std::move(header);

                            json guards = json::array();
                            for (const auto& r : response["results"]) {
                                if (!r.value("transformed", false)) continue;
                                std::string p = r.value("path", "");
                                if (p.empty()) continue;
                                fs::path srcAbs = fs::absolute(fs::path(p));
                                std::error_code relEc;
                                fs::path relPath =
                                    fs::relative(srcAbs, fs::current_path(),
                                                 relEc);
                                std::string hostFile =
                                    (relEc || relPath.empty() ||
                                     relPath.string().rfind("..", 0) == 0)
                                        ? srcAbs.filename().string()
                                        : relPath.string();
                                json row = json::object();
                                row["host_file"] = hostFile;
                                row["transformed"] = true;
                                if (r.contains("changes") &&
                                    r["changes"].is_array()) {
                                    row["changes"] = r["changes"];
                                }
                                guards.push_back(std::move(row));
                            }
                            sidecar["guards"] = std::move(guards);

                            fs::path sidecarDir =
                                fs::path(outRoot + ".topo-passes");
                            std::error_code mkEc;
                            fs::create_directories(sidecarDir, mkEc);
                            if (!mkEc) {
                                fs::path dest =
                                    sidecarDir / "ContainmentGuardPass.json";
                                fs::path tmp = dest;
                                tmp += ".tmp";
                                {
                                    std::ofstream sf(tmp, std::ios::binary |
                                                              std::ios::trunc);
                                    if (sf) sf << sidecar.dump(2) << "\n";
                                }
                                std::error_code rnEc;
                                fs::rename(tmp, dest, rnEc);
                                if (rnEc) {
                                    std::cerr
                                        << "warning: failed to write "
                                        << dest.string() << ": "
                                        << rnEc.message() << "\n";
                                } else if (verbose) {
                                    std::cerr
                                        << "[topo-build-typescript] "
                                           "Sidecar: " << dest.string()
                                        << "\n";
                                }
                            }
                        }
                    } else {
                        const char* level = isForce ? "error" : "warning";
                        std::cerr << level << ": transform failed: "
                                  << response.value("error", "unknown error")
                                  << "\n";
                    }
                }

                std::remove(tmpPath.c_str());

                if (isForce && !transformOk) return 1;
            }
        }
    }

    // --- Step 5c: Stage assert transform (if enabled) ---
    //
    // Controlled by [transforms.stage_assert].mode in Topo.toml:
    //   off   → never run (default)
    //   auto  → run iff any .topo fn has at least one stage<N> declaration
    //   force → always run
    //
    // For each .topo fn with stage<N> operations, the transform injects a
    // monotonic stage counter into the matching host function's body and
    // wraps every stage-mapped callsite with an assertion that throws when
    // the call would violate the declared ordering. Pairs with
    // StageIsolationCheck (static call-graph check) to give runtime witness
    // of stage discipline.
    //
    // Output is mirrored under [build].output. Missing output is a build
    // error under force and a warn-and-skip under auto.
    auto stageAssertMode = readModeWithDefault(
        tomlPath, "transforms.stage_assert", topo::FeatureMode::Off);

    // file path → { simple fn name → [[callees_stage1], [callees_stage2], ...] }.
    //
    // We build this by walking SymbolTable.logicBlocks (which carries parallel
    // arrays `calledFunctions[i]` + `stages[i]` per .topo fn) and mapping each
    // owning host function back to its file via TypeScriptSymbolExtractor.
    // Pipeline-style logicBlocks (`stages` array empty / all-zero) carry no
    // stage discipline and are skipped — stage assertions need declared stage
    // numbers, not pipeline DAG edges.
    nlohmann::json fileStageMaps = nlohmann::json::object();
    int stagedFnCount = 0;
    {
        // Map .topo qualified function name → stage buckets (vector indexed
        // by stage-1; bucket value = list of callee simple names).
        std::unordered_map<std::string,
                           std::vector<std::vector<std::string>>>
            qnToBuckets;
        for (const auto& [qn, lb] : req.symbolTable.logicBlocks()) {
            // Skip pipelines and blocks with no stage<N> markers. A
            // logicBlock has stages[i] == 0 for every operation when the
            // fn body uses no `stage<N>` keyword (e.g. pipeline edges).
            int maxStage = 0;
            for (int s : lb.stages) {
                if (s > maxStage) maxStage = s;
            }
            if (maxStage == 0) continue;

            std::vector<std::vector<std::string>> buckets(maxStage);
            for (size_t i = 0; i < lb.calledFunctions.size() &&
                               i < lb.stages.size(); ++i) {
                int stage = lb.stages[i];
                if (stage <= 0 || stage > maxStage) continue;
                buckets[stage - 1].push_back(lb.calledFunctions[i]);
            }
            qnToBuckets[qn] = std::move(buckets);
        }

        if (!qnToBuckets.empty()) {
            // Resolve .topo fn name → host file via the same simple-name path
            // visibility / containment-guard use. Two different .topo fns
            // with the same simple name in different namespaces will collide
            // here just like in the other two passes; live with the same
            // limitation for parity.
            std::unordered_map<std::string,
                               std::vector<std::vector<std::string>>>
                simpleToBuckets;
            for (auto& [qn, buckets] : qnToBuckets) {
                auto pos = qn.find_last_of(":.");
                std::string simple = (pos != std::string::npos)
                                         ? qn.substr(pos + 1)
                                         : qn;
                // Highest stage wins on simple-name collisions — same
                // defensive rule as the JS-side flattenStageMap.
                auto it = simpleToBuckets.find(simple);
                if (it == simpleToBuckets.end() ||
                    it->second.size() < buckets.size()) {
                    simpleToBuckets[simple] = std::move(buckets);
                }
            }

            topo::check::TypeScriptSymbolExtractor extractor;
            auto hostSymbols = extractor.extractAll(sourceFiles);
            for (const auto& hs : hostSymbols) {
                if (hs.file.empty()) continue;
                auto it = simpleToBuckets.find(hs.simpleName);
                if (it == simpleToBuckets.end()) continue;
                nlohmann::json bucketsJson = nlohmann::json::array();
                for (const auto& b : it->second) {
                    bucketsJson.push_back(b);
                }
                fileStageMaps[hs.file][hs.simpleName] = std::move(bucketsJson);
                ++stagedFnCount;
            }
        }
    }

    bool runStageAssert = false;
    if (stageAssertMode == topo::FeatureMode::Force) {
        runStageAssert = true;
    } else if (stageAssertMode == topo::FeatureMode::Auto) {
        runStageAssert = stagedFnCount > 0;
    }

    if (runStageAssert) {
        const bool isForce = (stageAssertMode == topo::FeatureMode::Force);
        std::string outRoot = !req.outputPath.empty()
                                  ? req.outputPath
                                  : req.config.outputPath;
        if (outRoot.empty()) {
            const char* level = isForce ? "error" : "warning";
            std::cerr << level
                      << ": [transforms.stage_assert].mode is '"
                      << (isForce ? "force" : "auto")
                      << "' but [build].output is unset — refusing to "
                         "overwrite source files in place.\n";
            if (isForce) return 1;
        } else {
            std::cerr << "[topo-build-typescript] Running stage assert "
                         "transform...\n";

            std::string exeDir = topo::platform::getExecutableDir();
            fs::path toolDir = (exeDir.empty()
                                    ? fs::path(argv[0]).parent_path()
                                    : fs::path(exeDir)) /
                               "stage-assert-transform";
            fs::path toolPath = toolDir / "index.mjs";

            if (!fs::exists(toolPath)) {
                const char* level = isForce ? "error" : "warning";
                std::cerr << level << ": transform tool not found at "
                          << toolPath << "\n";
                if (isForce) return 1;
            } else {
                // Same composition note as containment-guard: when multiple
                // transforms are enabled they read from src/ independently;
                // the last-write-wins to dist/. This fixture only enables
                // stage_assert so the question doesn't arise.
                nlohmann::json files = nlohmann::json::array();
                for (const auto& f : sourceFiles) {
                    std::ifstream in(f);
                    if (!in) continue;
                    std::ostringstream oss;
                    oss << in.rdbuf();
                    files.push_back({
                        {"path", f},
                        {"content", oss.str()},
                    });
                }

                nlohmann::json request;
                request["files"] = files;
                request["fileStageMaps"] = fileStageMaps;

                std::string tmpPath =
                    (topo::platform::tempDirectory() /
                     "topo-sa-transform.json").string();
                {
                    std::ofstream tmp(tmpPath);
                    tmp << request.dump();
                }

                auto result = topo::platform::runProcessCapture(
                    nodePath, {toolPath.string(), tmpPath});

                bool transformOk = false;
                if (result.exitCode != 0) {
                    const char* level = isForce ? "error" : "warning";
                    std::cerr << level << ": transform tool exited "
                              << result.exitCode << "\n" << result.stderrOutput;
                } else {
                    auto response = nlohmann::json::parse(
                        result.stdoutOutput.empty() ? "{}" : result.stdoutOutput);
                    if (response.value("success", false)) {
                        fs::path projectDir = fs::current_path();
                        fs::path outDirAbs = fs::absolute(fs::path(outRoot));

                        int writtenCount = 0;
                        for (const auto& r : response["results"]) {
                            if (!r.value("transformed", false)) continue;
                            std::string outputContent =
                                r.value("outputContent", "");
                            if (outputContent.empty()) continue;

                            fs::path srcAbs = fs::absolute(
                                fs::path(r["path"].get<std::string>()));

                            fs::path relPath;
                            std::error_code relEc;
                            relPath = fs::relative(srcAbs, projectDir, relEc);
                            if (relEc || relPath.empty() ||
                                relPath.string().rfind("..", 0) == 0) {
                                relPath = srcAbs.filename();
                            }

                            fs::path dest = outDirAbs / relPath;
                            if (verbose) {
                                std::cerr << "[topo-build-typescript] Writing "
                                          << dest << "\n";
                            }
                            std::error_code mkEc;
                            fs::create_directories(dest.parent_path(), mkEc);
                            std::ofstream out(dest);
                            out << outputContent;
                            ++writtenCount;
                        }
                        std::cerr << "[topo-build-typescript] Stage assert "
                                     "complete (" << writtenCount
                                  << " file(s) written to "
                                  << outDirAbs.string() << ").\n";
                        transformOk = true;

                        // StageAssertPass sidecar. Mirrors
                        // VisibilityPass + ContainmentGuardPass schema.
                        // `assertions:[{host_file, transformed, changes[]}]`.
                        // Pass has a runtime profile (runtime throw on
                        // stage-order violation), but the static
                        // sidecar enables `pass_decision("StageAssertPass")`
                        // queries through the host-agnostic CLI.
                        {
                            using nlohmann::json;
                            json sidecar = json::object();
                            json header = json::object();
                            header["pass"] = "StageAssertPass";
                            header["category"] = "ENHANCE";
                            header["fired"] = writtenCount > 0;
                            header["fired_count"] = writtenCount;
                            header["decision"] =
                                writtenCount > 0
                                    ? std::string(isForce ? "forced_applied"
                                                          : "auto_applied")
                                    : std::string("no_rewrites");
                            header["reason"] =
                                writtenCount > 0
                                    ? "injected monotonic stage counter + "
                                      "per-callsite stage assertion so "
                                      "out-of-order calls throw at runtime"
                                    : "transform ran but no file required a "
                                      "stage-assertion rewrite";
                            header["elapsed_ns"] = 0;
                            sidecar["header"] = std::move(header);

                            json assertions = json::array();
                            for (const auto& r : response["results"]) {
                                if (!r.value("transformed", false)) continue;
                                std::string p = r.value("path", "");
                                if (p.empty()) continue;
                                fs::path srcAbs = fs::absolute(fs::path(p));
                                std::error_code relEc;
                                fs::path relPath =
                                    fs::relative(srcAbs, fs::current_path(),
                                                 relEc);
                                std::string hostFile =
                                    (relEc || relPath.empty() ||
                                     relPath.string().rfind("..", 0) == 0)
                                        ? srcAbs.filename().string()
                                        : relPath.string();
                                json row = json::object();
                                row["host_file"] = hostFile;
                                row["transformed"] = true;
                                if (r.contains("changes") &&
                                    r["changes"].is_array()) {
                                    row["changes"] = r["changes"];
                                }
                                assertions.push_back(std::move(row));
                            }
                            sidecar["assertions"] = std::move(assertions);

                            fs::path sidecarDir =
                                fs::path(outRoot + ".topo-passes");
                            std::error_code mkEc;
                            fs::create_directories(sidecarDir, mkEc);
                            if (!mkEc) {
                                fs::path dest =
                                    sidecarDir / "StageAssertPass.json";
                                fs::path tmp = dest;
                                tmp += ".tmp";
                                {
                                    std::ofstream sf(tmp, std::ios::binary |
                                                              std::ios::trunc);
                                    if (sf) sf << sidecar.dump(2) << "\n";
                                }
                                std::error_code rnEc;
                                fs::rename(tmp, dest, rnEc);
                                if (rnEc) {
                                    std::cerr
                                        << "warning: failed to write "
                                        << dest.string() << ": "
                                        << rnEc.message() << "\n";
                                } else if (verbose) {
                                    std::cerr
                                        << "[topo-build-typescript] "
                                           "Sidecar: " << dest.string()
                                        << "\n";
                                }
                            }
                        }
                    } else {
                        const char* level = isForce ? "error" : "warning";
                        std::cerr << level << ": transform failed: "
                                  << response.value("error", "unknown error")
                                  << "\n";
                    }
                }

                std::remove(tmpPath.c_str());

                if (isForce && !transformOk) return 1;
            }
        }
    }

    // --- Step 6: Create output directory ---
    if (!req.config.outputPath.empty()) {
        std::error_code ec;
        fs::create_directories(req.config.outputPath, ec);
    }

    // --- Step 7: tsc_sourcemap_link sidecar ---
    //
    // The TypeScript backend is check-only: the user runs tsc themselves
    // and the resulting `.js` + `.js.map` land in the build output dir.
    // We don't transpile, but we DO record the `.ts` ↔ `.js` ↔ `.js.map`
    // correspondence so `topo debug` / `topo profile` can reverse V8
    // frame locations back to the original sources without re-parsing
    // every map. This is a compiler-passthrough record, not a Topo Pass —
    // `category` is INFRA. Sidecar shape mirrors the other per-Pass
    // sidecars (common 7-field header + an `entries[]` payload). Failure
    // to write is non-fatal: it logs and the build still succeeds.
    {
        std::string smOutRoot = !req.outputPath.empty()
                                    ? req.outputPath
                                    : req.config.outputPath;
        if (!smOutRoot.empty()) {
            using nlohmann::json;
            json entries = json::array();
            fs::path scanDir = fs::path(smOutRoot);
            std::error_code scanEc;
            if (fs::exists(scanDir, scanEc) &&
                fs::is_directory(scanDir, scanEc)) {
                for (auto it = fs::recursive_directory_iterator(
                         scanDir,
                         fs::directory_options::skip_permission_denied,
                         scanEc);
                     it != fs::recursive_directory_iterator(); ++it) {
                    const fs::path& p = it->path();
                    std::error_code feEc;
                    if (!fs::is_regular_file(p, feEc)) continue;
                    if (p.extension() != ".js") continue;
                    fs::path mapPath = p;
                    mapPath += ".map";
                    if (!fs::exists(mapPath, feEc)) continue;

                    // Recover the original `.ts` file: prefer the map's
                    // `sources[0]` (resolved against `sourceRoot` when
                    // present, matching tsc's emit), fall back to the
                    // `.js` stem with a `.ts` extension.
                    std::string tsFile;
                    {
                        std::ifstream mf(mapPath);
                        if (mf) {
                            std::ostringstream ss;
                            ss << mf.rdbuf();
                            try {
                                json mj = json::parse(ss.str());
                                std::string sourceRoot;
                                if (mj.contains("sourceRoot") &&
                                    mj["sourceRoot"].is_string()) {
                                    sourceRoot =
                                        mj["sourceRoot"].get<std::string>();
                                }
                                if (mj.contains("sources") &&
                                    mj["sources"].is_array() &&
                                    !mj["sources"].empty() &&
                                    mj["sources"][0].is_string()) {
                                    std::string s0 =
                                        mj["sources"][0].get<std::string>();
                                    if (sourceRoot.empty()) {
                                        tsFile = s0;
                                    } else if (!sourceRoot.empty() &&
                                               sourceRoot.back() == '/') {
                                        tsFile = sourceRoot + s0;
                                    } else {
                                        tsFile = sourceRoot + "/" + s0;
                                    }
                                }
                            } catch (const std::exception&) {
                                // Malformed map → fall through to stem.
                            }
                        }
                    }
                    if (tsFile.empty()) {
                        fs::path stem = p;
                        stem.replace_extension(".ts");
                        tsFile = stem.filename().string();
                    }

                    json row = json::object();
                    row["ts_file"] = tsFile;
                    row["js_file"] = p.filename().string();
                    row["sourcemap_path"] = mapPath.filename().string();
                    entries.push_back(std::move(row));
                }
            }

            json sidecar = json::object();
            const bool fired = !entries.empty();
            sidecar["pass"] = "tsc_sourcemap_link";
            sidecar["category"] = "INFRA";
            sidecar["fired"] = fired;
            sidecar["fired_count"] = static_cast<int>(entries.size());
            sidecar["decision"] = fired ? "applied" : "no_maps_found";
            sidecar["reason"] =
                fired ? "linked tsc-emitted .js.map files back to their "
                        ".ts sources for V8 frame reverse-mapping"
                      : "scanned output directory but found no .js with a "
                        "sibling .js.map (tsc --sourceMap not enabled?)";
            sidecar["elapsed_ns"] = 0;
            sidecar["entries"] = std::move(entries);

            fs::path sidecarDir = fs::path(smOutRoot + ".topo-passes");
            std::error_code mkEc;
            fs::create_directories(sidecarDir, mkEc);
            if (!mkEc) {
                fs::path dest = sidecarDir / "tsc_sourcemap_link.json";
                fs::path tmp = dest;
                tmp += ".tmp";
                {
                    std::ofstream sf(
                        tmp, std::ios::binary | std::ios::trunc);
                    if (sf) sf << sidecar.dump(2) << "\n";
                }
                std::error_code rnEc;
                fs::rename(tmp, dest, rnEc);
                if (rnEc) {
                    std::cerr << "warning: failed to write "
                              << dest.string() << ": " << rnEc.message()
                              << "\n";
                }
            }
        }
    }

    return 0;
}
