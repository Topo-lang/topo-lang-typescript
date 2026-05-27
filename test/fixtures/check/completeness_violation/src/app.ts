// .topo declares `foo` but the source exports `bar` — undeclared symbol.

export function bar(x: number): number {
    return x + 1;
}
