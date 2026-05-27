// TypeScriptSafetyAnalyzer -- L2 whitelist-based containment analysis for
// TypeScript / JavaScript.
//
// Pipeline (per source file):
//   1. didOpen the document via the shared tsserver (TsServerBridge).
//   2. Fetch semanticTokens; pick function / method reference tokens.
//   3. For each token, resolve the qualified callee name using:
//        - textDocument/hover  -- gives either a dotted form (e.g.
//          "fs.readFileSync") or a bare name ("readFileSync").
//        - textDocument/definition  -- gives the source .d.ts file path,
//          which is used to infer the owning module when hover is bare
//          (e.g. destructured `import { readFileSync } from "fs"`).
//   4. Drop the site if it is whitelisted (TypeScriptSafePatterns) or
//      declared in the project SymbolTable.
//   5. Otherwise classify via TypeScriptUnsafeCatalog and emit a
//      DetectedCallSite. Emission is driven by the same checkContainment()
//      pass used by L1 so external / non-external filtering is shared.

#include "TypeScriptSafetyAnalyzer.h"

#include "TsServerBridge.h"
#include "TypeScriptUnsafeCatalog.h"
#include "topo/Sema/SymbolTable.h"

#include <cctype>
#include <chrono>
#include <regex>
#include <set>
#include <string>
#include <thread>

namespace {

/// Strip tsserver's leading hover annotation: "(method) X" -> "X",
/// "(alias) X" -> "X", "(function) X" -> "X", etc.
void stripKindPrefix(std::string& s) {
    if (s.empty() || s.front() != '(') return;
    auto kindEnd = s.find(") ");
    // Bounded: real kinds are short ("method", "property", "parameter", ...).
    if (kindEnd != std::string::npos && kindEnd <= 24) {
        s.erase(0, kindEnd + 2);
    }
}

/// Extract the qualified callee name from a tsserver hover string.
/// Returns empty if the hover does not look like a declarator.
///
/// tsserver (typescript-language-server) returns hover as a markdown
/// MarkupContent: an optional leading blank line, a ```` ```typescript ````
/// fenced code block holding the declarator, then JSDoc prose. The fence is
/// stripped here so the declarator-parsing logic lands on the signature.
///
/// Handles common shapes (with or without the markdown fence wrapper):
///   "function readFileSync(...)"          -> "readFileSync"
///   "(method) fs.readFileSync(...)"       -> "fs.readFileSync"
///   "function eval(x: string): any"       -> "eval"
///   "var Function: FunctionConstructor"   -> "Function"
///   "(alias) function readFileSync ..."   -> "readFileSync"
///   "Array<T>.push(value: T): number"     -> "Array"  (generic stripped;
///                                                      prefix match catches)
std::string extractQualifiedName(const std::string& hover) {
    if (hover.empty()) return "";
    std::string s = hover;

    // Drop leading whitespace / blank lines (tsserver hover begins with "\n").
    size_t lead = 0;
    while (lead < s.size() &&
           (s[lead] == '\n' || s[lead] == '\r' || s[lead] == ' ' || s[lead] == '\t'))
        ++lead;
    s.erase(0, lead);

    // If a markdown code fence opens here, drop the fence-open line
    // (```` ```typescript ````) so the declarator becomes the first line.
    if (s.rfind("```", 0) == 0) {
        auto eol = s.find('\n');
        if (eol == std::string::npos) return "";
        s.erase(0, eol + 1);
        size_t inner = 0;
        while (inner < s.size() && (s[inner] == '\n' || s[inner] == '\r')) ++inner;
        s.erase(0, inner);
    }

    stripKindPrefix(s);

    // First line only — subsequent lines hold the closing fence / JSDoc / prose.
    auto nl = s.find_first_of("\r\n");
    if (nl != std::string::npos) s.resize(nl);

    // Find where the declarator body starts.
    size_t declEnd = s.size();
    for (size_t i = 0; i < s.size(); ++i) {
        char c = s[i];
        if (c == '(' || c == '<' || c == '=' || c == ';' || c == '{') {
            declEnd = i;
            break;
        }
        if (c == ':' && i + 1 < s.size() && s[i + 1] == ' ') {
            declEnd = i;
            break;
        }
    }
    while (declEnd > 0 && (s[declEnd - 1] == ' ' || s[declEnd - 1] == '\t'))
        --declEnd;

    // Scan backwards to the start of the identifier chain.
    size_t start = declEnd;
    while (start > 0) {
        char c = s[start - 1];
        if (std::isalnum(static_cast<unsigned char>(c)) ||
            c == '_' || c == '$' || c == '.') {
            --start;
        } else {
            break;
        }
    }
    if (start >= declEnd) return "";
    std::string name = s.substr(start, declEnd - start);
    if (!name.empty() && name.front() == '.') name.erase(0, 1);
    // Guard against returning a pure TypeScript keyword (the hover shape
    // "function" or "var" with no identifier after it).
    static const std::set<std::string> keywords = {
        "function", "var", "const", "let", "class", "interface", "type",
        "namespace", "module", "async", "await", "new", "return", "void",
    };
    if (keywords.count(name)) return "";
    return name;
}

/// Infer the owning Node module from a tsserver definition file path.
///
///   /.../@types/node/fs.d.ts            -> "fs"
///   /.../@types/node/fs/promises.d.ts   -> "fs.promises"
///   /.../@types/node/child_process.d.ts -> "child_process"
///
/// Returns empty for paths that do not belong to `@types/node` -- typically
/// project source, ES / DOM lib files, or third-party packages.
std::string inferNodeModule(const std::string& defnFile) {
    if (defnFile.empty()) return {};
    std::string f = defnFile;
    for (char& c : f) if (c == '\\') c = '/';

    static const std::regex nested(
        R"(/@types/node/([^/]+)/([^/]+)\.d\.ts$)");
    static const std::regex topLevel(
        R"(/@types/node/([^/]+)\.d\.ts$)");

    std::smatch m;
    if (std::regex_search(f, m, nested)) {
        return m[1].str() + "." + m[2].str();
    }
    if (std::regex_search(f, m, topLevel)) {
        return m[1].str();
    }
    return {};
}

} // anonymous namespace

namespace topo::check {

TypeScriptSafetyAnalyzer::TypeScriptSafetyAnalyzer(
    lsp::TsServerBridge& bridge, const TypeScriptSafePatterns& patterns)
    : bridge_(bridge), patterns_(patterns) {}

CheckResult TypeScriptSafetyAnalyzer::analyze(
    const SymbolTable& symbols,
    const std::vector<std::string>& sourceFiles,
    const ContainmentConfig& config) {
    CheckResult result;
    if (!config.isEnabled()) return result;
    if (!bridge_.isAvailable()) {
        CheckDiagnostic d;
        d.severity = Severity::Warning;
        d.check = "containment-l2";
        d.message = "tsserver unavailable -- falling back to L1 regex scanning";
        result.addDiagnostic(std::move(d));
        return result;
    }

    std::vector<DetectedCallSite> callSites;
    std::vector<HostImport> imports;

    int filesWithEmptyTokens = 0;
    for (const auto& file : sourceFiles) {
        if (!analyzeFile(file, symbols, config, callSites)) {
            ++filesWithEmptyTokens;
        }
    }

    // Principle 16: if tsserver produced no tokens at all, do not pretend
    // L2 ran. Surface a loud warning and let CheckRunner fall through to L1.
    if (!sourceFiles.empty() &&
        filesWithEmptyTokens == static_cast<int>(sourceFiles.size())) {
        CheckDiagnostic d;
        d.severity = Severity::Warning;
        d.check = "containment-l2";
        d.message = "tsserver returned no semantic tokens for any of " +
                    std::to_string(sourceFiles.size()) +
                    " source file(s) -- L2 cannot run, falling back to L1";
        result.addDiagnostic(std::move(d));
        return result;
    }

    // Deduplicate: same file+line+callee call sites.
    {
        std::set<std::pair<std::string, int>> seen;
        std::vector<DetectedCallSite> deduped;
        for (auto& site : callSites) {
            auto key = std::make_pair(site.file + "::" + site.calleePattern, site.line);
            if (seen.insert(key).second) {
                deduped.push_back(std::move(site));
            }
        }
        callSites = std::move(deduped);
    }

    // TypeScript qualified names use "." as the scope separator (e.g.
    // "Renderer.render"); pass it so checkContainment's simple-name fallback
    // recognizes an external class-method caller. Omitting it defaults to
    // "::" and external class methods are misreported as violations.
    checkContainment(symbols, imports, callSites, config, result, ".");

    if (filesWithEmptyTokens > 0) {
        CheckDiagnostic d;
        d.severity = Severity::Warning;
        d.check = "containment-l2";
        d.message = "tsserver returned no semantic tokens for " +
                    std::to_string(filesWithEmptyTokens) + " of " +
                    std::to_string(sourceFiles.size()) +
                    " source file(s) -- those files were not analyzed at L2";
        result.addDiagnostic(std::move(d));
    }

    // Mark as real L2 result so CheckRunner does not fall through to L1.
    {
        CheckDiagnostic d;
        d.severity = Severity::Note;
        d.check = "containment";
        d.message = "L2 deep analysis completed (" +
                    std::to_string(static_cast<int>(sourceFiles.size()) - filesWithEmptyTokens) +
                    "/" + std::to_string(sourceFiles.size()) + " file(s), " +
                    std::to_string(callSites.size()) + " call site(s))";
        result.addDiagnostic(std::move(d));
    }

    return result;
}

bool TypeScriptSafetyAnalyzer::analyzeFile(
    const std::string& filePath,
    const SymbolTable& symbols,
    const ContainmentConfig& /*config*/,
    std::vector<DetectedCallSite>& callSites) {
    bridge_.openDocument(filePath);
    struct DocGuard {
        lsp::TsServerBridge& b;
        const std::string& path;
        ~DocGuard() { b.closeDocument(path); }
    } guard{bridge_, filePath};

    // tsserver may need a moment after didOpen before semantic tokens are
    // ready; mirror the jdtls retry loop.
    auto tokens = bridge_.getSemanticTokens(filePath);
    for (int retry = 0; tokens.empty() && retry < 3; ++retry) {
        std::this_thread::sleep_for(std::chrono::milliseconds{500 * (retry + 1)});
        tokens = bridge_.getSemanticTokens(filePath);
    }
    if (tokens.empty()) return false;

    auto docSymbols = bridge_.getDocumentSymbols(filePath);

    for (const auto& token : tokens) {
        // Candidate call/construct tokens: `function`/`method` cover plain
        // calls; `class` covers `new X()` constructor escapes (tsserver
        // types `new Function(...)`'s `Function` token as `class`).
        // Non-call `class` tokens (type annotations, project classes) are
        // dropped downstream by classifyCallSite.
        if (token.type != "function" && token.type != "method" &&
            token.type != "class")
            continue;
        if (token.modifiers.find("declaration") != std::string::npos ||
            token.modifiers.find("definition") != std::string::npos) continue;

        auto hover = bridge_.getHoverAt(filePath, token.line, token.column);
        if (!hover) continue;

        std::string qualifiedName = extractQualifiedName(*hover);
        if (qualifiedName.empty()) continue;

        // If hover gave only a bare name, try to enrich with module hint
        // from the definition file. This is what catches the destructured
        // import case (`import { readFileSync } from "fs"`).
        if (qualifiedName.find('.') == std::string::npos) {
            auto defn = bridge_.getDefinitionAt(filePath, token.line, token.column);
            if (defn) {
                std::string module = inferNodeModule(defn->file);
                if (!module.empty()) {
                    qualifiedName = module + "." + qualifiedName;
                }
            }
        }

        std::string callerQN = lsp::LSPBridge::findEnclosingFunction(
            docSymbols, token.line, ".");
        if (callerQN.empty()) {
            callerQN = "<l2:" + filePath + ":" +
                       std::to_string(token.line + 1) + ">";
        }

        DetectedCallSite site;
        if (classifyCallSite(qualifiedName, callerQN, filePath,
                             token.line + 1, symbols, site)) {
            callSites.push_back(std::move(site));
        }
    }
    return true;
}

bool TypeScriptSafetyAnalyzer::classifyCallSite(
    const std::string& qualifiedName,
    const std::string& caller,
    const std::string& file,
    int line,
    const SymbolTable& symbols,
    DetectedCallSite& out) const {
    if (qualifiedName.empty()) return false;

    // 1. Whitelisted stdlib / ES global -> drop.
    if (patterns_.isStdlibSymbolSafe(qualifiedName)) return false;

    // 2. Simple-name against construct whitelist.
    std::string simpleName = qualifiedName;
    auto lastDot = qualifiedName.rfind('.');
    if (lastDot != std::string::npos) {
        simpleName = qualifiedName.substr(lastDot + 1);
    }
    if (patterns_.isConstructSafe(simpleName)) return false;

    // 3. Unsafe construct (eval, Function) -- report regardless of whether
    //    a project function happens to share the name.
    bool isUnsafeConstruct = patterns_.isConstructUnsafe(simpleName);

    // 4. Project-declared function -- drop unless it matches an unsafe
    //    construct.
    if (!isUnsafeConstruct) {
        bool isDeclared = false;
        for (const auto& [name, fn] : symbols.functions()) {
            if (fn.qualifiedName == qualifiedName ||
                fn.qualifiedName == simpleName ||
                fn.simpleName == simpleName) {
                isDeclared = true;
                break;
            }
        }
        if (isDeclared) return false;
    }

    // 5. Classify via the unsafe catalog.
    auto level = TypeScriptUnsafeCatalog::classifyCall(qualifiedName);
    if (level == UnsafeLevel::Safe && qualifiedName != simpleName) {
        // Retry with just the simple name for broader matching.
        level = TypeScriptUnsafeCatalog::classifyCall(simpleName);
    }
    if (level == UnsafeLevel::Safe && !isUnsafeConstruct) {
        // Unresolved attribute chain or user-method the catalog does not
        // recognize -- do not report as a violation (L2 is meant to raise
        // signal, not noise).
        return false;
    }

    out.calleePattern = qualifiedName;
    out.callerQualifiedName = caller.empty() ? std::string("<module>") : caller;
    out.capability = std::nullopt;
    out.unsafeLevel = (level != UnsafeLevel::Safe) ? level : UnsafeLevel::Escape;
    out.file = file;
    out.line = line;
    return true;
}

} // namespace topo::check
