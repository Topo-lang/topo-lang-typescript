#ifndef TOPO_CHECK_TYPESCRIPTSAFETYANALYZER_H
#define TOPO_CHECK_TYPESCRIPTSAFETYANALYZER_H

#include "TypeScriptSafePatterns.h"
#include "topo/Check/ContainmentCheck.h"

#include <string>
#include <vector>

namespace topo::lsp { class TsServerBridge; }
namespace topo { class SymbolTable; }

namespace topo::check {

/// L2 whitelist-based containment analyzer for TypeScript / JavaScript.
/// Uses tsserver semantic tokens + hover + definition to resolve each call
/// target, then checks the resolved name against TypeScriptSafePatterns.
/// Unresolved-safe calls are dropped; resolved-unsafe calls are reported.
class TypeScriptSafetyAnalyzer {
public:
    TypeScriptSafetyAnalyzer(lsp::TsServerBridge& bridge,
                             const TypeScriptSafePatterns& patterns);

    /// Analyze source files. If tsserver is unavailable or returns no
    /// semantic tokens for every file, emits a warning and returns an
    /// empty CheckResult so CheckRunner falls through to L1.
    CheckResult analyze(const SymbolTable& symbols,
                        const std::vector<std::string>& sourceFiles,
                        const ContainmentConfig& config);

private:
    /// Analyze one file. Returns true iff tsserver produced usable tokens.
    bool analyzeFile(const std::string& filePath,
                     const SymbolTable& symbols,
                     const ContainmentConfig& config,
                     std::vector<DetectedCallSite>& callSites);

    /// Classify a resolved call site into a DetectedCallSite. Returns false
    /// if the call is safe (whitelisted / project-declared / unclassifiable).
    bool classifyCallSite(const std::string& qualifiedName,
                          const std::string& caller,
                          const std::string& file,
                          int line,
                          const SymbolTable& symbols,
                          DetectedCallSite& out) const;

    lsp::TsServerBridge& bridge_;
    const TypeScriptSafePatterns& patterns_;
};

} // namespace topo::check

#endif // TOPO_CHECK_TYPESCRIPTSAFETYANALYZER_H
