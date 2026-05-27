// `other.invoke` reaches into `app.helper` via an aliased destructured
// import (`as h`). The CallEdge extractor must resolve the alias back to
// the original export `helper` and the source module `app`, emitting an
// `app::helper` edge. VisibilityCheck then matches it against the .topo
// `app::helper` private declaration and reports the cross-namespace
// violation.

import { helper as h } from "./app";

export function invoke(): void {
    h();
}
