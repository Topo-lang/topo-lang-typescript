/**
 * Read .topo back into a Graph by parsing it with the real toolchain.
 *
 * Round-trip fidelity is the topo-app design's decisive constraint. To prove it
 * honestly, read-back must go through the *actual* Topo parser, not a
 * TypeScript re-implementation of the grammar (which could agree with
 * the emitter by accident). We invoke `topo --ast-dump` and reconstruct
 * the graph from the parser's own structured dump. This simultaneously
 * proves "emitted .topo parses under the merged grammar" (the dump only
 * succeeds if the parser accepts it) and yields graph' for the
 * equivalence check.
 *
 * The dump line forms matched here are the parser's own ASTPrinter
 * output, identical to the forms the Python `_readback.py` matches:
 *   NamespaceDecl 'orders'
 *   HandlerDecl 'parse(str in) -> record<id: int, amount: float>'
 *   FlowBlock 'order_pipeline'
 *   Edge parse -> validate
 *   Edge persist -> void [terminal]
 * The `using` preamble dumps as `DataDecl` lines, which are ignored
 * (only namespace / handler / flow / edge nodes carry graph meaning).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Edge, Flow, Graph, Handler, TypeRef } from "./_graph.mjs";
import { topoBin } from "./_toolchain.mjs";

const HANDLER_RE = /^HandlerDecl '(\w+)\((.*?)\)\s*->\s*(.+)'$/;
const FLOW_RE = /^FlowBlock '(\w+)'$/;
const EDGE_RE = /^Edge (\w+) -> (\w+)(?:\s*\[terminal\])?$/;
const NS_RE = /^NamespaceDecl '(\w+)'$/;
const RECORD_RE = /^record<(.+)>$/;

function _parseType(spec) {
  const s = spec.trim();
  const m = RECORD_RE.exec(s);
  if (m) {
    // Split top-level "name: type" pairs. Record fields here are
    // scalar-typed (the slice's record nesting is one level, matching
    // the topo-app order example), so a comma split is sufficient.
    const fields = m[1].split(",").map((part) => {
      const idx = part.indexOf(":");
      const name = part.slice(0, idx).trim();
      const ftype = part.slice(idx + 1).trim();
      return [name, new TypeRef({ scalar: ftype })];
    });
    return new TypeRef({ record: fields });
  }
  return new TypeRef({ scalar: s });
}

/**
 * Parse `.topo` source text into a Graph via `topo --ast-dump`.
 * Throws if the toolchain rejects the source, which is itself the
 * grammar-conformance signal.
 *
 * @param {string} text
 * @returns {Graph}
 */
export function readTopo(text) {
  const td = mkdtempSync(join(tmpdir(), "topo-app-rt-"));
  let proc;
  try {
    const p = join(td, "roundtrip.topo");
    writeFileSync(p, text, "utf-8");
    proc = spawnSync(topoBin(), ["--ast-dump", p], { encoding: "utf-8" });
  } finally {
    rmSync(td, { recursive: true, force: true });
  }
  if (proc.status !== 0) {
    const err = new Error(
      `topo --ast-dump rejected the emitted .topo ` +
        `(exit ${proc.status})\n${proc.stdout || ""}\n${proc.stderr || ""}`
    );
    err.stdout = proc.stdout;
    err.stderr = proc.stderr;
    throw err;
  }

  let namespace = "";
  /** @type {Handler[]} */
  const handlers = [];
  /** @type {Flow|null} */
  let flow = null;
  for (const rawLine of (proc.stdout || "").split("\n")) {
    const s = rawLine.trim();
    let m = NS_RE.exec(s);
    if (m) {
      namespace = m[1];
      continue;
    }
    m = HANDLER_RE.exec(s);
    if (m) {
      const name = m[1];
      const params = m[2].trim();
      const ret = m[3];
      let inType = null;
      if (params) {
        // "Type in" — strip the conventional parameter name.
        const typeSpec = params.slice(0, params.lastIndexOf(" "));
        inType = _parseType(typeSpec);
      }
      handlers.push(new Handler(name, inType, _parseType(ret)));
      continue;
    }
    m = FLOW_RE.exec(s);
    if (m) {
      flow = new Flow(m[1]);
      continue;
    }
    m = EDGE_RE.exec(s);
    if (m && flow !== null) {
      const src = m[1];
      const tgt = m[2];
      flow.edges.push(new Edge(src, tgt === "void" ? null : tgt));
    }
  }

  return new Graph(namespace, handlers, flow);
}
