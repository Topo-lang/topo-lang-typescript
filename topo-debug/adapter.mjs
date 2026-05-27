// topo-debug-typescript — Extract adapter for Node.js/V8.
//
// Drives a Node-runnable .mjs/.js script under `node --inspect-brk=0` through
// Chrome DevTools Protocol (CDP) over WebSocket, hits a single line
// breakpoint, materialises a Float64Array (or similar TypedArray) variable's
// raw little-endian bytes via `Runtime.callFunctionOn`, and emits the bytes +
// layout descriptor on stdout using the Topo debug wire protocol. CLI shape
// mirrors `topo-lang-cpp/topo-debug/adapter.cpp` so the same `topo-debug`
// CLI drives both backends without per-language branching.
//
// CLI:
//   topo-debug-typescript --site <file:line> --target <script.mjs>
//                         [--var <name>] [-- <target-args>...]
//
// Wire output (in order, all on stdout):
//   1. JSON line  {"kind":"breakpoint_hit","frame":1,"site":"..."}
//   2. binary frame  type=var_bytes        — raw LE bytes of the var
//   3. binary frame  type=layout_descriptor — JSON {variable,dtype,shape,strides}
//
// Then reads one JSON line `{"op":"continue"}` from stdin and resumes the
// inferior to clean exit. A 30 s wall clock guards the breakpoint wait
// (Node cold-start + CDP handshake is slower than lldb).
//
// Exit codes (match the cpp adapter):
//   0  ok
//   1  CLI / usage / IO error
//   2  target not found / launch failed
//   3  breakpoint never hit / runtime error
//   4  variable type unsupported

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, isAbsolute as pathIsAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROG = 'topo-debug-typescript';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_LAUNCH = 2;
const EXIT_RUNTIME = 3;
const EXIT_UNSUPPORTED_TYPE = 4;

const BREAKPOINT_WAIT_MS = 30000;

// A V8 Inspector accepts exactly ONE CDP client at a time. The common
// real-world collision: the user runs `topo debug` from a VS Code
// integrated terminal with "Auto Attach" on, so VS Code JS Debug's
// bootloader hijacks the inspector socket of the Node child we spawn
// (it injects itself via NODE_OPTIONS / VSCODE_INSPECTOR_OPTIONS).
// VS Code then holds the single client slot and our WebSocket connect
// or `Debugger.enable` fails, or the "Debugger listening" banner is
// consumed before we read it. We do two things: (1) strip the
// auto-attach hooks from the *child* env so the hijack cannot happen
// in the first place; (2) if a connect/enable failure still occurs,
// surface this actionable guidance instead of a bare socket error.
const CDP_CONFLICT_HELP =
    `another debugger is already attached to this Node Inspector ` +
    `(a V8 Inspector allows only one CDP client). This is usually ` +
    `VS Code "Auto Attach" or an open Chrome DevTools / "chrome://inspect" ` +
    `session.\n  Fix: close the other debug session, or set VS Code ` +
    `"Debug > JavaScript: Auto Attach" to "disabled" (or run topo-debug ` +
    `from a plain terminal outside the IDE), then retry.\n  ` +
    `(A future CDP multiplex mode will lift the single-client limit.)`;

// VS Code JS Debug auto-attach plants these in the environment; passing
// them to our spawned Node makes the bootloader steal our inspector.
const JS_DEBUG_AUTOATTACH_ENV = [
    'VSCODE_INSPECTOR_OPTIONS',
    'JS_DEBUG_USE_DEFAULT_NODE_OPTIONS',
];

// Return a child env with VS Code JS Debug auto-attach hooks removed,
// and NODE_OPTIONS scrubbed of any `--require .../js-debug/...bootloader`
// injection. Returns {env, sanitized} so the caller can note it.
function childEnvWithoutAutoAttach() {
    const env = { ...process.env };
    let sanitized = false;
    for (const k of JS_DEBUG_AUTOATTACH_ENV) {
        if (env[k] !== undefined) { delete env[k]; sanitized = true; }
    }
    if (typeof env.NODE_OPTIONS === 'string' && /js-debug|bootloader/i.test(env.NODE_OPTIONS)) {
        const kept = env.NODE_OPTIONS
            .split(/\s+/)
            .filter((tok) => tok && !/js-debug|bootloader/i.test(tok));
        if (kept.length) env.NODE_OPTIONS = kept.join(' ');
        else delete env.NODE_OPTIONS;
        sanitized = true;
    }
    return { env, sanitized };
}

function usage(stream = process.stderr) {
    stream.write(
        `Usage: ${PROG} --site <file:line> --target <script.mjs>\n` +
        `       ${' '.repeat(PROG.length)} [--var <name>] [-- <target-args>...]\n`
    );
}

function die(code, msg) {
    process.stderr.write(`${PROG}: ${msg}\n`);
    if (code === EXIT_USAGE) usage(process.stderr);
    process.exit(code);
}

// --- CLI parse ---------------------------------------------------------------
function parseArgs(argv) {
    const a = { site: '', target: '', vars: [], targetArgs: [] };
    let inTargetArgs = false;
    for (let i = 0; i < argv.length; i++) {
        const s = argv[i];
        if (inTargetArgs) { a.targetArgs.push(s); continue; }
        if (s === '--') { inTargetArgs = true; continue; }
        if (s === '-h' || s === '--help') { usage(process.stdout); process.exit(EXIT_OK); }
        const eat = (flag) => {
            if (s.startsWith(flag + '=')) return s.slice(flag.length + 1);
            if (s === flag && i + 1 < argv.length) { i++; return argv[i]; }
            return undefined;
        };
        const siteV = eat('--site');
        if (siteV !== undefined) { a.site = siteV; continue; }
        const tgtV = eat('--target');
        if (tgtV !== undefined) { a.target = tgtV; continue; }
        const varV = eat('--var');
        if (varV !== undefined) {
            // CSV — match the multi-var protocol established by topo-debug-cpp.
            const names = varV.split(',').map(x => x.trim()).filter(x => x.length > 0);
            if (names.length === 0) die(EXIT_USAGE, '--var list is empty');
            for (const n of names) a.vars.push(n);
            continue;
        }
        die(EXIT_USAGE, `unknown argument: ${s}`);
    }
    if (!a.site) die(EXIT_USAGE, '--site is required');
    if (!a.target) die(EXIT_USAGE, '--target is required');
    if (a.vars.length === 0) a.vars.push('vec'); // default variable
    return a;
}

// Split "file:line" on the LAST ':' so Windows drive letters survive.
function splitSite(site) {
    const idx = site.lastIndexOf(':');
    if (idx < 0) die(EXIT_USAGE, `site '${site}' missing ':' (expected file:line)`);
    const file = site.slice(0, idx);
    const lineStr = site.slice(idx + 1);
    const line = Number.parseInt(lineStr, 10);
    if (!Number.isInteger(line) || line < 1) {
        die(EXIT_USAGE, `site '${site}' line must be a positive integer`);
    }
    return { file, line };
}

// --- Wire encoding ----------------------------------------------------------
const MAGIC = Buffer.from([0x54, 0x4F, 0x50, 0x4F]); // 'T','O','P','O'
const FRAME_TYPE_VAR_BYTES = 0x01;
const FRAME_TYPE_LAYOUT_DESCRIPTOR = 0x02;

function buildFrame(type, payload, frameId = 1n) {
    const hdr = Buffer.alloc(24);
    MAGIC.copy(hdr, 0);
    hdr.writeUInt8(type, 4);
    hdr.writeUInt8(0x00, 5);                 // flags
    hdr.writeUInt16LE(0x0000, 6);            // reserved
    hdr.writeBigUInt64LE(BigInt(frameId), 8);
    hdr.writeBigUInt64LE(BigInt(payload.length), 16);
    return Buffer.concat([hdr, payload]);
}

function writeJsonLine(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

function writeFrame(type, payload) {
    return new Promise((resolveP) => {
        const ok = process.stdout.write(buildFrame(type, payload), undefined, () => resolveP());
        if (ok) resolveP();
    });
}

// --- CDP plumbing -----------------------------------------------------------
// Node 22+ exposes a built-in `WebSocket` global. Each CDP message is a JSON
// object with `id` (request) → reply `{id, result|error}` and out-of-band
// events `{method, params}`.

class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();          // id → {resolve, reject}
        this.eventHandlers = new Map();    // method → handler[]
        ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data.toString()); }
            catch (e) { process.stderr.write(`${PROG}: bad CDP frame: ${e}\n`); return; }
            if (msg.id !== undefined) {
                const p = this.pending.get(msg.id);
                if (p) {
                    this.pending.delete(msg.id);
                    if (msg.error) p.reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
                    else p.resolve(msg.result);
                }
            } else if (msg.method) {
                const hs = this.eventHandlers.get(msg.method) || [];
                for (const h of hs) h(msg.params);
            }
        });
        ws.addEventListener('close', () => {
            for (const [, p] of this.pending) p.reject(new Error('CDP closed'));
            this.pending.clear();
        });
    }
    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolveP, rejectP) => {
            this.pending.set(id, { resolve: resolveP, reject: rejectP });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    on(method, handler) {
        if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, []);
        this.eventHandlers.get(method).push(handler);
    }
    once(method) {
        return new Promise((resolveP) => {
            const h = (params) => {
                const arr = this.eventHandlers.get(method);
                if (arr) {
                    const idx = arr.indexOf(h);
                    if (idx >= 0) arr.splice(idx, 1);
                }
                resolveP(params);
            };
            this.on(method, h);
        });
    }
    close() { try { this.ws.close(); } catch (_) { /* ignore */ } }
}

// Wait for an event matching `pred` or reject after `timeoutMs`.
function waitForPaused(cdp, timeoutMs) {
    return new Promise((resolveP, rejectP) => {
        const timer = setTimeout(() => {
            rejectP(new Error(`timeout waiting for Debugger.paused (${timeoutMs} ms)`));
        }, timeoutMs);
        const h = (params) => {
            clearTimeout(timer);
            const arr = cdp.eventHandlers.get('Debugger.paused');
            if (arr) {
                const idx = arr.indexOf(h);
                if (idx >= 0) arr.splice(idx, 1);
            }
            resolveP(params);
        };
        cdp.on('Debugger.paused', h);
    });
}

// Convert TypedArray ctor name → wire dtype string.
function ctorToDtype(ctorName, byteLength, length) {
    const elemSize = length > 0 ? byteLength / length : 0;
    switch (ctorName) {
        case 'Int8Array': return 'i8';
        case 'Uint8Array': case 'Uint8ClampedArray': return 'u8';
        case 'Int16Array': return 'i16';
        case 'Uint16Array': return 'u16';
        case 'Int32Array': return 'i32';
        case 'Uint32Array': return 'u32';
        case 'Float32Array': return elemSize === 4 ? 'f32' : '';
        case 'Float64Array': return elemSize === 8 ? 'f64' : '';
        case 'BigInt64Array': return 'i64';
        case 'BigUint64Array': return 'u64';
        default: return '';
    }
}

// --- Main flow --------------------------------------------------------------
async function run() {
    const args = parseArgs(process.argv.slice(2));
    const { file: siteFile, line: siteLine } = splitSite(args.site);

    if (!existsSync(args.target)) {
        die(EXIT_LAUNCH, `target script not found: '${args.target}'`);
    }

    // Spawn Node with --inspect-brk on a random port. Strip VS Code JS
    // Debug auto-attach hooks from the child env so its bootloader cannot
    // steal the single CDP client slot from us. `autoAttachStripped`
    // records that we detected (and removed) such hooks — used only to
    // sharpen the diagnostic if a launch failure still occurs. Nothing is
    // written to stderr on the success path: the merged stdout+stderr
    // stream is matched by anchored CTest regexes.
    const targetAbs = pathIsAbsolute(args.target) ? args.target : resolvePath(args.target);
    const { env: childEnv, sanitized: autoAttachStripped } = childEnvWithoutAutoAttach();
    const child = spawn(process.execPath,
        ['--inspect-brk=0', targetAbs, ...args.targetArgs],
        { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv });

    // Compose a launch-failure message, appending the single-client
    // conflict guidance when the symptom points at debugger contention
    // (post-banner connect/enable failure) or when VS Code auto-attach
    // was detected in the environment.
    const launchFail = (msg, { likelyConflict = false } = {}) =>
        (likelyConflict || autoAttachStripped)
            ? `${msg}\n  hint: ${CDP_CONFLICT_HELP}`
            : msg;

    // Parse stderr to discover the WebSocket URL. Node prints exactly one
    // line of the form `Debugger listening on ws://127.0.0.1:<port>/<UUID>`
    // before any user code runs (--inspect-brk pauses at entry).
    let wsUrl = '';
    let wsResolve, wsReject;
    const wsPromise = new Promise((res, rej) => { wsResolve = res; wsReject = rej; });
    const wsTimeout = setTimeout(
        () => wsReject(new Error('timeout waiting for Node Inspector banner on stderr')),
        15000);

    const rl = createInterface({ input: child.stderr });
    rl.on('line', (rawLine) => {
        // Hunt for the WS URL announcement, then stay quiet. Node's own
        // inspector chatter ("Debugger attached.", "Waiting for the debugger
        // to disconnect...", "For help, see:") is irrelevant to consumers of
        // the wire protocol — the CLI on the other end of stdout matches
        // PASS_REGULAR_EXPRESSION across the merged stdout+stderr stream
        // and any stray text breaks anchored regexes (`^32\n`, `^\[8\]\n`).
        // User stderr from the fixture itself (console.error) is also
        // suppressed here; future work that needs diagnostics from
        // the target can re-route fixture stderr via a dedicated channel.
        const m = rawLine.match(/Debugger listening on (ws:\/\/[^\s]+)/);
        if (m && !wsUrl) {
            wsUrl = m[1];
            clearTimeout(wsTimeout);
            wsResolve(wsUrl);
            return;
        }
        // Otherwise drop the line. Keeping stderr clean is essential for
        // anchored regex tests on the merged CTest output.
    });

    child.on('error', (e) => {
        wsReject(new Error(`failed to spawn node: ${e.message}`));
    });
    child.on('exit', (code, signal) => {
        // If we exit before connecting, surface it.
        if (!wsUrl) {
            wsReject(new Error(
                `node exited before Inspector started (code=${code}, signal=${signal})`));
        }
    });

    try { await wsPromise; }
    catch (e) {
        try { child.kill('SIGTERM'); } catch (_) {}
        // A consumed/never-seen banner is the classic symptom of another
        // tool having grabbed the inspector first.
        die(EXIT_LAUNCH, launchFail(e.message));
    }

    // Connect WebSocket. Node 22+ has built-in WebSocket global.
    const ws = new WebSocket(wsUrl);
    const wsOpen = new Promise((res, rej) => {
        ws.addEventListener('open', () => res(), { once: true });
        ws.addEventListener('error', (ev) => rej(new Error(`WS error: ${ev?.message || 'unknown'}`)),
            { once: true });
    });
    try { await wsOpen; }
    catch (e) {
        try { child.kill('SIGTERM'); } catch (_) {}
        // Banner was seen but the socket rejects us → another client
        // already holds the single CDP slot.
        die(EXIT_LAUNCH, launchFail(`WebSocket connect failed: ${e.message}`,
            { likelyConflict: true }));
    }

    const cdp = new CdpClient(ws);

    try {
        await cdp.send('Runtime.enable');
        await cdp.send('Debugger.enable');
    } catch (e) {
        cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
        die(EXIT_LAUNCH, launchFail(`failed to enable CDP domains: ${e.message}`,
            { likelyConflict: true }));
    }

    // Resolve breakpoint URL. CDP wants file:// URL. We accept either an
    // absolute path or a basename relative to target's dir.
    let bpUrl;
    if (pathIsAbsolute(siteFile)) {
        bpUrl = pathToFileURL(siteFile).href;
    } else {
        // Heuristic: if siteFile is just a basename and matches the target's
        // basename, use the target's absolute URL; otherwise try CWD-relative.
        const targetBase = targetAbs.split(/[\\/]/).pop();
        if (siteFile === targetBase) {
            bpUrl = pathToFileURL(targetAbs).href;
        } else {
            bpUrl = pathToFileURL(resolvePath(siteFile)).href;
        }
    }

    // At --inspect-brk entry, the target script has NOT been parsed yet, so
    // `setBreakpointByUrl` legitimately returns `locations: []` — the
    // breakpoint is registered as *pending* and CDP resolves it the moment
    // the script's <ScriptParsed> event fires. We only treat "never hit"
    // as an error once the wait-for-paused deadline expires below.
    let bpId;
    try {
        const r = await cdp.send('Debugger.setBreakpointByUrl', {
            url: bpUrl,
            lineNumber: siteLine - 1, // CDP is 0-indexed
            columnNumber: 0,
        });
        bpId = r.breakpointId;
    } catch (e) {
        cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
        die(EXIT_LAUNCH, `failed to set breakpoint: ${e.message}`);
    }

    // Node's `--inspect-brk` semantics observed on v22+ / v26:
    //   1. `Debugger.enable` + `Runtime.runIfWaitingForDebugger` releases the
    //      Inspector wait, and the FIRST `Debugger.paused` event fires at
    //      the entry of our top-level script (lineNumber 0 of the .mjs).
    //      Its `reason` is `"Break on start"` (or similar marker) — never our
    //      line breakpoint.
    //   2. After `Debugger.resume`, execution continues until our line
    //      breakpoint fires, which is the pause we actually care about.
    //
    // We pre-register both listeners BEFORE issuing runIfWaitingForDebugger
    // so that no event is missed during the round-trip.
    const entryPausedP = waitForPaused(cdp, BREAKPOINT_WAIT_MS);
    try {
        await cdp.send('Runtime.runIfWaitingForDebugger');
    } catch (e) {
        cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
        die(EXIT_RUNTIME, `runIfWaitingForDebugger failed: ${e.message}`);
    }

    let pausedParams;
    try { pausedParams = await entryPausedP; }
    catch (e) {
        cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
        die(EXIT_RUNTIME, `entry stop never fired: ${e.message}`);
    }

    // If the entry pause is NOT our breakpoint (it almost never is on
    // --inspect-brk), keep resuming and waiting until we hit a pause whose
    // top callFrame is in our target script at our target line. A wall-clock
    // deadline bounds the total loop. This loop also tolerates spurious
    // stops (e.g. uncaught exceptions during module load — the fixture is
    // tiny but worth not assuming).
    const overallDeadline = Date.now() + BREAKPOINT_WAIT_MS;
    while (true) {
        const top = pausedParams.callFrames?.[0];
        if (top && top.location &&
            top.location.lineNumber === (siteLine - 1)) {
            // Confirm the URL matches the file we asked for, when known.
            const url = top.url || '';
            if (!url || url === bpUrl) break;
        }
        // Not our breakpoint yet — resume and wait for the next pause.
        if (Date.now() >= overallDeadline) {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_RUNTIME, `timeout: breakpoint at ${args.site} never hit `
                + `(last pause at ${top?.url || '?'}:${(top?.location?.lineNumber ?? -1) + 1})`);
        }
        const nextP = waitForPaused(cdp, BREAKPOINT_WAIT_MS);
        try { await cdp.send('Debugger.resume'); }
        catch (e) {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_RUNTIME, `failed to resume past non-bp stop: ${e.message}`);
        }
        try { pausedParams = await nextP; }
        catch (e) {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_RUNTIME, `breakpoint never hit: ${e.message}`);
        }
    }

    if (!pausedParams.callFrames || pausedParams.callFrames.length === 0) {
        cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
        die(EXIT_RUNTIME, 'paused event has no callFrames');
    }
    const callFrameId = pausedParams.callFrames[0].callFrameId;

    // --- Emit wire records --------------------------------------------------
    writeJsonLine({ kind: 'breakpoint_hit', frame: 1, site: args.site });

    for (const varName of args.vars) {
        // 1. Get a probe object describing the variable. We extract the
        //    TypedArray ctor name + length + byteLength in one round-trip,
        //    then a second call to ferry the raw bytes back as a base64
        //    string (then-decoded locally to a Buffer). The two-step keeps
        //    the per-call payload bounded; large arrays could later switch
        //    to SHM_REF but the fixture is 64 bytes — well within
        //    a single CDP message budget.
        let metaR;
        try {
            metaR = await cdp.send('Debugger.evaluateOnCallFrame', {
                callFrameId,
                expression:
                    `(() => { const v = ${varName}; ` +
                    `if (v === undefined) return { __err: "undefined" }; ` +
                    `if (!(ArrayBuffer.isView(v))) return { __err: "not-typedarray", typeName: typeof v }; ` +
                    `return { ctor: v.constructor.name, length: v.length, byteLength: v.byteLength }; })()`,
                returnByValue: true,
                silent: true,
            });
        } catch (e) {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_RUNTIME, `evaluateOnCallFrame failed for '${varName}': ${e.message}`);
        }
        if (metaR.exceptionDetails) {
            const txt = metaR.exceptionDetails.text || 'exception';
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_RUNTIME, `variable '${varName}' threw on probe: ${txt}`);
        }
        const meta = metaR.result?.value;
        if (!meta) {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_RUNTIME, `variable '${varName}' probe returned no value`);
        }
        if (meta.__err === 'undefined') {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_RUNTIME, `variable '${varName}' is undefined at ${args.site}`);
        }
        if (meta.__err === 'not-typedarray') {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_UNSUPPORTED_TYPE,
                `variable '${varName}' (typeof=${meta.typeName}) is not a TypedArray — ` +
                `only TypedArrays (Float64Array, etc.) are supported`);
        }

        const dtype = ctorToDtype(meta.ctor, meta.byteLength, meta.length);
        if (!dtype) {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_UNSUPPORTED_TYPE,
                `variable '${varName}' (ctor=${meta.ctor}) is not a primitive ` +
                `int/float TypedArray; only primitive int/float TypedArrays are supported`);
        }

        // 2. Pull the bytes. We materialise via `Array.from(new Uint8Array(...))`
        //    and ship the integers back as JSON (returnByValue:true). For the
        //    small fixtures (64 bytes) this is trivial; >1 MiB payloads
        //    will move to SHM_REF in a later iteration.
        let bytesR;
        try {
            bytesR = await cdp.send('Debugger.evaluateOnCallFrame', {
                callFrameId,
                expression:
                    `Array.from(new Uint8Array(${varName}.buffer, ${varName}.byteOffset, ${varName}.byteLength))`,
                returnByValue: true,
                silent: true,
            });
        } catch (e) {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_RUNTIME, `byte extraction failed for '${varName}': ${e.message}`);
        }
        if (bytesR.exceptionDetails) {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_RUNTIME,
                `byte extraction threw for '${varName}': ${bytesR.exceptionDetails.text || 'exception'}`);
        }
        const byteArr = bytesR.result?.value;
        if (!Array.isArray(byteArr)) {
            cdp.close(); try { child.kill('SIGTERM'); } catch (_) {}
            die(EXIT_RUNTIME, `byte extraction did not return an array for '${varName}'`);
        }
        const payload = Buffer.from(byteArr);

        // Shape: 1-D = [length]; strides: row-major in bytes.
        const elemSize = meta.length > 0 ? Math.trunc(meta.byteLength / meta.length) : 0;
        const shape = [meta.length];
        const strides = [elemSize];

        await writeFrame(FRAME_TYPE_VAR_BYTES, payload);

        const layoutJson = JSON.stringify({
            variable: varName,
            dtype,
            shape,
            strides,
        });
        await writeFrame(FRAME_TYPE_LAYOUT_DESCRIPTOR, Buffer.from(layoutJson, 'utf8'));
    }

    // --- Await control-plane continue --------------------------------------
    const stdinRl = createInterface({ input: process.stdin });
    let gotContinue = false;
    for await (const line of stdinRl) {
        try {
            const j = JSON.parse(line);
            if (j.op === 'continue') { gotContinue = true; break; }
        } catch (_) { /* ignore non-JSON */ }
    }
    if (!gotContinue) {
        // stdin closed without an op — treat as continue.
    }

    try { await cdp.send('Debugger.resume'); } catch (_) { /* inferior may already be exiting */ }

    // Wait for child to exit cleanly (bounded).
    const childExit = new Promise((res) => {
        if (child.exitCode !== null) return res();
        child.once('exit', () => res());
    });
    const exitTimeout = new Promise((res) => setTimeout(res, 5000));
    await Promise.race([childExit, exitTimeout]);
    if (child.exitCode === null) {
        try { child.kill('SIGTERM'); } catch (_) {}
    }
    cdp.close();

    process.exit(EXIT_OK);
}

run().catch((e) => {
    process.stderr.write(`${PROG}: unhandled error: ${e?.stack || e}\n`);
    process.exit(EXIT_RUNTIME);
});
