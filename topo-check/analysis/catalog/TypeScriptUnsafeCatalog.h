#ifndef TOPO_CHECK_TYPESCRIPTUNSAFECATALOG_H
#define TOPO_CHECK_TYPESCRIPTUNSAFECATALOG_H

#include "topo/Check/CapabilityCatalog.h"
#include <string>

namespace topo::check {

/// TypeScript / JavaScript unsafe behavior catalog.
/// Classifies patterns (dotted qualified or bare names) by unsafe level.
///   Level 1 (System): fs.*, net.*, http(s).*, process, os, fetch, WebSocket
///   Level 2 (Dep):    third-party npm modules (not a Node built-in / ES global)
///   Level 3 (Input):  alert / prompt / confirm, DOM form reads
///   Level 4 (Escape): eval, Function ctor, dynamic import, require in body,
///                     child_process.*, vm.*, Reflect.*, Proxy, Atomics
class TypeScriptUnsafeCatalog {
public:
    /// Classify a call pattern. Accepts dotted form ("fs.readFileSync") or
    /// bare name ("eval").
    static UnsafeLevel classifyCall(const std::string& pattern);

    /// Classify an import module specifier ("fs", "node:fs", "child_process").
    static UnsafeLevel classifyImport(const std::string& path);
};

} // namespace topo::check

#endif // TOPO_CHECK_TYPESCRIPTUNSAFECATALOG_H
