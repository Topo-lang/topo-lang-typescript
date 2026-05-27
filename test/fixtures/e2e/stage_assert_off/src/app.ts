// `pipeline` orchestrates four stage operations. The .topo declaration
// pins each callee to a specific stage<N>; StageAssertPass injects a
// monotonic stage counter into this body plus a guarded wrapper around
// every direct call to fetch / parse / transform / emit. Calling them in
// declared order is a no-op at runtime; calling them out of order throws
// a "Topo stage assertion" Error.
export function pipeline(): void {
    fetch();
    parse();
    transform();
    emit();
}

export function fetch(): void {
    // stage<1> operation
}

export function parse(): void {
    // stage<1> operation
}

export function transform(): void {
    // stage<2> operation
}

export function emit(): void {
    // stage<3> operation
}
