// Project-simple TypeScript fixture — declarations matching main.topo's
// `Buf::data`. This file is consumed by `topo-build-typescript`'s
// completeness check (counterpart for the TypeScript backend); it is NOT
// what the adapter actually executes. The runtime side
// lives in main.mjs alongside this file — V8 needs a `.mjs`/`.js` URL for
// CDP `setBreakpointByUrl` to resolve cleanly (Node 26's type-stripping
// runs `.ts` files, but the resulting Debugger URL doesn't match what we
// asked for, so the breakpoint stays pending forever).
//
// Declaration shape mirrors quickstart/processor.ts: a single `Buf` type
// with a public `data` field. `[completeness] ignore_constructors = true`
// + `ignore_main = true` in Topo.toml elide the warning that no host code
// constructs `Buf` — the .topo type is purely a debug-side declaration.

export class Buf {
    public data: number[] = [];
}
