# Research: runtime, performance, and packaging

Phase 1 evidence for the open questions in `docs/spec/runtime-and-packaging.md`. Evidence and recommendations, not decisions. All URLs accessed 2026-09-19. Version numbers marked "(registry)" came from `npm view` / `cargo search` / the GitHub API on that date. Anything marked **unverified** is reasoning or memory that a spike must confirm.

Local toolchain: Node 22.18, pnpm 11.25, Rust 1.93 + `wasm32-unknown-unknown`, wasm-pack 0.14, Bun 1.3.8. No wasm-bindgen CLI, no Deno.

## 1. Findings

### 1.1 Vite (current major: 8)

- **Vite 8.3.0** is `latest` (released 2026-09-10); 7.3.6 is `previous` (registry). Vite 8.0.0 shipped 2026-03-12 with **Rolldown** as the single bundler for build *and* dependency pre-bundling; `worker.rollupOptions` is a deprecated alias of `worker.rolldownOptions`. https://vite.dev/blog/announcing-vite8 , https://vite.dev/config/worker-options.html , changelog https://github.com/vitejs/vite/blob/main/packages/vite/CHANGELOG.md
- **Workers.** The recommended form is `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`. Detection is static: `new URL()` must sit directly inside `new Worker()`, and the options must be literals. Alternatives: `?worker` (constructor), `?worker&inline` (base64), `?worker&url`. In dev, module workers rely on native browser support; in build they are bundled separately. https://vite.dev/guide/features.html#web-workers
- **`worker.format` defaults to `'iife'`.** A worker that uses code splitting, dynamic `import()`, or top-level await needs `worker: { format: 'es' }`. Plugins listed in `plugins` apply to workers only in dev; for build they must also be in `worker.plugins` (a function returning fresh instances). https://vite.dev/config/worker-options.html
- **WASM.** `import init from './x.wasm?init'` returns an init function taking an `importObject`; `?url` gives the asset URL for manual `WebAssembly.instantiateStreaming`; files under `assetsInlineLimit` (4 KB) are inlined as base64. Vite 8.0 added `?init` under SSR (Node-compatible runtimes only, uses `node:fs`); **Vite 8.1 added direct `.wasm` imports (WASM ESM integration)**, which needs top-level await. https://vite.dev/guide/features.html#webassembly , changelog entries #21102, #21779.
- **Workers/assets that originate inside a dependency.** Historically the dev-time optimizer flattened a dependency into `node_modules/.vite/deps/`, so a relative `new URL('./worker.js', import.meta.url)` inside it 404'd or returned "504 Outdated Optimize Dep"; production builds were always fine. Long-running issues: https://github.com/vitejs/vite/issues/8427 (2022), https://github.com/vitejs/vite/issues/11672 (2023), duplicates #20859 and #21056 (Nov 2025, Vite 7.1). The universal workaround was `optimizeDeps.exclude: ['the-lib']`. An earlier fix attempt (PR #17837) was closed unmerged in Dec 2024.
- **Fixed in Vite 8.0.0**: PR #21434 "optimizer: map relative `new URL` paths to correct relative file location" (merged 2026-01-26, listed under 8.0.0 in the changelog) rebases relative `new URL(..., import.meta.url)` in optimized deps to the original files and adds the library directory to `server.fs.allow`. Scope per the PR: dev mode, workers and assets (image/WASM covered by unit tests). Library-mode output (#21422) is not covered. https://github.com/vitejs/vite/pull/21434 . Prior-art READMEs (sqlite-wasm) still tell users to `exclude`, so whether exclusion is still needed on 8.3 is **unverified → spike S1**.
- **Linked workspace packages are not pre-bundled**: "Vite automatically detects dependencies that are not resolved from `node_modules` and treats the linked dep as source code." https://vite.dev/guide/dep-pre-bundling.html . Consequence: the in-repo reference game (pnpm `workspace:*`) will *not* reproduce what an external consumer sees. Packaging tests must install a `pnpm pack` tarball.
- **Headers.** `server.headers` and `preview.headers` both exist (type `OutgoingHttpHeaders`); `preview.headers` is not documented as inheriting `server.headers`, so set both. https://vite.dev/config/server-options.html , https://vite.dev/config/preview-options.html
- An experimental "bundled dev / full bundle mode" is landing through 8.x with explicit worker support entries (#21235, #21415, #23068). Dev may eventually behave like build; a self-contained worker file is robust either way.

### 1.2 wasm-bindgen, wasm-pack, and alternatives

- **The rustwasm GitHub org was sunset.** Announcement 2025-07-21: wasm-bindgen moves to a new `wasm-bindgen` org with added maintainers; everything else archived or handed to maintainers; org archived Sept 2025. https://blog.rust-lang.org/inside-rust/2025/07/21/sunsetting-the-rustwasm-github-org
- **wasm-bindgen is healthy**: 0.2.128 released 2026-09-05, monthly releases, repo pushed 2026-09-18 (GitHub API). It has a newer `--target module` using source-phase imports (Node 24+), alongside `bundler`, `web`, `nodejs`, `deno`, `no-modules`. https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html . The CLI version must match the crate version exactly or it errors.
- **wasm-pack survived**: now at `wasm-bindgen/wasm-pack`, not archived; 0.13.1 (2024-10-29), **0.14.0 (2026-01-20)**, **0.15.0 (2026-05-15)**. The 0.14.0 *npm* package shipped a dead download URL (fixed in 0.15.0); 0.15 adds custom profiles, arbitrary wasm targets, `--panic-unwind`. (GitHub API; https://github.com/wasm-bindgen/wasm-pack/releases). A common view is that it is no longer needed: `cargo build` → `wasm-bindgen` CLI → `wasm-opt` gives more control and avoids wasm-pack's slow bundled wasm-opt. https://nickb.dev/blog/life-after-wasm-pack-an-opinionated-deconstruction/
- **What wasm-bindgen's glue allocates on the JS heap.** JS values referenced from Rust live in a module-local `heap` array (stack half for borrowed, slab half with free list for owned) or an externref table with `--reference-types`. https://wasm-bindgen.github.io/wasm-bindgen/contributing/design/js-objects-in-rust.html . From the generated code (memory of its output, **unverified in this session**): strings go through `TextEncoder`/`TextDecoder` (a new JS string per crossing); `&[T]` arguments are copied into WASM memory via `__wbindgen_malloc`; returned `Vec<T>`/`Box<[T]>` become *new* typed arrays (copy + allocation); exported structs become JS wrapper objects registered with a `FinalizationRegistry`; closures allocate JS functions; `i64/u64` cross as `BigInt`. Cached memory views are re-created when `byteLength === 0` (detached by growth). Exports that take and return only `i32/f32/f64` compile to direct calls and allocate nothing. So disciplined wasm-bindgen use *can* be allocation-free; the problems are elsewhere (see 3.1).
- **Hand-rolled `extern "C"` ABI.** Functions using only scalars and pointers are unaffected by the 2025 wasm32 C-ABI change (it only changed by-value struct passing; future-incompat warning since Rust 1.87). https://blog.rust-lang.org/2025/04/04/c-abi-changes-for-wasm32-unknown-unknown/ . `wasm32-unknown-unknown` defaults (LLVM `generic`): multivalue, mutable-globals, reference-types, sign-ext, plus nontrapping-fptoint and bulk-memory since Rust 1.87. `std` exists but threads panic, `fs` errors, `println!` is a no-op; **`HashMap` has no random seed on this target**. https://doc.rust-lang.org/nightly/rustc/platform-support/wasm32-unknown-unknown.html
- **Component model / wit-bindgen.** Tooling is active (wit-bindgen 0.62.0 on 2026-09-10; jco 2.11 on 2026-09-16, GitHub API) but no browser implements components natively; in browsers you `jco transpile` to core WASM + generated JS glue that lifts/lowers values into JS objects. Production-ready server-side (WASI 0.2), "not yet ready as a browser target". https://bytecodealliance.github.io/jco/transpiling.html , https://component-model.bytecodealliance.org/ . It adds a build tool and allocating glue; no benefit here.

### 1.3 Vite/Rollup plugins for Rust

| Plugin | Latest (registry) | Notes |
|---|---|---|
| `vite-plugin-wasm` | 3.6.0, 2026-03-15, peer `vite ^2…^8` | ESM integration for wasm-bindgen `bundler` target. Workers need it in `worker.plugins` too. Mostly superseded by Vite 8.1's native `.wasm` import. https://github.com/Menci/vite-plugin-wasm |
| `vite-plugin-top-level-await` | 1.6.0, 2025-07-17 | Pulls in `@swc/core`. Unneeded with modern `build.target`. |
| `@wasm-tool/rollup-plugin-rust` | 3.1.6, 2026-06-05 | Runs cargo + wasm-bindgen (auto-installs the CLI) + wasm-opt (`binaryen` peer), has watch patterns, "works out of the box with Vite". 7 runtime deps. https://github.com/wasm-tool/rollup-plugin-rust |
| `vite-plugin-wasm-pack` | last release 2022 | Dead. |

All of them assume wasm-bindgen. None fits a cargo-only pipeline; that pipeline needs roughly 150 lines of plugin code (spawn cargo, watch, reload).

### 1.4 SharedArrayBuffer and cross-origin isolation

- `SharedArrayBuffer` requires a secure context **and** cross-origin isolation: `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp | credentialless`; check `self.crossOriginIsolated`. Baseline "widely available" since Dec 2021 (Safari 15.2+). Without isolation, `postMessage` of a SAB throws. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- `require-corp`: every cross-origin no-cors subresource needs `Cross-Origin-Resource-Policy: cross-origin`, or must be fetched with CORS (`crossorigin` attribute). `credentialless`: no CORP needed, requests go without cookies. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy
- **Safari still does not support `credentialless`.** WebKit bug 230550 is status NEW, last touched 2026-09-07; Chromium and Firefox 119+ ship it. https://bugs.webkit.org/show_bug.cgi?id=230550 . So iOS needs `require-corp`, the strict variant.
- **What breaks** (https://web.dev/articles/coop-coep): popups lose `window.opener` (OAuth and payment popups); third-party iframes must themselves send COEP + CORP (ads, YouTube embeds, most widgets don't); CDN images/fonts/scripts without CORP or CORS are blocked; a game embedded *inside* someone else's page (portals such as itch.io) is only isolated if the embedder is isolated and delegates `allow="cross-origin-isolated"`. **Unverified detail:** under COEP the worker script responses must also carry the COEP header, so headers must apply to every path, not only `index.html`.
- `Atomics.waitAsync` (non-blocking, legal on the main thread) is Baseline "newly available" since Nov 2025; `Atomics.wait` stays worker-only. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync . Too new to depend on under a "current + previous major" browser policy; polling at frame/tick boundaries avoids it.
- **Setting the headers:**
  - Vite dev/preview: `server.headers` and `preview.headers`.
  - Netlify: `_headers` file or `[[headers]]` in `netlify.toml` (not applied to functions/proxied responses). https://docs.netlify.com/manage/routing/headers/
  - Cloudflare Pages: `_headers` file. https://blog.cloudflare.com/custom-headers-for-pages/
  - Vercel: `headers` in `vercel.json` / `vercel.ts`. https://vercel.com/docs/project-configuration
  - **GitHub Pages cannot set headers**; the only route is the `coi-serviceworker` hack (service worker re-serves with COOP/COEP, forces a reload on first visit). https://github.com/orgs/community/discussions/13309 , https://github.com/gzuidhof/coi-serviceworker

### 1.5 WASM threads in Rust

- `wasm32-unknown-unknown` "does not support wasm threads"; `target_feature = "atomics"` is nightly-only. https://doc.rust-lang.org/nightly/rustc/platform-support/wasm32-unknown-unknown.html
- `wasm-bindgen-rayon` 1.2 (repo last pushed 2025-11-21) requires: a pinned nightly (`nightly-2025-11-15`), `rust-src`, `-Z build-std=panic_abort,std`, `RUSTFLAGS` `+atomics,+bulk-memory`, linker args `--shared-memory --max-memory=… --import-memory` and TLS exports, wasm-bindgen `--target web`, and cross-origin isolation. https://github.com/RReverser/wasm-bindgen-rayon
- The main thread cannot `Atomics.wait`, so anything in a threaded module that takes a lock there (including the allocator) must spin or stay off the main thread.

### 1.6 `WebAssembly.Memory` semantics and ceilings

- Non-shared memory: "Every call to `grow` will detach any references to the old `buffer`, even for `grow(0)`"; views drop to length 0. Shared memory: the old `SharedArrayBuffer` is *not* detached but keeps its old length; re-read `memory.buffer` to see the new range. Memory never shrinks. https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow
- `Memory.prototype.toResizableBuffer()` (views that survive growth): Chrome/Edge 144+, Firefox 145+, Safari/iOS 26.2+, ~83% global. https://caniuse.com/mdn-webassembly_api_memory_toresizablebuffer . Too new to require in 2026; usable opportunistically later.
- **iOS Safari.** A 2 GiB *maximum* alone caused `RangeError: Out of memory` at instantiation on iOS 16 (Godot #70621, emscripten #19144); 256 MB worked. https://github.com/godotengine/godot/issues/70621 , https://github.com/emscripten-core/emscripten/issues/19144 . WebKit per-process limits track jetsam: ~300–450 MB on iPhone 11–14-class devices, ~1 GB+ on iPhone 15+; at 50% WebKit starts shedding, at 65% it drops compiled JS, at 100% the tab is killed. https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit
- **Android Chrome.** V8's cap is 4 GB (wasm32), but reports put reliable allocation on Android at roughly 300 MB, with specific devices failing to grow past ~220–256 MB (contiguous address space, 32-bit processes). https://v8.dev/blog/4gb-wasm-memory , https://discussions.unity.com/t/android-chromium-unable-to-grow-allocated-memory-above-256mb-confirmed/818820 (older reports; **needs a device spike**).
- Working number for 2026 mobile: **plan for ≤ 256 MB of linear memory per instance and well under ~400 MB per tab in total** (all instances + JS + GPU resources).

### 1.7 Server runtimes

- **Node has no built-in WebSocket server.** Official docs: Node "does not provide a built-in native WebSocket server implementation… one still needs to use libraries like `ws`"; the *client* is stable since 22.4.0. https://nodejs.org/en/learn/getting-started/websocket . Current Node docs are v26.9. `ws` is 8.21.3 (2026-08-06), zero dependencies of its own.
- **Bun**: built in. `Bun.serve({ fetch(req, server) { server.upgrade(req) }, websocket: { message(ws, msg) {} } })`; binary, backpressure signalling from `send()`, pub/sub. https://bun.com/docs/api/websockets
- **Deno**: built in. `Deno.upgradeWebSocket(req)` inside `Deno.serve`. https://docs.deno.com/examples/http_server_websocket/
- **workerd**: `WebSocketPair` (+ Durable Objects for a long-lived stateful process; hosting is `sync.md`'s question). No threads, no Web Worker API, `WebAssembly.instantiate()` "only supports pre-compiled modules" (no compile-from-bytes at runtime), and **128 MB per isolate including WASM memory**. https://developers.cloudflare.com/workers/runtime-apis/webassembly/ , https://developers.cloudflare.com/workers/platform/limits/
- **Loading a `.wasm`:**
  - Node: `WebAssembly.compile(await readFile(url))` works everywhere. `import source mod from './x.wasm'` since v24.0 (release candidate); instance-phase `.wasm` imports unflagged since v24.5 / v22.19 (local 22.18 predates this). https://nodejs.org/api/esm.html#wasm-modules
  - Bun: `import path from './x.wasm' with { type: 'file' }` then read + compile, or `Bun.file(path).arrayBuffer()`. https://bun.sh/docs/bundler/loaders
  - Deno ≥ 2.1: `import source mod from './x.wasm'` or instance imports; or `Deno.readFile`. https://deno.com/blog/v2.1
  - workerd: `import mod from './x.wasm'` yields a `WebAssembly.Module`. https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/
  - The only portable contract is "the host hands the engine a `WebAssembly.Module` or bytes".
- **`exports` conventions.** Key order is significant, most specific first; `types` first; always provide `default`; "using `node` and `default` branches is usually preferable to `node` and `browser`". https://nodejs.org/api/packages.html#conditional-exports . Runtime keys registered with WinterTC: `node`, `deno`, `bun`, `workerd`, `edge-light`, `netlify`, … (the registry explicitly doesn't define how tools use them). https://runtime-keys.proposal.wintertc.org/

## 2. Prior art and what to take from it

| Project | How it ships | Take |
|---|---|---|
| **@sqlite.org/sqlite-wasm** 3.53.4 (2026-09-08) | `exports` with `node`/`import`/`browser` plus a `./sqlite3.wasm` subpath. README requires the consumer to set COOP/COEP in `server.headers` and `optimizeDeps.exclude`. https://github.com/sqlite/sqlite-wasm | Document the exact consumer config; export static assets by subpath; "exclude from optimizer" is the battle-tested escape hatch. |
| **@ffmpeg/ffmpeg** 0.12.15 | Library calls `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })` internally, *and* exports `./worker`. Vite dev broke with "504 Outdated Optimize Dep" until users excluded it. https://github.com/ffmpegwasm/ffmpeg.wasm/issues/532 | A library-internal worker is the pattern that bites in Vite dev. Offer a consumer-owned worker path too. |
| **@duckdb/duckdb-wasm** 1.33 | Ships several prebuilt worker scripts + `.wasm` variants (`mvp`, `eh`, `coi`) as explicit export subpaths; consumer picks a bundle, gets URLs with `?url`, constructs the `Worker`, passes it in. | Consumer-constructed worker + explicit asset subpaths work under every bundler. The `coi` variant shows the cost of optional isolation: two builds. Avoid optionality. |
| **Rapier** (`@dimforge/rapier2d` 0.20, repo merged into `dimforge/rapier` 2026) | wasm-bindgen `bundler` target (needs a WASM-ESM plugin) and a `-compat` flavour with the WASM base64-inlined in JS. | Both exist only because a prebuilt `.wasm` must survive arbitrary bundlers. We don't ship a `.wasm`, so neither applies; don't inline. |
| **Ruffle** (`@ruffle-rs/ruffle`, nightly publishes) | Self-hosted bundle that fetches its `.wasm` relative to a configurable public path. | A runtime-configurable asset URL keeps the bundler out of it. |
| **Bevy web builds** | wasm-bindgen + web-sys + wgpu; binaries "upwards of 30 MB (15 MB with wasm-opt)"; size profile `opt-level="s"`, run wasm-opt after bindgen. https://bevy-cheatbook.github.io/platforms/wasm/size-opt.html | The anti-pattern for a mobile budget; renderer-in-Rust via web-sys is what costs the megabytes and the per-call JS objects. |
| **miniquad / macroquad** | No wasm-bindgen: a hand-written `gl.js` loader provides a fixed `extern "C"` import set. https://github.com/not-fl3/miniquad | Existence proof for a fixed, engine-owned JS loader with a hand-rolled ABI. Its cost: crates that assume wasm-bindgen don't work — hence the dependency rule in 3.7. |

Common thread for low-garbage Rust/WASM: keep state in linear memory, cross the boundary with numbers only, let JS read results through long-lived typed-array views, and hand buffers straight to the GPU API.

## 3. Recommendations

### 3.1 JS↔WASM boundary — hand-rolled ABI, no wasm-bindgen (confidence: high)

The decisive argument is packaging, not garbage. wasm-bindgen's JS glue is **generated per build from the final `.wasm`**. Because the game builds the WASM, the glue would be a game build artifact that the engine's prebuilt worker somehow has to import, produced by a CLI whose version must exactly match a crate inside the engine. With a fixed ABI, the engine's npm package ships a fixed loader and the game's build is just `cargo build`.

- **Exports** (generated into the game's cdylib by `engine::export_game!(MyGame)`, a `macro_rules!` macro, which also monomorphises the engine over the game type): `engine_abi_version() -> u32`; `engine_init(role, cfg_ptr, cfg_len) -> u32`; `engine_tick()`; `engine_frame(t_ms: f64)`; accessors returning pointers to fixed mailboxes (inbox/outbox byte queues with headers) and to a render-buffer descriptor table. Game hooks are ordinary Rust trait calls inside the module; **JS never sees a game-specific symbol**.
- **Imports**: one module name, `engine`, with `panic(ptr, len)` and `log(level, ptr, len)`. Time, randomness, and input are passed in. Nothing else.
- **Types at the boundary**: `i32`, `f32`, `f64` only. No `i64` (becomes `BigInt`, allocates); 64-bit values go through memory. No strings in steady state; config crosses once as bytes.
- The loader checks `engine_abi_version()` against its own constant and fails loudly on mismatch.
- A test asserts `WebAssembly.Module.imports(mod)` contains only `engine.*`, which catches any crate that smuggled in wasm-bindgen imports.

Rejected: wasm-bindgen restricted to numeric exports (viable for GC, but keeps the generated-glue and version-lock problems); component model/jco (no native browser support, allocating glue).

### 3.2 Cross-thread communication — SAB rings, cross-origin isolation required (confidence: medium-high)

- Fixed-capacity single-producer/single-consumer **ring buffers in standalone `SharedArrayBuffer`s**, carrying the same byte format as the network wire. Consumers **poll at their natural boundaries** (frame start, tick start): no events, no `Atomics.waitAsync` dependency. Small shared state blocks (camera, input, UI-facing state) use sequence-locked structs.
- Copying between a SAB and (non-shared) WASM memory without garbage: `subarray()` allocates a view, so use **fixed-size slots with one preallocated view per slot** and `wasmU8.set(slotView, destOffset)`. Large messages span slots. (**Unverified** that this is allocation-free in V8 and JSC → S2.)
- `postMessage` remains for setup and rare events (passing the compiled `WebAssembly.Module`, the SABs, errors, lifecycle).
- **Require cross-origin isolation; fail fast with a clear error if `!crossOriginIsolated`.** Use `COOP: same-origin` + `COEP: require-corp` (Safari lacks `credentialless`). A game that is a self-contained app with no accounts (proposed non-goal) loses little: all assets same-origin, no third-party iframes, no OAuth popups. Real costs: GitHub Pages only via the service-worker hack; embedding in portals is constrained; every cross-origin asset needs CORP/CORS.
- Rejected: `postMessage` + transferable pool as the primary path. Each message still allocates a `MessageEvent` and a fresh `ArrayBuffer` wrapper on the receiving side, so the render isolate can never reach a strict zero. Rejected as a *fallback* too: two transports doubles the test surface (DuckDB's `coi` vs. non-`coi` builds show the cost). S2 measures the postMessage baseline so this is decided on numbers.

### 3.3 Worker topology and memory ownership (confidence: medium; renderer placement is co-owned with `client.md`)

Shared-nothing actors: several single-threaded instances of the *same* module, each with its **own non-shared memory**, connected by SAB rings. One worker script with a role parameter. All workers are spawned from the main thread (avoids nested-worker support questions).

| Thread | WASM instance | Owns | Talks via |
|---|---|---|---|
| **Main** | none | DOM, game UI, raw input capture, overlay anchoring | writes input block (SAB); reads camera + UI state blocks (SAB) |
| **Client worker** (render + state) | `role=client`, small arena (tens of MB) | mirror of subscribed chunks, interpolation, prediction, render extraction; TS glue drives WebGPU on an `OffscreenCanvas` using `queue.writeBuffer(buf, off, memory.buffer, ptr, len)` straight from linear memory | rings to/from sim or net worker |
| **Net worker** (multiplayer) | none | the `WebSocket`. Its unavoidable per-message garbage (`MessageEvent`, `ArrayBuffer`) stays in this isolate | copies frames into a ring |
| **Sim worker** (single-player/host) | `role=sim`, large arena sized from world cap | authoritative world, tick loop, persistence | rings to client worker; chunk slabs from gen pool |
| **Worldgen pool** (single-player; N = clamp(cores − 3, 1, 4)) | `role=gen`, tiny arena | nothing persistent; pure `(seed, coords) → chunk bytes` | SAB slabs to sim |

- The client runtime must be **thread-agnostic** so it can also run on the main thread if WebGPU-on-OffscreenCanvas-in-a-worker is unreliable on iOS Safari (a `client.md` spike). With SAB the input hop costs no events and no garbage; overlay anchors read a camera at most one frame stale.
- Single-player therefore has two instances that matter (client + sim). That is the honest price of "identical protocol"; the client arena is small.
- **WASM threads: no** (confidence: high). They need nightly + `build-std` + atomics + shared/imported memory with a declared maximum, contradict "make the Rust toolchain painless", add nondeterminism risk to the sim, and practically require wasm-bindgen(-rayon). Revisit only if profiling shows a single-threaded tick cannot keep up. Policy: **stable Rust only**.

### 3.4 What "zero GC" means, measurably (confidence: medium-high; mechanism belongs to `testing.md`)

"No GC happened during N frames" is weak on its own: V8's young generation can absorb megabytes of sloppy allocation before the first scavenge. Assert **allocation**, and use GC events as the second check.

- **Window**: after load, a warm-up (≥120 frames, so JIT and inline caches settle), then a forced full GC (CDP `HeapProfiler.collectGarbage`), then a scripted steady-state window of **600 frames** with continuous camera pan (so chunks stream in and out), ticks running, deltas arriving, and actions being sent.
- **Strict isolates** — the frame-loop isolate (client worker, or main if the renderer lives there) and the sim worker:
  1. zero GC events of any kind (scavenge, mark-compact, incremental marking) in the window; and
  2. JS heap used-size delta across the window ≤ 64 KB (CDP `Runtime.getHeapUsage` per target). With no GC in the window, used size is monotonic, so the delta *is* bytes allocated.
- **Main thread** when it only does input + DOM: same two checks with the game UI idle. DOM work by the game UI is exempt.
- **Net worker**: budgeted, not zero: ≤ 1 KB of JS allocation per received message, no major GC in the window.
- **WASM side**: `memory.buffer.byteLength` unchanged across the window (no `memory.grow`).
- Exempt: load, resize/DPR change, device loss, reconnect, tab background/foreground.
- Diagnostics (not assertions): sampling heap profiler with a small interval to name allocation sites.

### 3.5 Exports map (confidence: medium-high)

Explicit subpaths; **no runtime conditions** (`node`/`bun`/`workerd`/`browser`). Condition sets vary by tool (Vite, wrangler, Bun all differ), while subpaths are predictable and let the adapters import runtime built-ins without poisoning the portable core.

```jsonc
{
  "name": "<TBD>",
  "type": "module",
  "sideEffects": false,
  "files": ["dist", "crates"],
  "exports": {
    ".":               { "types": "./dist/client.d.ts",        "default": "./dist/client.js" },
    "./worker":        { "types": "./dist/worker.d.ts",        "default": "./dist/worker.js" },
    "./server":        { "types": "./dist/server.d.ts",        "default": "./dist/server.js" },
    "./server/node":   { "types": "./dist/server-node.d.ts",   "default": "./dist/server-node.js" },
    "./server/bun":    { "types": "./dist/server-bun.d.ts",    "default": "./dist/server-bun.js" },
    "./server/deno":   { "types": "./dist/server-deno.d.ts",   "default": "./dist/server-deno.js" },
    "./vite":          { "types": "./dist/vite.d.ts",          "default": "./dist/vite.js" },
    "./package.json":  "./package.json"
  },
  "dependencies": {},
  "peerDependencies": { "vite": "^8.0.0" },
  "peerDependenciesMeta": { "vite": { "optional": true } }
}
```

- `dist/worker.js` is a **single self-contained ES module** (no bare imports, no shared chunks) that contains every role.
- `./server` uses only web-standard APIs; `node:`/`Bun.`/`Deno.` appear only in the adapter subpaths.
- **Who constructs the `Worker`.** Support both; S1 picks the default:
  - (A) engine-internal: `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })` inside `dist/client.js`. Zero game code, but depends on bundler detection inside `node_modules` (fixed in Vite 8.0 dev per PR #21434; always fine in build).
  - (B) game-owned, bundler-proof: the game has a two-line `worker.ts` (`import { run } from '<engine>/worker'; run()`) and passes `createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
  - If (A) shows any flakiness in S1, ship (B) only.
- **The WASM is data, not an import.** Because all game logic is inside the WASM, the worker script never imports game JS. The game passes a URL: `createClient({ canvas, wasmUrl })`. Main does `WebAssembly.compileStreaming(fetch(wasmUrl))` once and posts the `Module` to each worker (compiled code shared, no recompilation; **unverified on Safari → S1**).

### 3.6 Rust build pipeline, dev loop, and how the engine crate reaches the game (confidence: medium-high)

- **Pipeline: plain cargo.** `cargo build --target wasm32-unknown-unknown [--release]` on the game's cdylib. No wasm-bindgen CLI, no wasm-pack. Optional `wasm-opt` for release if found on `PATH` (never an npm dependency of the engine). Rejected: wasm-pack (alive, but only wraps wasm-bindgen); `rollup-plugin-rust` (assumes wasm-bindgen, 7 deps).
- **`<engine>/vite` plugin** (Node built-ins only; Vite is an optional, types-only peer). It:
  1. runs the cargo build on start and on change (`fs.watch` recursive over the game crate and the engine crate);
  2. serves/emits the `.wasm` as a hashed asset behind `virtual:engine/wasm-url`;
  3. sends Vite's `full-reload` after a successful build and forwards cargo errors to the overlay;
  4. injects the config below.
- **Game `vite.config.ts`:**
  ```ts
  import { defineConfig } from 'vite'
  import { engine } from '<engine>/vite'
  export default defineConfig({ plugins: [engine({ crate: './sim' })] })
  ```
  What the plugin sets, i.e. what a game must write by hand without it:
  ```ts
  const coi = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
  export default defineConfig({
    server:  { headers: coi },
    preview: { headers: coi },
    worker:  { format: 'es' },
    optimizeDeps: { exclude: ['<engine>'] },   // belt and braces; S1 tells us if Vite 8 still needs it
    build: { target: 'es2022' },
  })
  ```
  Production hosting needs the same two headers on **every** path (`_headers`, `vercel.json`, or the game server).
- **Game `Cargo.toml`:**
  ```toml
  [package]
  name = "game"
  edition = "2024"

  [lib]
  crate-type = ["cdylib", "rlib"]   # cdylib → the .wasm; rlib → native `cargo test`

  [dependencies]
  engine = { path = "../node_modules/<engine>/crates/engine" }

  [profile.dev]
  opt-level = 1
  [profile.dev.package."*"]
  opt-level = 3                     # optimise the engine even in dev builds
  [profile.release]
  opt-level = 3                     # revisit "s" against the size budget
  lto = "fat"
  codegen-units = 1
  panic = "abort"
  strip = true
  ```
  plus `rust-toolchain.toml` (`channel = "stable"`, `targets = ["wasm32-unknown-unknown"]`) so rustup installs the target on first build, and one line in `lib.rs`: `engine::export_game!(MyGame);`.
- **How the crate reaches the game: bundled inside the npm package** (`crates/` in `files`), consumed as a cargo `path` dependency through `node_modules` (pnpm's symlink is fine for cargo). The JS loader and the Rust ABI are one private, version-locked interface; shipping them in one artifact makes skew impossible, and it works whether or not anything is ever published. The reference game points its path dep at the same directory in the workspace. crates.io, if Tyler wants public, is a mirror. Rejected: crates.io as the primary channel (two registries to keep in lockstep).
- **Dev loop (estimates, unverified → S3):** edit Rust → watcher (~50 ms) → incremental `cargo build` of a small game crate with the engine as a path dep: **1–4 s** on Apple Silicon → full reload. Release with fat LTO: 20–60 s. If the loop is slow, the levers are dev `opt-level`, splitting the engine into smaller crates, and no proc-macros. Later nicety: snapshot → reload → restore so a reload keeps the world (determinism makes this cheap).

### 3.7 Rust dependency policy (confidence: medium)

- **Engine runtime crates: zero third-party dependencies by default**; exceptions by ADR. Bar for an exception: no transitive `wasm-bindgen`/`js-sys`/`web-sys`; deterministic (no ambient time, randomness, threads, or randomly seeded hashing); no build script or proc-macro unless unavoidable; measured size impact; MIT/Apache.
- Things we'd otherwise import are small to own: PRNG (PCG/xoshiro), a fixed hasher, the binary codec (the zero-alloc wire format is core engine work anyway; `sync.md`). `bytemuck` is the likeliest first exception.
- **No `wgpu`** (implies wasm-bindgen + web-sys, megabytes, per-call JS objects) — the renderer drives WebGPU from TS.
- Dev-dependencies are unrestricted.
- **Game crates**: the game's choice, subject to two mechanical gates the engine provides: the imports check (only `engine.*`) and the determinism rules from `simulation.md`. Crates that assume wasm-bindgen on this target (`getrandom` JS backend, `instant`, `web-time`, `chrono` wasmbind) fail the first gate by design.
- If game authors need derive ergonomics for actions/deltas, an engine-owned proc-macro crate is acceptable (one-time `syn` compile cost, no incremental cost); start with `macro_rules!`.

### 3.8 WASM memory — fixed arena reserved at init, growth tolerated but counted (confidence: medium)

- Each instance reserves its whole arena **once during `engine_init`** (a single `memory_grow` to the configured size) before JS caches any view. The engine installs the `#[global_allocator]` (via `export_game!`) and serves all allocations from that reservation; world data uses engine pools/slabs inside it. Untouched pages are not committed by the OS, so reservation is cheap where it succeeds (**unverified on iOS → S4**).
- Arena sizes come from per-game config, **expressed in bytes per role**, e.g. client 64 MB, gen 8 MB, sim = f(world cap). Defaults keep every instance ≤ 256 MB so they instantiate on mobile; desktop/server sims may configure up to ~2 GB.
- On exhaustion: dev builds trap with a clear message; release builds grow in large steps and bump a counter. The JS side funnels every access through one `views()` accessor that compares `u8.buffer !== memory.buffer` (allocation-free) and rebuilds views after growth. Growth is therefore safe but visible, and the zero-GC test asserts it never happens in steady state.
- Consequence for `world.md`: the "world cap" must be validated in bytes against the platform ceiling; a single-player world on a phone has to fit ~256 MB of sim arena.
- Rejected: pure grow-on-demand (unbounded view invalidation, late failure on mobile); relying on `toResizableBuffer` (Safari 26.2+/Chrome 144+ only); shared memory (needs atomics → nightly).

### 3.9 One module, several roles; download budget (confidence: medium)

- **One `.wasm`, instantiated per role** with `engine_init(role, …)`. Compiled once, `Module` shared to workers. The client needs the sim rules anyway (prediction), so a separate client build would strip little while doubling build time and creating a second artifact to keep bit-identical. The server loads the same file. Build hash = hash of the `.wasm` bytes = the version-handshake token for `sync.md`.
- **Budget (proposal):** reference-game `.wasm` **≤ 1 MB brotli** (roughly ≤ 3 MB raw), engine JS ≤ 50 KB brotli, enforced by a size test; hard fail at 2 MB brotli. At 5–10 Mbit/s that is 1–2 s. Without wasm-bindgen, web-sys, wgpu, or heavy `fmt` use, a sim of this kind should land in the hundreds of KB (**unverified → S3**).
- Feature policy: default `wasm32-unknown-unknown` feature set (all supported by Safari 15+/Chrome); **never `relaxed-simd`** (nondeterministic by design); `simd128` only if profiling asks.

### 3.10 Server runtime and WASM-vs-native (confidence: medium-high)

- **The server runs the same `.wasm` under a JS runtime.** The sim host (tick loop, subscriptions, delta fan-out, persistence hooks) is the same TS whether the transport is a SAB ring (single-player worker) or a socket (server). Determinism is free: identical binary, identical float/libm behaviour, identical 32-bit `usize`, identical hashing.
- Rejected: a native Rust server. Faster and threaded, but it needs a Rust networking stack (tokio + tungstenite: a large tree, against 3.7), cross-compilation for deploys, and it opens native-vs-WASM divergence (64-bit `usize`, system `libm`, randomly seeded `HashMap` natively). Native stays for `cargo test`, where `testing.md`'s cross-target state-hash test is the canary.
- **Supported runtimes:** Node ≥ 22 (develop on 24 LTS) and Bun as tested targets; Deno adapter best-effort (not installed locally); **workerd not a target**: the 128 MB isolate limit includes WASM memory, there are no workers, and DO hosting is `sync.md`'s question. The portable core means it stays possible.
- API shape: `createServer({ wasm: WebAssembly.Module | BufferSource, transport, storage, clock })`. The host loads the WASM however its runtime prefers (1.7); workerd could only ever pass a `Module`.

### 3.11 Zero npm dependencies vs. a WebSocket server (confidence: medium)

- **Transport adapter interface first**: `{ onConnection(cb), send(conn, bytes), close(conn) }`-sized. It is needed regardless: for host-agnosticism, for the SAB single-player transport, and for `testing.md`'s in-process network conditioner.
- Shipped adapters: `./server/bun` and `./server/deno` (thin wrappers over built-ins); `./server/node` = a **minimal hand-rolled RFC 6455 server** over `node:http`'s `upgrade` event + `node:crypto`: binary frames only, client-mask enforcement, fragmentation reassembly, ping/pong, close, max-payload limit, **no extensions** (permessage-deflate is unnecessary with a compact wire format and costs memory and garbage). Roughly 300 lines, testable without mocks using Node's built-in WebSocket client and real browsers.
- Documented alternative: the *game* installs `ws` and injects it (`createNodeTransport({ wsServer })`); the engine still has zero dependencies.
- Rejected: targeting only runtimes with built-in servers (drops Node, the most common host); making `ws` an engine dependency (violates a fixed decision).

### 3.12 Publishing (Tyler's call)

Recommended default: treat "published" as a packaging discipline for now. Private; the crate bundled in the npm package; CI tests a `pnpm pack` tarball in a scratch Vite app so it behaves as if published. Name/scope/license are decided when there is a reason to publish.

## 4. Cross-domain interactions

- **client.md** — The boundary choice effectively decides the renderer language: Rust + wgpu/web-sys forces wasm-bindgen and per-call JS descriptor objects. Recommended shape: Rust writes instance records into engine-owned buffers in linear memory; TS issues WebGPU calls and uploads with `writeBuffer` directly from `memory.buffer`. Renderer-in-worker depends on WebGPU + OffscreenCanvas in an iOS Safari worker (unverified; Safari 26 ships WebGPU, OffscreenCanvas since 16.4). SAB input/camera blocks are what make a worker renderer tolerable for input latency and overlay anchoring (≤ 1 frame stale). The "low-GC way to observe state" for game UI = a published state block read through preallocated views.
- **sync.md** — Single-player transport = SAB ring carrying the same bytes as the socket. The `WebSocket` belongs in a net worker so its garbage never reaches the frame loop. Prediction lives in the client-role instance; single-player has two instances. Version handshake token = hash of the `.wasm`. No permessage-deflate. workerd's 128 MB cap bounds any Durable Objects hosting idea. Persistence needs a storage adapter just like transport.
- **simulation.md** — Same binary everywhere is the determinism strategy; native builds are for tests only and differ in `usize` width, `libm`, and `HashMap` seeding (std `HashMap` is unseeded on wasm32 but seeded natively: ban iteration-order dependence or mandate a fixed hasher). Ban threads and `relaxed-simd`; NaN payloads are the remaining WASM nondeterminism. Time and randomness are never imported; they are arguments.
- **world.md** — World cap must be expressed/validated in bytes against the arena (≤ ~256 MB for a phone-hosted single-player sim). Worldgen runs in a pool of tiny instances in single-player and on the server in multiplayer; results move as bytes through SAB slabs. If world state lives in offset-addressed arenas, a snapshot is close to a `memcpy`, which also enables dev reload-with-state.
- **testing.md** — The zero-GC assertion should be heap-delta + GC-event based, per isolate (3.4). New cheap tests: imports check, ABI version check, size budget, packed-tarball consumer build. The WASM sim under Node gives fast headless tests with the production binary. The 1-minute budget has to assume a warm cargo cache. Cross-origin isolation also unlocks finer `performance.now()` for perf tests. Playwright must serve with COOP/COEP.
- **reference-game.md** — Its Vite config and `Cargo.toml` are the living documentation of 3.6. All its assets must be same-origin.

## 5. Needs a spike

**S1 — Vite consumer of a worker-shipping library + game-built WASM.** A scratch Vite 8.3 app that installs a **`pnpm pack` tarball** (not a workspace link) of a stub engine package, plus a cargo-built `.wasm`. Must prove, in `vite dev`, and in `vite build` + `vite preview`:
1. Pattern A (library-internal `new Worker(new URL(...))`) works with and without `optimizeDeps.exclude`.
2. Pattern B (game-owned two-line worker importing `<engine>/worker`) works.
3. `worker.format: 'es'` vs. the default `iife`: which is required.
4. The `.wasm` via `?url` (and via a plugin virtual module) is emitted hashed, not inlined, and served as `application/wasm` so `compileStreaming` works.
5. A `WebAssembly.Module` compiled on main can be `postMessage`d to workers and instantiated in Chrome, Firefox, and WebKit.
6. It works under pnpm's symlinked `node_modules`, and the same config works when the package is a workspace link.
Output: the minimal required `vite.config.ts`, and A-vs-B.

**S2 — SharedArrayBuffer under cross-origin isolation, dev and production.** Must prove:
1. `crossOriginIsolated === true` on main and in workers with `server.headers`/`preview.headers`, and on one real static host via `_headers` (Netlify or Cloudflare Pages), including the worker-script-needs-COEP detail.
2. An SPSC ring with fixed slots and preallocated per-slot views moves ~10 KB/frame main↔worker with **zero JS heap delta** over 600 frames in Chromium (CDP) and no obvious allocation in WebKit.
3. The same traffic over `postMessage` + a transferable pool: bytes allocated per frame and GC count. This number justifies (or not) requiring isolation.
4. Behaviour in Safari with `require-corp`; a cross-origin image without CORP fails as expected and with `crossorigin` + CORS succeeds.
5. `queue.writeBuffer` accepts a range of `WebAssembly.Memory.buffer` directly without an intermediate view allocation (can be folded into a client spike).

**S3 — cargo-only pipeline and ABI.** A stub engine crate + game crate with `export_game!`. Must prove:
1. The cdylib exports exactly the expected symbols and imports only `engine.*`.
2. Raw / wasm-opt / brotli sizes for a trivial sim (calibrates 3.9).
3. Measured dev loop: touch a game `.rs` file → `.wasm` rebuilt → browser reloaded, in seconds, cold and incremental.
4. The identical `.wasm` instantiates in the browser, Node 22, and Bun 1.3 through one loader and produces the same state hash after N ticks.
5. An engine-installed global allocator reserving a fixed arena at init works on stable Rust.

**S4 — mobile memory ceilings (needs Tyler's devices).** On a real iPhone and a mid-range Android: the largest single reservation that instantiates (64/128/256/512/1024 MB); whether two instances (256 MB sim + 64 MB client) coexist with a WebGPU context; whether reserved-but-untouched pages count toward the tab's kill threshold; what the failure looks like (RangeError vs. tab reload).

**S5 — minimal Node WebSocket server (low priority; can wait for Phase 3).** ~300 lines over `node:http`; must interoperate with Chrome, Safari, and Node's built-in client for binary frames up to 1 MB, fragmentation, ping/pong, close codes, and a rejected oversize frame.

## 6. Questions for Tyler

1. **Publishing.** Public npm package (name, scope, license, crates.io) or packaging discipline in a private repo? *Default: private discipline; Rust crate bundled inside the npm package; tarball-install test in CI.*
2. **Is mandatory cross-origin isolation acceptable for every game?** It rules out GitHub Pages (without a service-worker hack), complicates embedding in portals/iframes, forbids CORP-less third-party assets and OAuth popups. *Default: yes, required; no postMessage fallback.*
3. **Mobile download budget.** *Default: game `.wasm` ≤ 1 MB brotli (CI warns), hard fail at 2 MB; engine JS ≤ 50 KB brotli.*
4. **Mobile memory floor.** Which device class defines "works on mobile"? *Default: iPhone 12-class / 4 GB Android; every instance ≤ 256 MB; a phone-hosted single-player world must fit that.*
5. **Server runtimes to support.** *Default: Node ≥ 22 and Bun tested; Deno best-effort; workerd not targeted.*
6. **Node WebSocket server: hand-roll ~300 lines of protocol code inside the engine, or have the game install and inject `ws`?** *Default: hand-roll the minimal binary-only server; keep `ws` injection as a documented alternative.*
7. **Does an `<engine>/vite` plugin entrypoint fit "zero dependencies"?** It imports only Node built-ins; Vite is an optional, types-only peer. *Default: yes.*
8. **Stable Rust only** (which forecloses WASM threads)? *Default: yes.*

## Spike results

- **S1 + S3 (build pipeline):** works. Vite 8.3 app, tarball-installed engine, plain `cargo build`, no wasm-bindgen; 192/192 headless runs across Chromium, Firefox, WebKit in dev and build. See `spikes/vite-lib-worker-wasm/RESULT.md`.
- **S2:** works. Cross-origin isolation and SharedArrayBuffer in all three engines; a SAB ring adds no main-thread garbage, `postMessage` does. See `spikes/cross-origin-sab/RESULT.md`.
- **S3 (hash equality):** covered by `spikes/determinism-hash/RESULT.md`.
- **S4 (real-phone memory ceilings)** and **S5 (hand-rolled Node WebSocket server):** not run. S4 cannot be automated and is a Phase 3 manual device check; S5 is moot because the game injects `ws` (ADR 0009).
