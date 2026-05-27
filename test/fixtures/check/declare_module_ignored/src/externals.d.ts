// `declare module "<name>" { ... }` declares an ambient module — a type
// stub for an external runtime dependency. The symbols inside exist at
// the type level only, not as host implementations, so they must not
// produce HostSymbols that the completeness check would treat as orphans.

declare module "legacy-adapter" {
    export function legacyAdapt(id: number): string;
    export class LegacyHandle {
        id: number;
    }
}

declare module "vendor-sdk" {
    export function vendorConnect(url: string): boolean;
}
