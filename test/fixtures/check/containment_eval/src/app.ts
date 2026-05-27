// `transform` is not declared external, yet it uses `eval` — violation.

export function transform(x: number): number {
    const result = eval("x * 2");
    return result;
}
