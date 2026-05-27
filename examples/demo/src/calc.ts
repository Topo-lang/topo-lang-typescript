// calc.ts — pure computation module.
//
// All functions operate on local state only (purity requirement for
// parallel stage<1>).

export function compute(n: number): number {
    let sum = 0;
    for (let i = 1; i <= n; i++) {
        sum += i;
    }
    return sum;
}
