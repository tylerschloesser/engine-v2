# 0015: Threads, memory, and topology

Status: Accepted (2026-09-19)

## Context

Requirements in [`../spec/runtime-and-packaging.md`](../spec/runtime-and-packaging.md): the main thread does only what is necessary, as much as possible runs as Rust→WASM in workers, garbage is minimised, cross-origin isolation is mandatory with no `postMessage` fallback, stable Rust only, at most 256 MB per WASM instance and a 64 MiB default world budget on the baseline phone, and a download budget for the `.wasm`. Fixed elsewhere: one `.wasm` everywhere ([0002](0002-determinism-same-wasm-everywhere.md)); a numbers-only ABI ([0014](0014-js-wasm-boundary.md)); the renderer, camera and input are TypeScript on the main thread ([0018](0018-renderer.md), [0019](0019-camera-input-and-overlay.md)); per-isolate allocation budgets ([0016](0016-zero-gc-definition.md)); single-player speaks the multiplayer protocol ([0009](0009-transport-and-hosting.md), [0012](0012-prediction-and-reconciliation.md)). `spikes/cross-origin-sab` measured the cross-thread options.

## Decision

**1. Browser threads.** Shared-nothing actors: single-threaded instances of the one compiled module, each with its own non-shared memory. The main thread compiles the module once (`compileStreaming`), spawns every worker (no nested workers), and posts each the `Module` and its SABs.

| Thread | Language | WASM role ([0014](0014-js-wasm-boundary.md)) | Owns | Talks to, via |
|---|---|---|---|---|
| **Main** | TypeScript | none, ever | DOM, game UI, canvas and GPU device, camera, input, overlay | writes camera block, input ring, action ring; reads DrawList triple buffer, chunk-upload ring, UI ring, anchors ([0018](0018-renderer.md), [0019](0019-camera-input-and-overlay.md), [0003](0003-game-facing-api.md)) |
| **Client worker** | TS shell + Rust | `client` | replica, prediction overlay, interpolation, pristine-chunk cache and generation queue, `extract`, texel conversion, **all uplink assembly** (actions, camera report from the camera block, presence) | downlink/uplink ring pair to the net worker *or* the sim worker; request ring and result slabs to worldgen workers ([0008](0008-chunk-generation.md)) |
| **Net worker** (multiplayer only) | TypeScript | none | the `WebSocket`, reconnect timing ([0013](0013-sessions-and-integrity.md)); a byte pump that never parses frames | copies each message into the downlink ring; drains the uplink ring into `send` |
| **Sim worker** (single-player only) | TS shell + Rust | `sim` | authoritative world, tick loop, OPFS handles and the Web Lock ([0005](0005-persistence-and-recovery.md)) | a SAB ring pair implementing `Connection` ([0009](0009-transport-and-hosting.md)) |
| **Worldgen workers** (1, or 2 when `hardwareConcurrency >= 8`: [0008](0008-chunk-generation.md)) | TS shell + Rust | `gen` | nothing persistent | request ring in, 4,096-byte result slabs out |

**Single-player vs multiplayer.** The client worker cannot tell them apart: the same frame bytes ([0011](0011-wire-format-and-deltas.md)) arrive on the same ring. Multiplayer = main + client + net + gen (client and gen instances). Single-player = main + client + sim + gen, no socket and no net worker; two instances that matter (client, sim) is the price of one protocol.

**Server.** One JS context, one `sim`-role instance, no workers, no SABs. Connections arrive from the injected adapter ([0009](0009-transport-and-hosting.md)); bytes are copied straight between socket buffers and the instance's regions; worldgen runs synchronously plus the between-tick warmer ([0008](0008-chunk-generation.md)). The TS sim host (pacing, subscriptions, fan-out, persistence calls) is the same code as in the sim worker; only `Connection`, `Storage` and the clock differ, which is why `Storage` writes are never awaited on the tick path and the adapters decide how to be synchronous ([0005](0005-persistence-and-recovery.md)).

**2. SAB structures are the only steady-state cross-thread mechanism.** Three shapes, all fixed-size, created at setup, carrying the same bytes as the wire where applicable:
- **SPSC ring:** `Int32Array` control block (head, tail, drops, wake word) + fixed slots (default 1 KiB) with **one preallocated `Uint8Array` per slot**; large messages span slots. A full reliable ring is backpressure (the producer keeps the message and retries; the net worker may queue in its own heap); it is never silent loss. `drops` must read 0 in tests.
- **Seqlock block:** small latest-wins records (camera block, clocks).
- **Triple buffer:** large latest-wins frames (the DrawList).

Measured (headless Chromium 153, ~10 KB per frame worker → main, copied into a non-shared `WebAssembly.Memory`): the ring polled once per rAF caused **0 GCs** and **~13 B/frame**, indistinguishable from an empty rAF loop (12–13 B/frame, attributed to native code), over 10 s and again over 60 s (37 k messages, ~37 MB). The same traffic over `postMessage`: **~180 B/message** as objects, **~273 B** with a fresh transferred buffer (plus a **major GC**), **~325 B** with a transferable pool, 1–3 scavenges per 10 s. The ring worked with 0 sequence errors in Chromium, WebKit and Firefox.

**Wake-ups.** `Atomics.waitAsync` costs **~152 B per wake**, so it is not used. The main thread never blocks: it polls its rings once per rAF. Workers with a WASM instance **block in `Atomics.wait`** on their wake word: the client worker is notified by main once per rAF after the camera-block write (this is the worker's frame clock: it drains its rings, calls `frame`, publishes a DrawList that main shows next rAF, [0018](0018-renderer.md)) and by its producers when they push; the sim worker waits with a timeout equal to the time to its next tick deadline; worldgen workers wait on their request ring. `Atomics.store` + `Atomics.notify` from main and an `Atomics.wait` loop in a worker measured zero allocation on both sides (`spikes/zero-gc-webgpu`). A blocked worker receives no events, so a `yield` flag in the control block returns it to its event loop for tests and CDP ([0016](0016-zero-gc-definition.md), [0020](0020-testing-strategy.md)), shutdown, and Promise-only APIs (opening an OPFS file). The net worker is event-driven (it must receive socket events) and drains the uplink ring on a `setInterval` (a timer loop measured 0 B). `postMessage` is used only for setup (the `Module`, SABs, config), fatal errors and lifecycle.

**3. Cross-origin isolation is mandatory.** Every response of the game's origin carries exactly:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Measured in Chromium 153, WebKit 26.6 and Firefox 155, `vite dev` and `vite preview`: `require-corp` isolates all three; **WebKit silently ignores `credentialless`** (`crossOriginIsolated === false`, no `SharedArrayBuffer`), so it is never used; **the worker script response itself needs COEP**: with headers on HTML only, all three engines refuse the module worker with a bare `error` event. Headers must therefore match every path. The engine checks `crossOriginIsolated` at start and fails with a readable error, and turns a pre-ready worker `error` into "worker script blocked: is COEP set on every path?".
- *What breaks:* a cross-origin `<img>`/`fetch` without `Cross-Origin-Resource-Policy: cross-origin` or CORS (`crossorigin` + `Access-Control-Allow-Origin`) is blocked (measured). From documentation, untested: popups lose `window.opener` (OAuth, payments); third-party iframes must send COEP + CORP themselves; a game embedded in a portal is isolated only if the embedder is isolated and passes `allow="cross-origin-isolated"`. The intended shape, a self-contained app with same-origin assets and no accounts, loses nothing. A `wss://` connection to another origin is not an embedded resource and is expected to be unaffected.
- *Per host:* Vite `server.headers` **and** `preview.headers` (set by the engine's Vite plugin, [0017](0017-packaging-and-build.md)); Netlify and Cloudflare Pages `_headers` with `/*`; Vercel `vercel.json` with `/(.*)` (static client only, [0009](0009-transport-and-hosting.md)); a game server that serves the client sets them itself. **GitHub Pages cannot set headers**; the `coi-serviceworker` workaround is not supported by the engine. Listings: [`../../spikes/cross-origin-sab/RESULT.md`](../../spikes/cross-origin-sab/RESULT.md) section 4.

**4. No WASM threads, no shared WASM memory, therefore copy-in/copy-out.** `target_feature = "atomics"` is nightly-only on `wasm32-unknown-unknown`, and the working recipe (wasm-bindgen-rayon) needs a pinned nightly, `-Z build-std`, shared imported memory with a declared maximum, and wasm-bindgen. Requirements fix stable Rust. A non-shared memory cannot be backed by a SAB, so every cross-thread byte is copied twice by JS `TypedArray.set` between preallocated views: instance region → SAB → instance region or GPU (mechanics: [0014](0014-js-wasm-boundary.md)). Worst case is the 2 MiB DrawList per frame; typical traffic is kilobytes.

**5. Memory: a fixed arena per instance, reserved at init.** `engine_init` performs **one `memory.grow` to the role's configured arena size** before JS builds any view; the engine's global allocator (installed by `export_game!`) serves everything from it, with world data in engine pools ([0007](0007-world-model.md)). The module declares no `maximum` (a large declared maximum failed instantiation on iOS). Sizes are per-game config in bytes per role:

| Role | Default arena | Holds | Ceiling |
|---|---|---|---|
| `sim` | **96 MiB** | the 64 MiB world budget ([0007](0007-world-model.md)) + 32 MiB for snapshot/log/frame-build buffers and allocator slack | 256 MiB on mobile (Requirements); up to 2 GiB by config on desktop/server; ≤ ~96 MiB on Durable Objects ([0009](0009-transport-and-hosting.md)) |
| `client` | **48 MiB** | 4 MiB dense cache, replica entities and overlays for ≤ 128 subscribed chunks (≤ ~18 MiB at 128 B per entity), overlay, interpolation, 2 MiB DrawList staging, regions | 256 MiB |
| `gen` | **4 MiB** each | stack, tables, one output slab | |

**Whole-tab target on the baseline phone: ≤ 256 MiB** in single-player, the worst case: 148 MiB of arenas (sim + client + one gen) + ~12 MiB of SABs (6 MiB triple buffer, upload ring, rings) + ~20 MiB GPU-side ([0018](0018-renderer.md)) + ~60 MiB for five JS heaps, compiled code and the game's DOM. That sits under the ~300 MB low end of WebKit's per-tab kill threshold on iPhone 11–14-class devices. Multiplayer omits the sim arena (~160 MiB). At init each instance checks its configured budgets against its arena ([0007](0007-world-model.md)), and the main thread rejects a config whose arenas sum past the per-game tab target.
**Growth is tolerated but counted.** The deterministic state budget ([0007](0007-world-model.md)) refuses new state long before bytes run out, so exhaustion means a mis-sized config or a leak. Dev and test builds trap with a message. Release builds grow in 16 MiB steps up to the ceiling and bump `engine_mem_grows()`; the loader rebuilds its views ([0014](0014-js-wasm-boundary.md)), reports the count, and [0016](0016-zero-gc-definition.md) asserts it stays 0 in steady state. A failed grow is a panic ([0005](0005-persistence-and-recovery.md)). Memory never shrinks; leaving a world drops the instance.

**6. One module, several roles; download budget.** One `.wasm`, instantiated per role. A client-only build would strip little (the client needs `apply` for prediction and the generator for terrain; only `tick` rules and persistence are sim-only) while doubling build time and creating a second artifact, and the single file's hash is the build identity ([0005](0005-persistence-and-recovery.md), [0013](0013-sessions-and-integrity.md)). Budgets, enforced by a size test on the reference game ([0020](0020-testing-strategy.md)): **`.wasm` ≤ 1 MB brotli (warn), 2 MB (fail)** (Requirements); **engine JS ≤ 50 KB brotli** across all entrypoints. Default target features only; never `relaxed-simd` ([0002](0002-determinism-same-wasm-everywhere.md)).

## Alternatives rejected

- **`postMessage` + transferables, as primary or as fallback:** 180–325 B and a `MessageEvent` per message on the receiver, a pool made it worse, and a major GC appeared; any of it breaks the 8 B/frame isolates of [0016](0016-zero-gc-definition.md). A fallback doubles the test surface (duckdb-wasm ships `coi` and non-`coi` builds for this reason), and Requirements exclude it.
- **WASM threads / one shared memory:** nightly toolchain, wasm-bindgen, a declared maximum (the iOS failure mode), allocator locks that cannot `Atomics.wait` on main, and a nondeterminism risk in the sim.
- **Renderer in a worker (OffscreenCanvas):** rejected in [0018](0018-renderer.md). **WASM on the main thread:** decode, prediction and `extract` would compete with input and the game's DOM for the frame.
- **The socket in the client worker:** every message's `MessageEvent` + `ArrayBuffer` would land in a strict isolate; the net worker exists to quarantine them.
- **A single worker for everything:** a long tick, a snapshot write or a generation burst would delay `extract`; socket garbage would share the frame-producing heap; blocking OPFS and `Atomics.wait` could not coexist with socket events.
- **Nested workers** (support questions; nothing gained). **`Atomics.waitAsync` wake-ups** (152 B per wake; Baseline only since Nov 2025). **Grow-on-demand memory** (unbounded view invalidation, late failure on mobile). **Separate client and sim builds** (above).

## Consequences

- Every cross-thread hop costs two copies and up to one frame or one poll interval of latency; camera input never takes a hop ([0019](0019-camera-input-and-overlay.md)).
- Games cannot be hosted on GitHub Pages, embed CORP-less third-party content, or use popup-based OAuth; assets are same-origin. Documented for game authors in the reference game's README ([0017](0017-packaging-and-build.md)).
- A phone-hosted single-player world must fit the sim arena; larger worlds need a server or a desktop.
- Heap measurements are desktop Chromium only; the ring drain showed < 1 B/frame of undiagnosed allocation in 60 s runs; only worker → main was measured.
- Deferred to Phase 2: on-device ceilings (largest reservation that instantiates on a real iPhone and a mid-range Android; whether sim + client + a WebGPU context coexist; whether untouched reserved pages count against the tab), because it needs Tyler's devices; the defaults above are revisited with those numbers.
- Deferred to Phase 2: ring capacities per link, the uplink poll period, the control-block layout and the `yield` protocol, because they are implementation numbers behind a fixed mechanism; and verifying the header listings on one real static host, because the spike was not allowed to deploy.

## Sources

- Spikes: [`../../spikes/cross-origin-sab/RESULT.md`](../../spikes/cross-origin-sab/RESULT.md) (isolation matrix, ring, heap table, host listings); [`../../spikes/zero-gc-webgpu/RESULT.md`](../../spikes/zero-gc-webgpu/RESULT.md) (`Atomics` lockstep at zero allocation; `postMessage` negative control). [`../../spikes/vite-lib-worker-wasm/RESULT.md`](../../spikes/vite-lib-worker-wasm/RESULT.md): a `Module` compiled on main instantiates in workers in Chromium, Firefox and WebKit; a stub engine + game cdylib is 7 KB brotli.
- [`../research/runtime-and-packaging.md`](../research/runtime-and-packaging.md) 1.4–1.6, 2, 3.2, 3.3, 3.8, 3.9.
- Isolation: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy · https://web.dev/articles/coop-coep · https://bugs.webkit.org/show_bug.cgi?id=230550 · GitHub Pages: https://github.com/orgs/community/discussions/13309
- `Atomics.waitAsync`: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync
- WASM threads on Rust: https://doc.rust-lang.org/nightly/rustc/platform-support/wasm32-unknown-unknown.html · https://github.com/RReverser/wasm-bindgen-rayon
- Memory: https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow · iOS maximum: https://github.com/godotengine/godot/issues/70621 · WebKit tab limits: https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit · Android: https://v8.dev/blog/4gb-wasm-memory
