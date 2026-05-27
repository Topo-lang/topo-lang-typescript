// app.ts — main orchestrator for the Topo TypeScript demo.
//
// All six check types are exercised:
//   completeness:   process() and doubleValue() match .topo declarations
//   containment:    no eval / fs / net / process calls
//   visibility:     doubleValue is private to this namespace
//   purity:         stage<1> functions use only local state
//   stage-isolation: no forward-stage calls
//   import-path:    helpers.ts exists on disk

export function process(x: number): number {
    return doubleValue(x);
}

// doubleValue is a public helper — exported for completeness check visibility.
export function doubleValue(x: number): number {
    return x * 2;
}

export function run(): void {
    const result = process(42);
    void result;
}
