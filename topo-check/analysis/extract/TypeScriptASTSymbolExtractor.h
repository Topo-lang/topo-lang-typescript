#ifndef TOPO_CHECK_TYPESCRIPTASTSYMBOLEXTRACTOR_H
#define TOPO_CHECK_TYPESCRIPTASTSYMBOLEXTRACTOR_H

#include "topo/Check/SymbolExtractor.h"

#include <string>
#include <vector>

namespace topo::check {

/// AST-based L1 TypeScript symbol extractor.
///
/// Drives the `topo-extract-typescript` Node subprocess (the real
/// `typescript` compiler AST) in "symbols" mode instead of doing a
/// regex pass. It emits exactly the *exported* declarations the regex
/// TypeScriptSymbolExtractor emits — the check fixtures are authored
/// against exported-only output — but resolves them via the real AST,
/// which makes export renaming, CJS `module.exports`, namespace
/// prefixing, and ambient (`declare`) filtering exact rather than
/// heuristic.
///
/// The provider chooses this extractor when `topo-extract-typescript`
/// resolves on PATH; otherwise it falls back to the regex extractor, so
/// behaviour is identical to today's when the tool is unavailable.
class TypeScriptASTSymbolExtractor : public SymbolExtractor {
public:
    /// Extract exported host symbols from a single TypeScript source file.
    /// Spawns `topo-extract-typescript`, sends a `{"mode":"symbols",...}`
    /// request, and parses the JSON response. Returns an empty vector when
    /// the tool cannot be spawned or returns invalid JSON (the provider
    /// guarantees the regex fallback was chosen instead in that case).
    std::vector<HostSymbol> extractSymbols(const std::string& filePath) override;

    /// Probe whether `topo-extract-typescript` resolves and starts. The
    /// tool is stdin-driven and has no `--version` flag, so this spawns it
    /// with an empty `{"mode":"symbols","files":[]}` request and expects a
    /// `{"symbols":[]}` reply. Used by the provider to pick the extractor
    /// and by tests to gate cleanly.
    static bool isAvailable();
};

} // namespace topo::check

#endif // TOPO_CHECK_TYPESCRIPTASTSYMBOLEXTRACTOR_H
