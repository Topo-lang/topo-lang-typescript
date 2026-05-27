#ifndef TOPO_CHECK_TYPESCRIPTSAFEPATTERNS_H
#define TOPO_CHECK_TYPESCRIPTSAFEPATTERNS_H

#include <string>
#include <unordered_set>

namespace topo::check {

/// Loads and queries the TypeScript / JavaScript safety whitelist
/// (TypeScriptSafePatterns.toml). Consumed by L2 LSP analysis to decide if
/// a resolved symbol is safe.
///
/// Qualified names use "." separator, matching the TypeScript symbol
/// extractor convention (e.g., "Array.push", "fs.readFileSync").
class TypeScriptSafePatterns {
public:
    /// Load patterns from a TOML file. Returns false on parse error.
    bool load(const std::string& tomlPath);

    /// Load from the default location: $TOPO_PATTERNS_DIR, then the source tree.
    bool loadDefault();

    /// Is this a known unsafe construct keyword (e.g., "eval", "Function")?
    bool isConstructUnsafe(const std::string& keyword) const;

    /// Is this a known safe construct keyword (e.g., "if", "for", "class")?
    bool isConstructSafe(const std::string& keyword) const;

    /// Is this fully qualified symbol name safe?
    /// Prefix matching: "Array.push" is safe if "Array" is whitelisted.
    bool isStdlibSymbolSafe(const std::string& qualifiedName) const;

    const std::unordered_set<std::string>& safeConstructs() const { return safeConstructs_; }
    const std::unordered_set<std::string>& unsafeConstructs() const { return unsafeConstructs_; }
    const std::unordered_set<std::string>& safeStdlib() const { return safeStdlib_; }

private:
    std::unordered_set<std::string> safeConstructs_;
    std::unordered_set<std::string> unsafeConstructs_;
    std::unordered_set<std::string> safeStdlib_;
    bool loaded_ = false;
};

} // namespace topo::check

#endif // TOPO_CHECK_TYPESCRIPTSAFEPATTERNS_H
