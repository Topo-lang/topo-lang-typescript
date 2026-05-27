// Project-simple TypeScript fixture — runtime script that the adapter
// drives via `node --inspect-brk=0`. Counterpart of project_simple's
// main.cpp / main.rs / main.py: a single `data` array of length 8 with
// values that split cleanly into two halves so first_half / second_half
// view sums are visibly distinct.
//
// Why `.mjs` and not `.ts`: the CDP adapter sets breakpoints via
// `Debugger.setBreakpointByUrl` with a `file://...mjs` URL. Node 26 can
// strip types from `.ts` and run them, but V8's parsed-script URL no longer
// matches the URL we asked for, so the breakpoint never resolves and the
// adapter times out at 30s. Keeping the runtime as `.mjs` mirrors the
// established `fixtures/tinyVector.mjs` contract and the breakpoint hits
// reliably. The `.ts` declarations live at `src/main.ts` for
// topo-build-typescript's completeness check.
//
// Why `Int32Array` and not `number[]`: the adapter is a TypedArray-only
// extractor (adapter.mjs `ctorToDtype`). A plain JS `Array<number>` returns
// `EXIT_UNSUPPORTED_TYPE`. `Int32Array` maps to `dtype=i32`; sums computed
// by topo-debug's wire-reader against the Int32 bytes match the values
// produced as if these were Python `list[int]` / Java `int[]` / Rust `i32[]`.
//
// Expected at the breakpoint (`let sentinel = 0` on line 31):
//   sum(data)        = 110   (1+2+3+4 + 10+20+30+40)
//   sum(first_half)  = 10    (data[0..4])
//   sum(second_half) = 100   (data[4..8])
//   shape(first_half)= [4]
//   dtype(data)      = i32

function main() {
    const data = new Int32Array([1, 2, 3, 4, 10, 20, 30, 40]);
    let sentinel = 0;  // breakpoint here (line 31)
    let total = sentinel;
    for (let i = 0; i < data.length; ++i) total += data[i];
    console.error("done", total, data.length);
    return data;
}
main();
