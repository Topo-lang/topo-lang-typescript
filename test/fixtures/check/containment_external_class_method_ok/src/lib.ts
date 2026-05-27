// `Renderer.render` is declared `external` in .topo. The host emits its
// callerQualifiedName as `Renderer.render` (TypeScript uses `.` as the scope
// separator). Containment must recognize the class-method caller as
// external via the simple-name fallback in ContainmentCheck — this requires
// LanguageAnalysisProvider::separator() to return ".".
//
// Without the per-language separator, the fallback would split on `::`,
// fail to strip `Renderer.`, and report `eval` as a violation.
//
// The return-type annotation (`: number`) also exercises the L1 method-
// shorthand regex's tolerance for `): Type {`.

export class Renderer {
    render(id: number): number {
        eval("1 + 1");
        return id * 2;
    }
}
