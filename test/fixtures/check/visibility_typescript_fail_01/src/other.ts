// `other.invoke` reaches into `app.helper`, which is declared private in
// namespace `app`.  Cross-namespace private calls are forbidden.
//
// This fixture exercises the dominant TypeScript pattern — destructured
// ES imports. The CallEdge extractor's destructured-import resolver
// rewrites the bare `helper()` call back to `app::helper` so
// VisibilityCheck can match it against the .topo `app::helper` private
// declaration. (Previously this fixture used `import * as app` as a
// workaround because the destructured-import form was not yet resolved
// back to its declaring namespace.)

import { helper } from "./app";

export function invoke(): void {
    helper();
}
