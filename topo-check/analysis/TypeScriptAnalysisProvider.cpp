#include "TypeScriptAnalysisProvider.h"
#include "TypeScriptCallEdgeExtractor.h"
#include "TypeScriptCallSiteExtractor.h"
#include "TypeScriptImportExtractor.h"
#include "TypeScriptSymbolAccessExtractor.h"
#include "TypeScriptSymbolExtractor.h"
#include "extract/TypeScriptASTSymbolExtractor.h"
#include "TsServerBridge.h"
#include "catalog/TypeScriptSafePatterns.h"
#include "catalog/TypeScriptSafetyAnalyzer.h"

#include <algorithm>
#include <filesystem>
#include <iostream>
#include <set>

namespace fs = std::filesystem;

namespace topo::check {

TypeScriptAnalysisProvider::~TypeScriptAnalysisProvider() {
    shutdownLSP();
}

std::unique_ptr<SymbolExtractor> TypeScriptAnalysisProvider::createSymbolExtractor() {
    // L1 symbol extraction prefers the AST-based TypeScriptASTSymbolExtractor,
    // which drives the topo-extract-typescript Node subprocess (the real
    // `typescript` compiler AST). It emits exactly the *exported* symbols the
    // regex extractor emits, but resolves export renaming, CJS module.exports,
    // namespace prefixing, and ambient (`declare`) filtering exactly rather
    // than heuristically.
    //
    // An LSP-based extractor was ruled out: tsserver's LSP surface
    // (documentSymbol / semanticTokens / hover) does not expose ESM/CJS
    // module-export semantics, so it cannot reproduce exported-only output.
    //
    // The regex-based TypeScriptSymbolExtractor remains the fallback: when
    // topo-extract-typescript is not resolvable on PATH (Node tool not
    // staged / not installed), behaviour is exactly today's. The choice is
    // made once here, the same runtime-dependency contract C++ L2 has on
    // clangd.
    if (TypeScriptASTSymbolExtractor::isAvailable()) {
        return std::make_unique<TypeScriptASTSymbolExtractor>();
    }
    // No-silent-degradation: the regex fallback changes verdict QUALITY
    // (renamed exports / CJS module.exports / ambient filtering become
    // heuristic), so the switch must be visible by default — once per
    // process, not only under --verbose.
    static bool warnedOnce = false;
    if (!warnedOnce) {
        warnedOnce = true;
        std::cerr << "topo-check: topo-extract-typescript not found — falling back to "
                     "regex-grade TypeScript symbol extraction (export renaming / CJS "
                     "exports resolved heuristically). Stage the Node extractor for "
                     "exact results.\n";
    }
    return std::make_unique<TypeScriptSymbolExtractor>();
}

std::unique_ptr<ImportExtractor> TypeScriptAnalysisProvider::createImportExtractor() {
    return std::make_unique<TypeScriptImportExtractor>();
}

std::unique_ptr<CallSiteExtractor> TypeScriptAnalysisProvider::createCallSiteExtractor() {
    // L1 call-site detection is regex-based; L2 deep analysis is provided by
    // TsServerBridge (see runDeepContainment). The topo-extract-typescript
    // Node subprocess is used for L1 *symbol* extraction (see
    // createSymbolExtractor) and transpile, not for call-site extraction.
    return std::make_unique<TypeScriptCallSiteExtractor>();
}

std::unique_ptr<CallEdgeExtractor> TypeScriptAnalysisProvider::createCallEdgeExtractor() {
    return std::make_unique<TypeScriptCallEdgeExtractor>();
}

std::unique_ptr<SymbolAccessExtractor> TypeScriptAnalysisProvider::createSymbolAccessExtractor() {
    return std::make_unique<TypeScriptSymbolAccessExtractor>();
}

std::vector<std::string> TypeScriptAnalysisProvider::collectSourceFiles(
    const std::string& projectDir,
    const std::vector<std::string>& /*includeDirs*/) const {
    std::vector<std::string> files;
    std::vector<fs::path> searchDirs = {
        fs::path(projectDir) / "src",
        fs::path(projectDir)};
    std::set<std::string> seen;
    auto addIfSource = [&](const fs::path& p) {
        const auto ext = p.extension().string();
        if (ext == ".ts" || ext == ".tsx") {
            std::string path = p.string();
            if (seen.insert(path).second)
                files.push_back(path);
        }
    };
    for (const auto& dir : searchDirs) {
        std::error_code ec;
        // A search root that is a plain file (e.g. a regular file named
        // `src` in the project root) must not reach
        // recursive_directory_iterator: feeding it one throws ("Not a
        // directory") and aborted the whole checker.
        if (fs::is_regular_file(dir, ec)) {
            addIfSource(dir);
            continue;
        }
        if (!fs::exists(dir, ec)) continue;
        // Non-throwing iteration (error_code construction + increment, the
        // same pattern as the C++/Rust/Java providers): an unreadable or
        // vanishing entry degrades to skipping it, never aborts.
        fs::recursive_directory_iterator it(dir, ec);
        if (ec) continue;
        for (; it != fs::recursive_directory_iterator(); it.increment(ec)) {
            if (ec) break;
            const auto& entry = *it;
            // Skip node_modules entirely.
            if (entry.is_directory(ec) && entry.path().filename() == "node_modules") {
                it.disable_recursion_pending();
                continue;
            }
            if (!entry.is_regular_file(ec)) continue;
            addIfSource(entry.path());
        }
    }
    std::sort(files.begin(), files.end());
    return files;
}

bool TypeScriptAnalysisProvider::initLSP(const std::string& projectDir, bool verbose) {
    if (bridge_ && bridge_->isAvailable()) return true;

    // Start a typescript-language-server-backed bridge (mirrors PyrightBridge
    // usage). Returns false if tsserver is not installed or fails to start,
    // so the caller falls back to L1 regex analysis.
    auto bridge = std::make_unique<lsp::TsServerBridge>();
    std::string rootUri = "file://" + fs::canonical(projectDir).string();

    if (!bridge->start("", rootUri)) {
        return false;
    }
    if (!bridge->isAvailable()) {
        bridge->stop();
        return false;
    }

    bridge_ = std::move(bridge);
    if (verbose) {
        std::cerr << "  TsServerBridge started\n";
    }
    return true;
}

void TypeScriptAnalysisProvider::shutdownLSP() {
    if (bridge_) {
        bridge_->stop();
        bridge_.reset();
    }
}

bool TypeScriptAnalysisProvider::isLSPReady() const {
    return bridge_ && bridge_->isAvailable();
}

std::optional<CheckResult> TypeScriptAnalysisProvider::runDeepContainment(
    const SymbolTable& symbols,
    const std::vector<std::string>& sourceFiles,
    const ContainmentConfig& config,
    const std::string& projectDir,
    bool verbose) {
    CheckResult result;

    TypeScriptSafePatterns patterns;
    if (!patterns.loadDefault()) {
        CheckDiagnostic d;
        d.severity = Severity::Warning;
        d.check = "containment-l2";
        d.message = "TypeScriptSafePatterns.toml not found -- cannot run L2 analysis";
        result.addDiagnostic(std::move(d));
        return result;
    }

    if (!bridge_ || !bridge_->isAvailable()) {
        initLSP(projectDir, verbose);
    }
    if (!bridge_ || !bridge_->isAvailable()) {
        // typescript-language-server is not installed or failed to start,
        // so L2 deep containment cannot run -- the same runtime dependency
        // C++ L2 has on clangd. Surface the degradation explicitly so an
        // L1-only run is not mistaken for a full L2 check; CheckRunner
        // preserves this diagnostic and also prints an "L2 analysis
        // unavailable" stderr line.
        CheckDiagnostic d;
        d.severity = Severity::Warning;
        d.check = "containment-l2";
        d.message = "TypeScript L2 deep-containment is not available "
                    "(typescript-language-server is not installed or "
                    "failed to start) -- this check ran L1 (regex) only; "
                    "deep containment violations are not detected";
        result.addDiagnostic(std::move(d));
        return result;
    }

    TypeScriptSafetyAnalyzer analyzer(*bridge_, patterns);
    return analyzer.analyze(symbols, sourceFiles, config);
}

std::unique_ptr<LanguageAnalysisProvider> createTypeScriptAnalysisProvider() {
    return std::unique_ptr<LanguageAnalysisProvider>(new TypeScriptAnalysisProvider());
}

} // namespace topo::check
