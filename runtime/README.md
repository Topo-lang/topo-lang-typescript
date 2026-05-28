# topo-lang-typescript runtime

The TypeScript-host runtime for topo-app. Pure-language work (no LLVM,
no project CMake build), at behaviour parity with the Python reference
runtime. Two slices:

1. the **product runtime configuration** system, against the Python
   reference's product-config contract (envvar/file resolution, typed
   schema, validation);
2. the **handler / flow framework** — register idiomatic TypeScript
   handlers and flows, emit a round-trippable `.topo` contract, and run
   the existing `topo` / `topo-check` against it with zero hand-written
   `.topo`. Parity target: the Python `test_vertical_slice.py` T1–T5.

> The rest of TypeScript support remains check-only. A broader runtime
> npm package is still a later milestone.

## Module layout

```
topo/index.mjs           public surface barrel (== Python __init__.py)

handler / flow framework
  topo/_graph.mjs         in-memory logic graph + semantic equality
  topo/_reflect.mjs       In/Out schema descriptors (Record / Field)
  topo/app.mjs            App registration surface + parallel()
  topo/_emit.mjs          Graph -> .topo (deterministic, hand-editable)
  topo/_readback.mjs      .topo -> Graph via real `topo --ast-dump`
  topo/_toolchain.mjs     locates the fresh build/ binaries
  topo/app_config.mjs     config(app): snapshot / emitTopo / roundtrip
  topo/check.mjs          zero-declaration topo-check orchestration

product runtime configuration
  topo/_config_model.mjs  本体 — language-agnostic model
  topo/config.mjs         bridge — TOML I/O + ProductConfig projection

test/*.test.mjs           parity suites (node:test)
```

### TypeScript In/Out: explicit schema, not reflection

The Python host reflects `__annotations__` so In/Out are never
re-declared in `.topo`. TypeScript erases parameter/return types at
runtime — there is nothing to reflect — so the same philosophy is kept
by carrying In/Out as an explicit value-level schema descriptor at the
registration site (`{ in, out }` with `Record(Field("id", "int"), …)`).
This is the identical representational decision the product-config port
made (TS erases types -> explicit schema descriptors) and reuses its
stdlib type vocabulary verbatim (`int`/`float`/`bool`/`str`, bound to
`std::typescript::{number,number,boolean,string}` per `topo-init`). A
registered handler is returned unchanged and stays an ordinary,
independently callable function.

Run the framework parity suite (explicit file — `node --test <dir>`
directory-discovery misfires on Node v26, tracked issue
`typescript-config-node-test-directory-discovery`; use the pinned
script):

```
# from topo-lang-typescript/runtime/
npm run test:slice
# == node --test test/test_vertical_slice.test.mjs
```

### 本体 / bridge split

The split mirrors the Python `_config_model.py` / `config.py`
separation exactly:

- `topo/_config_model.mjs` (**本体**) owns *semantics, not wiring*:
  layered `b ◁ a ◁ c` merge, per-value provenance, the stdlib-type
  contract, the build-toolchain boundary guard, the impact write gate,
  read tiering, tags, the unified tier-aware browse, and the
  pure-internal (`d`) dev-phase registry. It has no TOML parser, no file
  I/O, and no Node-specific logic — it would read identically in any
  host.
- `topo/config.mjs` (**bridge**) is the V8/Node ecosystem layer: the
  minimal deterministic TOML reader/writer, file I/O, the
  inline-TOML round-trip surface, and the `ProductConfig` projection
  that wraps a language-agnostic `ConfigStore`.

## TOML decision

Node has no built-in TOML parser, and the established npm options are
third-party packages. The Python bridge deliberately avoids a hard TOML
runtime dependency (stdlib `tomllib` to read, a hand-written minimal
deterministic writer instead of `tomli-w`). There is no Node stdlib
`tomllib` equivalent, so to keep the same *no hard third-party
dependency* stance this bridge ships a **minimal deterministic TOML
reader and writer** covering exactly the flat scalar / array /
inline-table config vocabulary the model accepts (the same surface the
Python writer covers). It is intentionally not a full TOML 1.0
implementation. Keeping the reader and writer a matched pair makes
encode∘decode the identity for that vocabulary — which is precisely the
round-trip constraint. A TOML datetime is decoded to a JS `Date` so the
model's stdlib-contract guard rejects it (naming the roadmap-08 gap),
parity with the Python flow where `tomllib` yields a datetime the model
then rejects.

Number parity: TOML separates integers from floats; the model's stdlib
contract preserves that as `"int"` vs `"float"`. JavaScript has a single
`number`, so the model classifies a finite number as the integer
contract iff `Number.isInteger(n)`, otherwise float — and the
reader/writer keep the same distinction (integer-valued numbers emitted
without a decimal point), so a write→read cycle preserves the contract.

## Test-runner decision

No `tsx`, `ts-node`, or `tsc` is available and there is no npm infra in
this environment. The lightest viable path with zero heavy npm
dependency is **Node's built-in `node:test`** runner over plain ESM
`.mjs` modules (no compile step, no runner package). The suite mirrors
the five Python `test_config_*.py` files one-for-one.

> **Node v26 caveat — do not use `node --test test/`.** The
> directory-discovery form (`node --test test/`) misfires on Node
> v26.0.0: it reports `tests 1 / fail 1` (`test failed`) even though
> every file is green when passed explicitly, and each file passes
> individually. This is a Node test-runner directory-pattern bug, not a
> parity defect (tracked issue
> `typescript-config-node-test-directory-discovery`). Always run with
> the **explicit file list**, which is pinned in `package.json`:

```
# from topo-lang-typescript/runtime/ — the pinned, verified-green path:
npm test          # -> tests 66, pass 66, fail 0, skipped 0

# equivalent explicit invocation (what `npm test` runs):
node --test test/test_config_model.test.mjs test/test_config_rw.test.mjs \
  test/test_config_tags_perm.test.mjs test/test_config_inline_internal.test.mjs \
  test/test_config_browse.test.mjs
```

The handler/flow vertical-slice parity suite is `npm run test:slice`
(also an explicit file, for the same Node v26 reason). All tests pass;
none are skipped.
