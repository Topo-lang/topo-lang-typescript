// Quickstart TypeScript implementation matching topo/processor.topo.
//
// `run` is declared public in the .topo file and is exported here.
// `verify` is declared private; it is a local helper and is not exported.

function verify(orderId: number): boolean {
    return orderId > 0;
}

export function run(orderId: number): boolean {
    return verify(orderId);
}
