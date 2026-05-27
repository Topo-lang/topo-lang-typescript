// All declared functions are public — any cross-function call is legal.

export function stepA(): void {
}

export function stepB(): void {
    stepA();
}

export function run(): void {
    stepA();
    stepB();
}
