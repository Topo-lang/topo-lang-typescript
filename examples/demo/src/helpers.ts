// helpers.ts — referenced by std::import in .topo.
// Must exist on disk for the import-path check to pass.

// HelperConfig is referenced by std::import in .topo. The file must exist
// on disk for import-path check to pass. It does not need export here.
interface HelperConfig {
    enabled: boolean;
    multiplier: number;
}
