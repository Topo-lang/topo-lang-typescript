// TypeScriptASTSymbolExtractor — L1 host-symbol extraction via the real
// `typescript` compiler AST, by driving the `topo-extract-typescript` Node
// subprocess in "symbols" mode.
//
// Subprocess protocol (mirrors TranspileDriver::extractFunctions's spawn /
// pipe / stdin-close-then-read pattern):
//   stdin  → {"mode":"symbols","files":["<path>"]}
//   stdout → {"symbols":[{qualifiedName, simpleName, kind, file, line,
//             enclosingClass, isStatic, visibility}, ...]}
//
// The tool is spawned by the bare name `topo-extract-typescript` (+ the
// platform exe suffix) so PATH resolution finds the staged launcher — the
// same contract the transpile path uses. No subprocess is the regex
// extractor's path; this class exists precisely to replace that heuristic
// with an exact AST walk while emitting the identical exported-only symbol
// set the check fixtures expect.

#include "TypeScriptASTSymbolExtractor.h"

#include "topo/Platform/Platform.h"
#include "topo/Platform/Process.h"

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

namespace topo::check {

namespace {

/// Bare tool name + platform exe suffix. PATH resolution (execvp /
/// CreateProcess) finds the staged launcher, exactly as the transpile
/// extractor path does.
std::string toolName() {
    return std::string("topo-extract-typescript") +
           std::string(platform::ExeSuffix);
}

/// Spawn the tool, write `request`, close stdin, drain stdout to EOF.
/// Returns the captured stdout, or std::nullopt if the tool could not be
/// spawned or produced no output.
std::optional<std::string> runTool(const std::string& request) {
    platform::PipedProcess proc;
    if (!proc.start(toolName(), {})) {
        return std::nullopt;
    }
    if (!proc.write(request.data(), request.size())) {
        proc.stop();
        return std::nullopt;
    }
    // Close the parent's write end so the child's read-to-EOF loop can
    // unblock and begin producing output (same deadlock-avoidance the
    // transpile path documents).
    proc.closeStdin();

    std::string response;
    char buf[4096];
    while (true) {
        size_t n = proc.read(buf, sizeof(buf));
        if (n == 0) break;
        response.append(buf, n);
    }
    proc.stop();

    if (response.empty()) {
        return std::nullopt;
    }
    return response;
}

/// Map a kind string from the JSON response to HostSymbolKind. Unknown
/// kinds fall back to Function (the safest "visible to completeness" kind,
/// matching the regex extractor's scaffold-fallback convention).
HostSymbolKind kindFromString(const std::string& kind) {
    if (kind == "class") return HostSymbolKind::Class;
    if (kind == "method") return HostSymbolKind::Method;
    if (kind == "constructor") return HostSymbolKind::Constructor;
    if (kind == "interface") return HostSymbolKind::Interface;
    if (kind == "typealias") return HostSymbolKind::TypeAlias;
    if (kind == "variable") return HostSymbolKind::Variable;
    return HostSymbolKind::Function;
}

/// Map a visibility string from the JSON response to the Visibility enum.
std::optional<Visibility> visibilityFromString(const std::string& vis) {
    if (vis == "private") return Visibility::Private;
    if (vis == "protected") return Visibility::Protected;
    if (vis == "public") return Visibility::Public;
    return std::nullopt;
}

} // namespace

std::vector<HostSymbol> TypeScriptASTSymbolExtractor::extractSymbols(
    const std::string& filePath) {
    std::vector<HostSymbol> result;

    nlohmann::json request;
    request["mode"] = "symbols";
    request["files"] = nlohmann::json::array({filePath});

    auto response = runTool(request.dump());
    if (!response) {
        // Tool unavailable or silent — return empty. The provider chose
        // this extractor only when isAvailable() was true, so an empty
        // result here means a genuine runtime failure; the caller (the
        // check) treats an empty symbol set as "no host symbols".
        return result;
    }

    nlohmann::json json;
    try {
        json = nlohmann::json::parse(*response);
    } catch (const nlohmann::json::exception&) {
        return result;
    }

    auto it = json.find("symbols");
    if (it == json.end() || !it->is_array()) {
        return result;
    }

    for (const auto& entry : *it) {
        if (!entry.is_object()) continue;
        HostSymbol sym;
        sym.qualifiedName = entry.value("qualifiedName", std::string());
        sym.simpleName = entry.value("simpleName", std::string());
        sym.kind = kindFromString(entry.value("kind", std::string("function")));
        sym.file = entry.value("file", filePath);
        sym.line = entry.value("line", 0);
        sym.isStatic = entry.value("isStatic", false);
        sym.enclosingClass = entry.value("enclosingClass", std::string());
        // returnType / paramTypes are left empty — the regex extractor does
        // not populate them either, and L1 completeness keys on names.
        if (auto v = entry.find("visibility");
            v != entry.end() && v->is_string()) {
            sym.hostVisibility = visibilityFromString(v->get<std::string>());
        }
        result.push_back(std::move(sym));
    }

    return result;
}

bool TypeScriptASTSymbolExtractor::isAvailable() {
    // topo-extract-typescript is stdin-driven and has no `--version` flag,
    // so probe by actually starting it with an empty symbols request and
    // confirming it returns a well-formed `{"symbols":[]}` reply.
    auto response = runTool(R"({"mode":"symbols","files":[]})");
    if (!response) {
        return false;
    }
    try {
        auto json = nlohmann::json::parse(*response);
        auto it = json.find("symbols");
        return it != json.end() && it->is_array() && it->empty();
    } catch (const nlohmann::json::exception&) {
        return false;
    }
}

} // namespace topo::check
