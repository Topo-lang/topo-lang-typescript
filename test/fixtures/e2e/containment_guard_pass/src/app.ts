// `runCommand` is declared `external` in main.topo. The guard pass MUST
// leave its body byte-identical — external functions are the contract
// boundary through which restricted APIs are *permitted* to flow.
export function runCommand(code: number): number {
    return eval(`${code}`) as number;
}

// `guarded` is non-external. Each direct use of a restricted API in this
// body is rewritten by the guard transform into a throw-IIFE that fires
// with a "Topo containment violation" Error if the line ever executes.
export function guarded(x: number): number {
    const a = eval(`${x}`);
    const b = new Function("return 1")();
    const c = Reflect.ownKeys({});
    const d = import("./does-not-exist");
    return x + 1;
}
