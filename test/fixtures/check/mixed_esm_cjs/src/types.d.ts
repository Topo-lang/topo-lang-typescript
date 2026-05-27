// Ambient declarations — virtual type stubs for legacy JS APIs the
// project consumes elsewhere. These must NOT be reported by the
// completeness check as orphan implementations, because `.d.ts` files
// carry no runtime code.

declare function legacyFunction(id: number): string;

declare class LegacyShape {
    width: number;
    height: number;
}

declare const DEFAULT_ID: number;
