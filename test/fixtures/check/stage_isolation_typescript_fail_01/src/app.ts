// `init` (stage<1>) calls `process` (stage<2>) — this is a forward stage
// violation because .topo declares init must complete before process starts.

export function process(): void {
    // stage 2 work
}

export function init(): void {
    process(); // forward call: stage<1> → stage<2> — violation
}

export function run(): void {
    init();
    process();
}
