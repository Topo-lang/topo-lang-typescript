// All parallel stage<1> functions are pure: only local variables and
// parameters. No module-level `let`/`var` globals are written.

function helperDouble(x: number): number {
    const result = x * 2;
    return result;
}

export function transform(): void {
    let tmp = 5;
    tmp = helperDouble(tmp);
}

export function validate(): void {
    let a = 1;
    let b = 2;
    const sum = a + b;
}

export function run(): void {
    transform();
    validate();
}
