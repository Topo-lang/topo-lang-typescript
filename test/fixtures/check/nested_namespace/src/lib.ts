// Nested `export namespace` — host qualified name is `Outer.Inner.compute`;
// .topo's `Outer::Inner::compute` matches via the simple-name fallback.

export namespace Outer {
    export namespace Inner {
        export function compute(x: number): number {
            return x * 3;
        }
    }
}
