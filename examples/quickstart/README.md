# Topo Quickstart: TypeScript

Minimal TypeScript project that demonstrates check-only Topo integration.

- `topo/processor.topo` declares a namespace with one public and one private function.
- `src/processor.ts` implements the public function as an exported TS function.
- `tsconfig.json` is a minimal strict config so `tsserver` can index the project.

Run `topo-check` against this directory to verify the declaration and the host
source agree; run `topo-build` with `language = "typescript"` to drive the
check-only backend.
