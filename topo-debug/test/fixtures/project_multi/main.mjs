// Project-multi TypeScript fixture — runtime script driven by the CDP
// adapter. Counterpart of project_multi's main.cpp / main.rs / main.py:
// two Int32Arrays in the same frame so a single `--var a,b` spawn returns
// both back-to-back as wire records.
//
// See project_simple/main.mjs for `.mjs`-vs-`.ts` and Int32Array-vs-Array
// rationale. Expected at the breakpoint (`let sentinel = 0` on line 16):
//   sum(a)              = 10   (1+2+3+4)
//   sum(b)              = 100  (10+20+30+40)
//   sum(a) + sum(b)     = 110
//   max(b) - max(a)     = 36   (40 - 4)

function main() {
    const a = new Int32Array([1, 2, 3, 4]);
    const b = new Int32Array([10, 20, 30, 40]);
    let sentinel = 0;  // breakpoint here (line 16)
    let total = sentinel;
    for (let i = 0; i < a.length; ++i) total += a[i] + b[i];
    console.error("done", total);
    return [a, b];
}
main();
