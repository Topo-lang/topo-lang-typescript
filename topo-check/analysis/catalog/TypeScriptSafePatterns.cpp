#include "TypeScriptSafePatterns.h"

#define TOML_HEADER_ONLY 1
#define TOML_EXCEPTIONS 0
#include <toml++/toml.hpp>

#include <filesystem>
#include <iostream>

namespace fs = std::filesystem;

namespace topo::check {

bool TypeScriptSafePatterns::load(const std::string& tomlPath) {
    toml::parse_result result = toml::parse_file(tomlPath);
    if (!result) {
        std::cerr << "TypeScriptSafePatterns: failed to parse " << tomlPath << ": "
                  << result.error() << "\n";
        return false;
    }
    const auto& tbl = result.table();

    if (auto arr = tbl.at_path("constructs.safe").as_array()) {
        for (const auto& elem : *arr) {
            if (auto s = elem.value<std::string>()) safeConstructs_.insert(*s);
        }
    }
    if (auto arr = tbl.at_path("constructs.unsafe").as_array()) {
        for (const auto& elem : *arr) {
            if (auto s = elem.value<std::string>()) unsafeConstructs_.insert(*s);
        }
    }
    if (auto stdlibTbl = tbl["stdlib"].as_table()) {
        for (const auto& [key, val] : *stdlibTbl) {
            if (auto s = val.value<std::string>(); s && *s == "safe") {
                safeStdlib_.insert(std::string(key.str()));
            }
        }
    }

    loaded_ = true;
    return true;
}

bool TypeScriptSafePatterns::loadDefault() {
    if (const char* dir = std::getenv("TOPO_PATTERNS_DIR")) {
        fs::path p = fs::path(dir) / "TypeScriptSafePatterns.toml";
        if (fs::exists(p)) return load(p.string());
    }
    fs::path candidate = fs::path(TOPO_SOURCE_DIR) / "topo-lang-typescript" /
                         "topo-check" / "analysis" / "catalog" /
                         "TypeScriptSafePatterns.toml";
    if (fs::exists(candidate)) return load(candidate.string());
    return false;
}

bool TypeScriptSafePatterns::isConstructSafe(const std::string& keyword) const {
    return safeConstructs_.count(keyword) > 0;
}

bool TypeScriptSafePatterns::isConstructUnsafe(const std::string& keyword) const {
    return unsafeConstructs_.count(keyword) > 0;
}

bool TypeScriptSafePatterns::isStdlibSymbolSafe(const std::string& qualifiedName) const {
    if (safeStdlib_.count(qualifiedName)) return true;
    auto pos = qualifiedName.rfind('.');
    while (pos != std::string::npos && pos > 0) {
        std::string prefix = qualifiedName.substr(0, pos);
        if (safeStdlib_.count(prefix)) return true;
        pos = prefix.rfind('.');
    }
    return false;
}

} // namespace topo::check
