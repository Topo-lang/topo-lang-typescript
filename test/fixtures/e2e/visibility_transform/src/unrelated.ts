// A second TS file with no symbol that matches a .topo visibility entry.
// The transform must leave this file completely alone — neither `format`
// nor `noop` is declared in main.topo, so dist/src/unrelated.ts should
// not be written.

export function format(x: number): string {
    return `${x}`;
}

export function noop(): void {
    // intentionally empty
}
