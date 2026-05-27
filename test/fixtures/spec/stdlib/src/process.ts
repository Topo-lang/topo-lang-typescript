// Matching TypeScript host source for minimal.topo.
//
// Each function signature corresponds 1:1 to the .topo declaration via the
// V8Codegen stdlib mapping. This file is reference material for the spec
// fixture; topo-check L1 will treat these as the host implementations when
// the surrounding harness runs.

export function isReady(): boolean {
    return true;
}

export function nextId(): bigint {
    return 1n;
}

export function score(id: bigint): number {
    return Number(id) * 0.5;
}

export function label(id: bigint): string {
    return `item-${id}`;
}

export function parentOf(id: bigint): bigint | null {
    return id > 0n ? id - 1n : null;
}

export function samples(): readonly number[] {
    return [0.1, 0.2, 0.3];
}

export function process(
    id: bigint,
    name: string,
    flag: boolean | null,
    values: readonly number[],
): boolean {
    return flag === true && values.length > 0 && name.length > 0 && id >= 0n;
}
