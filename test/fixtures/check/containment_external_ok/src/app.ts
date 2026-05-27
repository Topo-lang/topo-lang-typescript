// `runCommand` is declared `external` — may call dangerous APIs.
// `process` is not external; it stays pure.

export function runCommand(code: number): number {
    eval("1 + 1");
    return 0;
}

export function process(x: number): number {
    return x * 2;
}
