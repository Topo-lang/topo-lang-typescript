export function run(seed: number): number {
    return helper(seed) + diagnostic(seed);
}

export function helper(x: number): number {
    return x * 2;
}

export function diagnostic(x: number): number {
    return x + 1;
}
