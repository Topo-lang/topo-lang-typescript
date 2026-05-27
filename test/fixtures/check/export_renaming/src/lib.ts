// Internal names are implementation detail; the export list renames
// them to stable public names matching the .topo declarations.

function _impl(x: number): number {
    return x * 2;
}

function _helper(y: number): number {
    return y + 1;
}

export { _impl as publicApi, _helper as otherApi };
