// Minimal Node.js span-emitter for the topo-profile demo.
//
// Mirrors topo-lang-cpp/topo-profile/test/fixtures/spans_demo.cpp: emits
// three NDJSON span records on stdout following libtopo-observe's wire
// shape, so topo-profile (host-agnostic — only consumes the NDJSON
// contract) re-emits them under the Topo profile schema with
// `backend: "v8"`.
//
// Wire shape (one line per span):
//   {"name":"pipeline::demo::stageN","duration_ns":<ns>,
//    "thread_id":<u64>,"ts_ns":<ns since epoch>}
//
// Names follow `pipeline::<name>::stage<N>` so parseStagePipeline() in
// topo-profile recovers stage / pipeline fields. No transform / observe
// runtime — just stdlib `process.hrtime.bigint()` for monotonic timing
// and `Date.now()` for the wall clock.

function busy(us) {
    const deadlineNs = process.hrtime.bigint() + BigInt(us) * 1000n;
    let acc = 0n;
    while (process.hrtime.bigint() < deadlineNs) {
        for (let i = 0; i < 1000; i++) {
            acc ^= BigInt(i);
        }
    }
    // Defeat any optimisation.
    if (acc === -1n) process.stderr.write("unreachable\n");
}

function emitSpan(name, durationNs) {
    // Node has no public TID (worker_threads expose threadId but the main
    // thread is 0). Pin tid=0 to match libtopo-observe's u64 contract.
    const record = {
        name,
        duration_ns: Number(durationNs),
        thread_id: 0,
        ts_ns: Date.now() * 1_000_000,
    };
    process.stdout.write(JSON.stringify(record) + "\n");
}

function timedSpan(name, busyUs) {
    const startNs = process.hrtime.bigint();
    busy(busyUs);
    const durationNs = process.hrtime.bigint() - startNs;
    emitSpan(name, durationNs);
}

timedSpan("pipeline::demo::stage0", 5000);
timedSpan("pipeline::demo::stage1", 5000);
timedSpan("pipeline::demo::stage2", 5000);
