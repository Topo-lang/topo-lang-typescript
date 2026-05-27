export function add(a: number, b: number): number {
    return a + b;
}
export function mul(a: number, b: number): number {
    return a * b;
}
export function compute(n: number): number {
    return add(mul(n, n), n);
}
