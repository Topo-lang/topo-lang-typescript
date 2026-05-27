#include "TypeScriptUnsafeCatalog.h"

#include <unordered_set>

namespace topo::check {

namespace {

bool startsWith(const std::string& s, const std::string& prefix) {
    return s.size() >= prefix.size() &&
           s.compare(0, prefix.size(), prefix) == 0;
}

} // namespace

UnsafeLevel TypeScriptUnsafeCatalog::classifyCall(const std::string& pattern) {
    // Level 4: Language / sandbox escape.
    static const std::unordered_set<std::string> escape = {
        "eval", "Function",
        "__dynamic_import__",
        "require",
        "Reflect", "Proxy",
        "Atomics",
    };
    if (escape.count(pattern)) return UnsafeLevel::Escape;

    // child_process.* -- shell execution.
    if (startsWith(pattern, "child_process.")) return UnsafeLevel::Escape;
    // vm.* -- sandboxed code execution (still an escape vector).
    if (startsWith(pattern, "vm.")) return UnsafeLevel::Escape;
    // Reflect.* / Proxy.* -- metaprogramming.
    if (startsWith(pattern, "Reflect.")) return UnsafeLevel::Escape;
    if (startsWith(pattern, "Proxy.")) return UnsafeLevel::Escape;
    // Atomics.* -- raw shared-memory coordination primitives.
    if (startsWith(pattern, "Atomics.")) return UnsafeLevel::Escape;

    // Level 3: User input (browser-side)
    static const std::unordered_set<std::string> input = {
        "alert", "prompt", "confirm",
    };
    if (input.count(pattern)) return UnsafeLevel::Input;

    // Level 1: System calls (I/O, process / OS, network).
    static const std::unordered_set<std::string> systemCalls = {
        "fetch",
        "XMLHttpRequest", "WebSocket", "EventSource",
    };
    if (systemCalls.count(pattern)) return UnsafeLevel::System;

    // Node built-in modules that perform I/O or OS interaction.
    static const std::unordered_set<std::string> systemModulePrefixes = {
        "fs", "fs.promises",
        "net", "tls", "dgram",
        "http", "https", "http2",
        "dns",
        "process", "os",
        "cluster", "worker_threads",
        "readline", "repl",
        "v8",
        "perf_hooks",
    };
    for (const auto& mod : systemModulePrefixes) {
        if (pattern == mod || startsWith(pattern, mod + ".")) {
            return UnsafeLevel::System;
        }
    }

    // DOM I/O surfaces (conservative — many globals are System-level).
    static const std::unordered_set<std::string> domSystem = {
        "document", "window", "localStorage", "sessionStorage",
        "indexedDB", "navigator", "location", "history",
    };
    if (domSystem.count(pattern)) return UnsafeLevel::System;
    for (const auto& g : domSystem) {
        if (startsWith(pattern, g + ".")) return UnsafeLevel::System;
    }

    // console.* -- treat as System (mirrors Java System.out / Python print).
    if (pattern == "console" || startsWith(pattern, "console.")) {
        return UnsafeLevel::System;
    }

    return UnsafeLevel::Safe;
}

UnsafeLevel TypeScriptUnsafeCatalog::classifyImport(const std::string& path) {
    // Normalize `node:fs` -> `fs`.
    std::string name = path;
    if (startsWith(name, "node:")) name = name.substr(5);

    // Level 4
    static const std::unordered_set<std::string> escape = {
        "child_process", "vm",
    };
    if (escape.count(name)) return UnsafeLevel::Escape;

    // Level 1
    static const std::unordered_set<std::string> system = {
        "fs", "fs/promises",
        "net", "tls", "dgram",
        "http", "https", "http2",
        "dns",
        "process", "os",
        "cluster", "worker_threads",
        "readline", "repl",
        "v8", "perf_hooks",
    };
    if (system.count(name)) return UnsafeLevel::System;

    // Safe Node built-ins (pure computation).
    static const std::unordered_set<std::string> safe = {
        "path", "util", "events", "buffer", "querystring",
        "url", "string_decoder", "assert", "timers", "timers/promises",
    };
    if (safe.count(name)) return UnsafeLevel::Safe;

    // Relative / absolute paths are project code — defer to visibility check.
    if (!name.empty() && (name[0] == '.' || name[0] == '/')) {
        return UnsafeLevel::Safe;
    }

    // Anything else: third-party dependency.
    return UnsafeLevel::Dep;
}

} // namespace topo::check
