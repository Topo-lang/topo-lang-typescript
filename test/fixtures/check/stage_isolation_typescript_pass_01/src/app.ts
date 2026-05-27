// `init` and `process` never call each other — the host call graph
// respects the stage ordering declared in .topo.

export function init(): void {
    let local = 0;
    local = local + 1;
}

export function process(): void {
    const tmp = 42;
}

export function run(): void {
    init();
    process();
}
