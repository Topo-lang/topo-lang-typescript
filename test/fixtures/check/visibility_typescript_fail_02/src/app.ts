// `helper` is declared private in namespace `app`.
// Same-namespace calls from `compute` and `run` are allowed.

export function helper(): void {
}

export function compute(): void {
    helper();
}

export function run(): void {
    compute();
}
