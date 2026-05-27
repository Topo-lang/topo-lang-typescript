// Project-multi TypeScript fixture — declarations matching main.topo's
// `TwoArrays::{a,b}`. Consumed by `topo-build-typescript`'s completeness
// check; the runtime side lives in main.mjs. See project_simple/src/main.ts
// for the rationale behind splitting declarations (.ts) from the runtime
// script (.mjs).

export class TwoArrays {
    public a: number[] = [];
    public b: number[] = [];
}
