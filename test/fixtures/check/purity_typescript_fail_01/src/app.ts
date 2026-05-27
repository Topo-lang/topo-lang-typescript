// `counter` is a module-level mutable binding (`let`). The parallel stage<1>
// function `compute` reassigns it — a purity violation.

let counter = 0;

export function compute(): void {
    counter = counter + 1; // write to module-level mutable — violation
}

export function render(): void {
    // pure: only local access
    const x = 5;
    const y = 10;
    const z = x + y;
}

export function run(): void {
    compute();
    render();
}
