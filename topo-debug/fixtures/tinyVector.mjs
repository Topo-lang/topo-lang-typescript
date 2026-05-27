function main() {
    const vec = new Float64Array([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]);
    const sentinel = 0;   // breakpoint here (line 3)
    console.error("done", sentinel, vec.length);
}
main();
