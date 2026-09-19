# Research: testing

Phase 1 research for every open question in [`docs/spec/testing.md`](../spec/testing.md). Evidence and recommendations, not decisions. All URLs accessed 2026-09-19. "Probe" means a throwaway script I ran on Tyler's machine (macOS 26 / Apple Silicon, Chrome 153.0.8010.52, Node 22.18, Playwright core 1.63.0-alpha bundled with `@playwright/cli` 0.1.19); probe code lived in the session scratchpad and is not in the repo. The probes are feasibility checks, not the spike in section 5.

## 1. Findings

### 1.1 LLM-oriented browser automation

| Tool | State (Sept 2026) | Context cost | Fit for us |
|---|---|---|---|
| **Scripted Playwright tests run from the shell** | Playwright 1.63; bundles Chromium 153, Firefox 155, WebKit 26.6. `browserContext.newCDPSession(page)` and `browser.newBrowserCDPSession()` give raw CDP (probe: both work; `Tracing.start` works on the browser session). | Near zero on pass: one command, one summary line. | The primary loop. |
| **Playwright CLI (`@playwright/cli`, `playwright-cli`)** | Microsoft's CLI built for coding agents; installs a Claude Code skill (`playwright-cli install --skills`). Commands include `open`, `snapshot`, `screenshot`, `eval`, `run-code`, `console`, `requests`, `tracing-start`, CDP attach; named sessions persist between shell calls; snapshots and artifacts go to disk instead of the context. Already installed on Tyler's machine (0.1.19) and already registered as a skill in this Claude Code environment. Playwright 1.62+ also bundles it (`npx playwright mcp`/cli). | Low. Microsoft's README: CLI "avoid[s] loading large tool schemas and verbose accessibility trees into the model context". A third-party benchmark reports about 27k tokens vs 114k for the same task over MCP (indicative only). | Ad-hoc exploration and debugging when a scripted test is not enough (look at the running game, take a screenshot, poke `eval`). |
| **Playwright MCP (`@playwright/mcp`)** | Maintained; capability flags (`--caps vision,pdf,devtools,testing,...`); `browser_run_code_unsafe`. Its own README now steers coding agents to the CLI and keeps MCP for "exploratory automation, self-healing tests, or long-running autonomous workflows". | High (tool schemas + accessibility snapshots in context on every step). | Rejected for this repo. |
| **Chrome DevTools MCP** | 1.0 stable on 2026-05-19, 1.1.x since. About 58 tools: `performance_start_trace`/`stop_trace`/`analyze_insight` (trace can be saved to `filePath`), `evaluate_script`, 13 heap-snapshot tools (behind `--memoryDebugging`), `--slim` mode, `--headless`, and a non-MCP CLI. | High by default (many schemas); `--slim` reduces it. | Not in the default config. Useful on demand for a perf or leak investigation: it summarises traces and heap snapshots that are otherwise too large for a context window. |
| **Vitest browser mode** | Stable since Vitest 4.0 (Oct 2025); docs currently show v5.0.1. Providers are separate packages: `@vitest/browser-playwright` (recommended for CI, parallel), `@vitest/browser-webdriverio`, `@vitest/browser-preview` (dev only). Tests execute inside the page (an iframe under an orchestrator page). Server-side "commands" get the Playwright `page`/`context`; `cdp()` from `vitest/browser` works only with the Playwright provider on Chromium and needs `api.allowWrite` + `api.allowExec`. | Low (shell command). | Rejected for the browser suite: the test runner, its RPC and its assertion library live in the same V8 isolate as the code under test, which pollutes exactly what we need to measure (allocations and GC on the page isolate), and browser-level tracing and launch flags are one step further away than in plain Playwright. It is a good fit for DOM component tests, which the engine does not have. |
| **Raw CDP** | Reached through Playwright's CDP sessions, no extra dependency. | n/a | The mechanism behind the GC test (1.3). |

Conclusion: the tightest loop with the least context is a **single shell command that runs scripted tests and is silent on success**. Interactive browser tools are for diagnosis; of those, the Playwright CLI is the cheapest and is already set up.

Sources: https://github.com/microsoft/playwright-cli · https://github.com/microsoft/playwright-mcp · https://playwright.dev/docs/release-notes · https://github.com/ChromeDevTools/chrome-devtools-mcp and `/blob/main/docs/tool-reference.md` · https://developer.chrome.com/blog/chrome-devtools-mcp · https://vitest.dev/guide/browser/ · https://vitest.dev/guide/browser/commands · https://www.infoq.com/news/2025/12/vitest-4-browser-mode · https://bug0.com/blog/playwright-cli-vs-playwright-mcp-ai-browser-testing-2026 (token benchmark, third party)

### 1.2 Headless WebGPU

**macOS (probe results, all headless, page served from `http://localhost` with COOP/COEP):**

| Launch | `requestAdapter()` |
|---|---|
| System Chrome 153, `--headless=new --enable-unsafe-webgpu` (raw CDP) | `vendor: apple, architecture: metal-3`, not fallback. Real Metal device. `requestAnimationFrame` runs at 60 Hz (300 frames = 4.97 s, every run). |
| Playwright `chromium.launch({ channel: 'chromium' })` (new headless, full Chromium build), **no flags** | Real Metal device. |
| Playwright `chromium.launch()` default (= `chromium_headless_shell`, the old headless) | `navigator.gpu` exists, adapter is **`null`**. |
| Playwright default headless shell + `--enable-unsafe-webgpu` | **SwiftShader** (`vendor: google, architecture: swiftshader, isFallbackAdapter: true`), device OK. A software adapter on macOS for free. |
| Playwright `channel: 'chrome'` + `--enable-unsafe-webgpu` | Real Metal device. |
| Playwright **WebKit 26.5**, headless | Adapter `vendor: apple`, device OK. WebGPU works in Playwright's macOS WebKit build, headless. |
| Playwright **Firefox 155**, headless | `navigator.gpu` exists, adapter **`null`** (also with `dom.webgpu.enabled`). Headed: adapter and device OK. |

Launch cost is negligible: about 170 ms to launch new-headless Chromium, about 100–190 ms per context + page.

**Linux / CI (from sources, not verified by me):**
- Chrome ships WebGPU on Linux by default only for Intel Gen12+ (Chrome 144) and NVIDIA ≥ 535.183.01 on Wayland (Chrome 147); everything else needs `--enable-unsafe-webgpu` (gpuweb Implementation Status).
- Chrome's own recipe for headless Linux with a real GPU: `--no-sandbox --headless=new --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface --enable-unsafe-webgpu`, plus working Vulkan drivers (Chrome for Developers, Jan 2024).
- GPU-less runners (GitHub `ubuntu-latest`): software path is SwiftShader via Vulkan: `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --disable-vulkan-surface`, with `libvulkan1` and `mesa-vulkan-drivers` installed; "No real GPU or `/dev/dri` is required" (agent-browser docs, which ship this as a preset). Same source: on Linux and Windows a headless **page screenshot of a WebGPU canvas is black** (presentation never reaches the headless compositor); headed under Xvfb is the workaround. Readback is unaffected. Lavapipe inside containers is reported fragile.
- GitHub GPU runners (`gpu-linux-4`, NVIDIA T4) exist at roughly 3–4x the per-minute price and need headed + Xvfb + `--use-angle=vulkan --ignore-gpu-blocklist` (Dave Snider, Feb 2026).
- GitHub macOS runners expose an "Apple Paravirtual device" through Metal and it executes compute work (third-party report, Sept 2026); WebGPU in Chrome on those runners is unverified. macOS minutes are 10x Linux.
- **Dawn node bindings**: npm package `webgpu` (repo `dawn-gpu/node-webgpu`) ships prebuilt `dawn.node`; no canvas/web-platform integration. It is a way to run WebGPU readback tests with no browser, but it is a different Dawn build from the one in the shipped browser and says nothing about canvas presentation or the JS-side allocation behaviour of the real bindings. wgpu runs the WebGPU CTS under Deno the same way.
- Firefox: WebGPU shipped on Windows (141) and Apple Silicon macOS (145/147); Linux and Android are Nightly-only, "expected 2026". Safari: on by default in Safari 26 on all Apple platforms.

Sources: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status · https://developer.chrome.com/blog/supercharge-web-ai-testing · https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips · https://agent-browser.dev/webgpu · https://davesnider.com/gputests · https://github.com/ahrefs/ocannl/issues/942 · https://github.com/dawn-gpu/node-webgpu · https://dawn.googlesource.com/dawn/+/HEAD/src/dawn/node/README.md · https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/swiftshader.md

### 1.3 Detecting GC and allocation

Probe: a page that clears a WebGPU canvas once per `requestAnimationFrame`, plus a dedicated worker on a 16 ms timer; an optional knob allocates k small objects per frame on the main thread or in the worker. Driven over raw CDP with `Target.setAutoAttach` (flatten) to get a session on the worker. Per trial: `HeapProfiler.collectGarbage` on both isolates, `Tracing.start` on the browser session, `HeapProfiler.startSampling` on both isolates, `performance.mark` around 300 frames, stop, analyse.

**CDP tracing works and attributes GC to threads.** With categories `v8`, `devtools.timeline`, `blink.user_timing` (I also enabled `v8.gc`, `disabled-by-default-v8.gc`, `disabled-by-default-devtools.timeline`; the top-level events carry `cat=devtools.timeline,v8`, so the first three are enough):
- Events `MinorGC` and `MajorGC` (plus `V8.GCScavenger`, `V8.GCCompactor` and about 70 phase events) carry `pid`/`tid`; `thread_name` metadata maps `tid` to `CrRendererMain` or `DedicatedWorker thread`. Main-thread and worker GCs are cleanly separated.
- `performance.mark()` shows up in the same trace (`blink.user_timing`), so GCs can be bucketed as before / inside / after the measured window on one clock.

| Trial (300 frames) | GC events inside window | Sampled allocation, main | Sampled allocation, worker |
|---|---|---|---|
| Clean (WebGPU clear only), first run in the page | 0 | 51–61 KB | ~2 KB |
| Clean, second run (warm) | 0 | 27–29 KB (≈ **90 B/frame**) | ~1 KB |
| Main allocates 1 object graph/frame (~140 B) | **0** | 69 KB | 0 |
| Main allocates 10 objects/frame (~0.7 KB) | **0** | 219–260 KB | 0 |
| Main allocates 2000 objects/frame | 29 `MinorGC` on `CrRendererMain`, 0 on worker | 39 MB | ~2 KB |
| Worker allocates 2000 objects/16 ms | 30 `MinorGC` on `DedicatedWorker thread`, 0 on main | 42 KB | 40 MB |

Three consequences:

1. **A GC-event assertion alone is a weak test.** Code that leaks 0.7 KB per frame produced zero GCs in 300 frames, because the young generation is at least 1 MB. It only fails once the window's garbage exceeds the semi-space. `--min-semi-space-size`/`--max-semi-space-size` are in whole MB, so pinning them to 1 still leaves a threshold of 1 MB per window (about 3.4 KB/frame at 300 frames).
2. **The sampling heap profiler is the sensitive instrument.** `HeapProfiler.startSampling({ samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })` reports bytes allocated by call frame, per isolate, including objects that have already died. With `--js-flags=--sampling-heap-profiler-suppress-randomness` ("Use constant sample intervals to eliminate test flakiness") and a 128-byte interval, totals reproduced **across separate Chrome processes to within 0.05 %** (72 484 vs 72 476; 37 124 vs 37 144; 260 240 vs 260 232; 73 584 vs 73 576). One extra small object per frame is unmistakable (69 KB vs 27 KB). `Runtime.getHeapUsage` deltas agree with it (71 KB, 39 KB, 262 KB, 78 KB) and make a cheap cross-check when no GC ran.
3. **A WebGPU frame cannot allocate zero.** `getCurrentTexture()`, `createView()`, `createCommandEncoder()`, `beginRenderPass()`, `finish()` each return a fresh JS wrapper. The probe reused every descriptor object and still measured about 90 B/frame attributed to the frame function. "Zero allocation" is therefore only achievable on isolates that do not call WebGPU; on the rendering isolate the honest target is a small fixed floor. At 90 B/frame and 60 fps a 1 MB semi-space fills in about 3 minutes and a 16 MB young generation (V8's long-standing default maximum; not re-verified for Chrome 153) in about 50 minutes; a scavenge of an almost entirely dead nursery is sub-millisecond. This feeds the "what zero GC means" question in `runtime-and-packaging.md`.

Other mechanisms considered:
- **`--js-flags=--trace-gc`**: not captured. Nothing reached the launcher's stdout/stderr pipes from headless Chrome on macOS, with or without `--no-sandbox` and `--enable-logging=stderr`. Even if captured it is unstructured text with no thread names. Rejected in favour of tracing.
- **`--js-flags=--expose-gc`** / **`HeapProfiler.collectGarbage`**: both give a clean baseline; the CDP method needs no flag and works per isolate (worker sessions included). Note that `HeapProfiler.stopSampling` with the `includeObjectsCollectedBy*GC` options is followed by a `MajorGC` on each profiled isolate; it lands after the window, which is why marks are needed.
- **`performance.measureUserAgentSpecificMemory()`**: needs cross-origin isolation, resolves only after a future GC, returns coarse per-realm sizes. Useless for a frame window.
- **`PerformanceObserver`**: there is no GC entry type on the web platform (Node has `gc` entries, browsers do not). Long-animation-frame entries could only show a symptom.
- **`FinalizationRegistry` canaries**: fire at an unspecified time after a GC; cannot prove absence of GC inside a window and cannot distinguish isolates. Rejected.
- **V8 flags worth knowing** (names confirmed against Node 22's V8 12.4; Chrome 153 has V8 15.x, so re-check in the spike): `--single-threaded-gc`, `--predictable`, `--gc-interval`, `--stress-scavenge`, `--semi-space-growth-factor`, `--min/max-semi-space-size`, `--sampling-heap-profiler-suppress-randomness`.

Sources: https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/ · https://chromedevtools.github.io/devtools-protocol/tot/Tracing/ · https://v8.dev/docs/trace · https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory · https://web.dev/articles/monitor-total-page-memory-usage · https://nearform.com/digital-community/optimising-node-js-applications-the-impact-of-max-semi-space-size-on-garbage-collection-efficiency/ · local `node --v8-options`

### 1.4 Rust-side runners and build caching

- **cargo-nextest** (0.9.14x, Aug 2026): process-per-test parallelism, per-test timeouts, slow-test reporting, filter expressions and profiles with a `default-filter` (a clean way to define fast vs slow), JUnit output. Honours `target.<triple>.runner`, and calls the runner for both listing and running, so a runner must keep stdout clean. wgpu uses nextest for its whole suite. Not installed locally yet.
- **wasm-bindgen-test**: still configured as `runner = 'wasm-bindgen-test-runner'` with the CLI version pinned to the crate version; Node by default, headless browsers through WebDriver (chromedriver/geckodriver/safaridriver, a second browser-automation stack next to Playwright). Only relevant if the JS↔WASM boundary decision picks wasm-bindgen.
- **WASM under a non-browser runtime**: `wasm32-unknown-unknown` has no test harness of its own. Options: build `wasm32-wasip1` tests and set `wasmtime` as the runner (nextest-compatible), or skip Rust-level WASM unit tests and instead load the real game+engine module in Node through the engine's server entrypoint. The second tests the artefact that ships and the real boundary code. Neither wasmtime nor sccache nor nextest is installed locally today.
- **sccache**: cannot cache incrementally compiled crates (it bypasses them), so it helps dependencies and cold builds only, and workspace crates rely on cargo's incremental cache. Its real value here: Claude Code sub-agents work in **git worktrees, each with a cold `target/`**; sccache (or a shared `CARGO_TARGET_DIR`, at the cost of lock contention) stops every worktree recompiling all dependencies. On CI, `Swatinem/rust-cache` caches `~/.cargo` and `target/`.
- Incremental `wasm32` rebuilds of a small workspace are reported at 1–3 s when the target dir is not being invalidated by a second tool using different flags (rust-analyzer without the wasm target configured is the classic cause of 48 s → 2.5 s). No code exists, so our own numbers must be measured in Phase 3.

Sources: https://nexte.st/docs/features/target-runners/ · https://crates.io/crates/cargo-nextest · https://blog.jetbrains.com/rust/2026/05/01/faster-rust-tests-with-cargo-nextest/ · https://wasm-bindgen.github.io/wasm-bindgen/wasm-bindgen-test/usage.html · https://github.com/mozilla/sccache/blob/main/docs/Rust.md · https://github.com/swatinem/rust-cache · https://github.com/DioxusLabs/dioxus/discussions/947

## 2. Prior art and what to take from it

**WebGPU CTS (gpuweb/cts).** TypeScript; tests render or compute into textures/buffers and **read back**, comparing against CPU-computed expectations with explicit per-format tolerances; a small set of reftests compares canvas output against a reference page. It runs under several hosts through an adapter layer (browser, WPT, Node with Dawn, Deno with wgpu). Take: readback with numeric tolerance is the primary technique; page screenshots are the exception. https://github.com/gpuweb/cts · https://gpuweb.github.io/cts/

**wgpu.** nextest; a `gpu_test` macro runs each test on every adapter present; CI uses software adapters (WARP on Windows, lavapipe/llvmpipe on Linux, with `LVP_POISON_MEMORY` to catch uninitialised reads); example renders are compared with **nv-flip** (perceptual diff) within a tolerance; an expectations system marks known driver failures per adapter; they observed golden images differing between WARP versions. Take: tolerance is unavoidable across adapters; keep an explicit per-adapter expectation mechanism rather than loosening thresholds globally. https://github.com/gfx-rs/wgpu/blob/trunk/docs/testing.md · https://github.com/gfx-rs/wgpu/issues/2760

**Factorio.** Three layers (FFF-60): unit tests without graphics or prototypes; integration tests that build a small map, place entities, run N updates and assert, each followed by a **CRC of the map compared with a pre-saved value**, so any determinism break in covered code fails the normal suite; and black-box multi-instance multiplayer tests. **Heavy mode** (mechanics in FFF-315; FFF-63 gives the rationale: most desyncs come from "hidden state, that is not properly initialised or saved") saves and reloads every tick and compares CRCs before/after, which reliably finds hidden state that is not serialised; it is so slow (400–600 s on 18-core machines in 2019) that it runs on dedicated servers after each commit. Take: (a) golden state hash after every scenario test, (b) a save→load→hash-equality check as a slow-suite "heavy mode", (c) accept a slow tier run outside the edit loop. https://factorio.com/blog/post/fff-60 · https://www.factorio.com/blog/post/fff-63 · https://factorio.com/blog/post/fff-188 · https://www.factorio.com/blog/post/fff-315 · https://wiki.factorio.com/Desynchronization

**Network conditioning.**
- *tokio turmoil* (and deterministic simulation testing generally: FoundationDB, TigerBeetle, S2): all hosts run in one thread on a simulated network and clock; latency, partitions, holds and drops are driven by a **seeded RNG**, so one seed reproduces a failure. Take the pattern: virtual time advances to the next scheduled event; all nondeterminism flows from one seed; failures print the seed. https://github.com/tokio-rs/turmoil · https://s2.dev/blog/dst
- *Toxiproxy*: an external TCP proxy (Go binary) with latency ± jitter, bandwidth, timeouts, resets. Real time only, not seedable, another process to manage. Reject for the suite; it is a manual chaos tool. https://github.com/shopify/toxiproxy
- Relevant transport fact: WebSocket is reliable and ordered, so packet loss never appears as a missing or reordered message. It appears as a **head-of-line stall** (everything behind the lost segment is delayed by a retransmission timeout) or as a disconnect. A conditioner for this engine must model those two, not message drops.

## 3. Recommendations per open question

### 3.1 Tooling — confidence: high

- **One command, `pnpm test`**, runs all fast suites in parallel and prints one line per suite plus failures only. Failures write artefacts (trace JSON, actual/expected/diff PNG, seed, action log) to a gitignored directory and print the paths; Claude opens them with Read. `pnpm test:slow` runs the rest. Every suite is filterable by name so an agent can run one test in a second or two.
- Rust: **cargo-nextest** (`cargo test` still works; nextest adds timeouts, slow-test reports and profile filters).
- TypeScript and Node-hosted tests: **Vitest in Node mode** (dev dependency only; shares Vite config with the reference game). Alternative rejected: `node:test` with Node 22's type stripping, which has zero dependencies but weaker filtering, reporting and project-level parallelism. Low cost to revisit.
- Browser: **`@playwright/test`**, test bodies in Node driving the page, `channel: 'chromium'` (new headless; Playwright pins the browser build, so the engine version only changes when we bump Playwright). Raw CDP through `newCDPSession`/`newBrowserCDPSession` for GC, allocation and tracing. Alternative rejected: Vitest browser mode (1.1).
- Agent-interactive: **Playwright CLI skill** for looking at the running game; **Chrome DevTools MCP** added only during a perf or memory investigation. Alternative rejected: Playwright MCP by default (context cost; Microsoft itself recommends the CLI for coding agents).
- No wasm-bindgen-test unless the boundary decision adopts wasm-bindgen and a WASM-only Rust unit test is actually needed.

### 3.2 Headless WebGPU — confidence: high on macOS, medium on Linux CI

- Local (the loop that matters): Playwright Chromium, `channel: 'chromium'`, headless, real Metal device; pass `--enable-unsafe-webgpu` anyway so the same config works on Linux. Every GPU test first asserts `adapter.info` and records it, and fails loudly if the adapter is null rather than skipping.
- CI: GitHub `ubuntu-latest` with the **SwiftShader** flag set from 1.2. Software adapter is acceptable because nothing in the fast suite asserts GPU speed, and the GC/allocation assertions concern the JS heap. Needs spike B before we rely on it. Alternative rejected: GPU runners (3–4x cost, headed + Xvfb + driver setup) and macOS runners (10x cost, unverified) until there is a reason.
- A second project in the same Playwright config runs the render tests on the SwiftShader adapter locally (default headless shell + `--enable-unsafe-webgpu`) only if spike B shows CI and local SwiftShader agree; otherwise skip it.
- Other browsers: see 3.8. Dawn node bindings: rejected for the main path (not the shipped stack), keep as a fallback if Linux CI WebGPU proves unworkable.

### 3.3 Detecting GC, 3.7 which isolates — confidence: medium-high (pending spike A)

The assertion has two parts, both evaluated over the same window, on **every isolate the engine owns**: the page main thread and each dedicated worker (sim, render if OffscreenCanvas is used, chunk generation, network decode).

Procedure (one Playwright test, Chromium only):
1. Launch with `--js-flags=--sampling-heap-profiler-suppress-randomness` (plus `--single-threaded-gc` if the spike shows it reduces noise). Open the test page; `Target.setAutoAttach({ flatten: true })` to get a CDP session per worker.
2. Load the scenario and run **W warm-up frames** (start at 120) with the same scripted inputs, so JIT tiers, inline caches and lazily created pipelines settle. Warm-up is exempt, matching "after load" in the zero-GC definition.
3. `HeapProfiler.collectGarbage` on every isolate. `Tracing.start` on the browser session with `v8`, `devtools.timeline`, `blink.user_timing`. `HeapProfiler.startSampling` on every isolate (interval 128–1024 B, both `includeObjectsCollectedBy*GC` flags).
4. `performance.mark('window-start')`, step **N frames** (start at 600, with the matching sim ticks and a scripted input stream that pans, zooms and issues game actions, so chunk subscribe/unsubscribe and delta decode are exercised), `performance.mark('window-end')`. Stop sampling, end tracing.
5. **Assertion A (GC events):** zero `MinorGC` and zero `MajorGC` trace events with `ts` inside the window on any thread of the renderer process whose `thread_name` is `CrRendererMain` or `DedicatedWorker thread`. **Scavenges count**: inside a window this short a scavenge is the only GC that would ever fire, and in a correctly written worker there is nothing to scavenge.
6. **Assertion B (allocation budget, the one that catches real regressions):** sampled bytes per frame per isolate ≤ budget. Workers that only drive WASM: budget ≈ 0 (start at 16 B/frame to absorb timer/message wrappers, tighten after the spike). The isolate that calls WebGPU: a fixed floor for the API's wrapper objects (probe: about 90 B/frame for one pass; start at 256 B/frame) and, from the profile's call-frame attribution, **no bytes attributed to engine hot-path functions other than the allow-listed WebGPU calls**. Budgets live in one checked-in file; raising one is a reviewed change.
7. **Negative controls stay in the suite permanently:** the same scenario with a test-only hook that allocates one small object per frame must fail B on the right isolate; a variant allocating about 2000 objects per frame must fail A. If a Chrome update silently breaks the instrument, these fail.

DOM/UI is exempt by construction: the scenario page mounts no game UI. A separate, looser test can cover the reference game's UI later.

Alternatives rejected: GC events alone (blind below about 1 MB per window, 1.3); shrinking semi-space to force scavenges (MB granularity, and it changes the thing being measured); `--trace-gc` (could not be captured; unstructured); `measureUserAgentSpecificMemory`, `FinalizationRegistry`, heap-size polling (cannot bound a window or attribute to an isolate).

### 3.4 Verifying rendering — confidence: medium

Three layers, cheapest first:
1. **No GPU (most tests):** the renderer's CPU-side output (visible-chunk set, instance/vertex buffer bytes, draw list) is a pure function of view state and camera. Hash or snapshot it in native Rust or Node tests. Validate every WGSL module natively (naga as a dev-dependency, if the crate dependency policy allows) so shader typos fail without a browser.
2. **GPU readback (fast suite, a handful of scenes):** the engine renders to an offscreen `rgba8unorm` target of fixed size (e.g. 256×256) instead of the canvas, `copyTextureToBuffer`, `mapAsync`, compare in Node. Primary assertions are **semantic pixel probes** ("centre of tile (3,4) is the colour of tile type X", "nothing drawn outside the viewport"), which are robust across adapters. Secondary: golden PNG with per-channel tolerance ≤ 2/255 and ≤ 0.1 % differing pixels. Test scenes are built to be reproducible: nearest sampling, integer-aligned quads, no MSAA, opaque flat colours. Also assert `getCompilationInfo()` is clean and no `uncapturederror`/device-lost fired during any browser test.
3. **One canvas-presentation smoke test:** the canvas context is configured and a frame reaches it without validation errors. Page screenshots are not used for pixel assertions (compositor, colour management and DPR get in the way, and headless Linux/Windows captures WebGPU canvases as black).

If SwiftShader and Metal disagree beyond tolerance on a scene, add a per-adapter-class golden (`metal`, `swiftshader`), following wgpu's expectations approach, rather than widening tolerance. Alternatives rejected: exact hash of GPU output (breaks across adapters and driver updates; fine for layer 1 only); perceptual diff libraries (unneeded for flat tile scenes; add nv-flip-style comparison only if lighting or blending arrives).

### 3.5 Netcode tests without mocks — confidence: medium

- **Everything real, in one Node process:** the real server entrypoint with the real game WASM, and K real headless clients (the engine's client sync layer without renderer or DOM, which therefore must run in Node), each with its own WASM instance.
- **Transport is an interface the engine already needs** (host-agnostic server; single-player runs the identical protocol over worker messages). Two real implementations are exercised: an in-memory pair (the same thing single-player uses, so not a mock) and real WebSockets on `127.0.0.1:0`.
- **Conditioner = a wrapper around any transport, with a shared ledger.** The sending side stamps each message with `(link, seq, deliverAt)` where `deliverAt = now + latency + jitter(rng)` and, per link, stall episodes (`p_stall` per message → everything on that link is held for a drawn RTO, order preserved), optional bandwidth cap, and scripted disconnect/reconnect. The receiving side holds arrivals until the virtual clock reaches `deliverAt`. Because both ends live in one process, the test scheduler knows exactly which messages are physically in flight: `advanceTo(t)` first awaits physical arrival of every message with `deliverAt ≤ t`, then releases them in the total order `(deliverAt, link, seq)`. Result: bit-reproducible runs from `(seed, scenario)` even over real sockets, and thousands of ticks per second over the in-memory transport. RNG is one seeded PRNG per link; failures print the seed and dump the action log.
- **Injectable clock everywhere:** server tick scheduling, client interpolation and prediction timers, reconnect backoff, heartbeat/timeouts. No `Date.now`, `performance.now` or `setTimeout` inside the engine outside a single `Clock`/`Scheduler` adapter.
- Assertions: after the scenario and a quiescence period, each client's view hash equals the server's hash of that client's subscribed region; bounded misprediction corrections; bytes per client per tick within budget (3.9); reconnect and late-join converge; version-mismatch handshake rejects.
- Fast suite: all scenarios on the in-memory transport, a small subset repeated over real WebSockets. One Playwright test with two pages against a real server is the end-to-end smoke (slow suite if it costs more than about 3 s).
- Alternatives rejected: mocked sockets (forbidden by requirements, and they hide framing/backpressure bugs); Toxiproxy or OS-level shaping (`dnctl`/`tc`) (real time, non-deterministic, external process, needs privileges).

### 3.6 The budget — confidence: medium (numbers need real code)

- **The 60 s is test execution on Tyler's Mac with warm build caches, including the no-op/incremental build check that precedes it.** Compiling after an edit is tracked separately: target **≤ 30 s from a one-line Rust edit to tests starting** (native test binaries + the wasm32 module), so edit→green stays under about 90 s. Cold builds (fresh clone, new worktree, CI without cache) are outside the budget but are what sccache (shared across agent worktrees) and `Swatinem/rust-cache` (CI) are for.
- Suites and budgets (they sum to 53 s even if run serially; run in parallel the wall clock should be about the browser suite, 25–30 s):

| Suite | Runner | What | Budget |
|---|---|---|---|
| Rust native | nextest | Unit tests, scenario tests with golden state hashes, replay of recorded action logs, renderer CPU-side output, WGSL validation | 10 s |
| TS unit | Vitest (Node) | Pure TS: client glue, exports map, config | 3 s |
| WASM under Node | Vitest (Node) | The built game+engine module through the server entrypoint: same replays → same golden hashes as native; boundary/ABI tests; `memory.grow` view invalidation | 5 s |
| Netcode | Vitest (Node) | 3.5 | 10 s |
| Browser | Playwright Test, Chromium new headless, real GPU | GC/allocation test + negative controls, GPU readback scenes, canvas smoke, worker/SAB/cross-origin-isolation wiring, sim hash in Chromium (and WebKit/Firefox, 3.8), packaging smoke of the Vite-built reference game | 25 s |

- The browser suite cannot use real `requestAnimationFrame` pacing: 600 frames at 60 Hz is 10 s per test. Frames are stepped by the test as fast as the machine allows (needs the engine API in section 4; mechanics are part of spike A).
- **Demotion rule.** A test belongs in the fast suite only if its p95 duration is ≤ 0.5 s (Rust/Node) or ≤ 3 s (browser). When a suite exceeds its budget, demote in this order: multi-engine repeats of a test that already runs on one engine, real-socket repeats of in-memory netcode tests, large-world/soak/long-replay variants, heavy mode, anything measuring wall-clock time. Never demote the only test covering a feature; shrink its scenario instead. Mechanics: a `slow` tag (nextest profile `default-filter`, Vitest/Playwright `@slow` grep). The runner script prints per-suite durations every run, warns above budget, and fails above 1.5x budget so drift is noticed immediately. CI runs fast and slow.
- Alternative rejected: counting compile time inside the 60 s (a cold dependency build alone exceeds it, which would make the budget meaningless).

### 3.8 Cross-browser determinism — confidence: medium-high

- **Golden hashes are produced by the native run and checked in.** The same action logs run in (1) native nextest, (2) WASM under Node, (3) Chromium, (4) Playwright WebKit, (5) Playwright Firefox, each asserting the same golden values at several checkpoints (not just the end, so the first divergent tick is reported). The browser variant loads the WASM in a worker on a bare page; no GPU, so headless Firefox is fine.
- Launches cost under 0.5 s, so WebKit and Firefox sim-hash tests start in the fast suite and fall under the demotion rule if needed. On Linux CI Playwright's WebKit is the WPE/GTK port: still JavaScriptCore, still a valid second WASM engine.
- **Rendering is asserted in Chromium only in the fast suite.** Slow suite: one readback scene in Playwright WebKit (WebGPU verified working headless on macOS). Firefox rendering is not automated (no headless adapter; headed only) until Firefox matters.
- **What Playwright WebKit is not:** iOS Safari. It is a desktop WebKit build (26.5/26.6, macOS frameworks), without iOS memory ceilings, JIT restrictions in some contexts, tab-backgrounding behaviour or mobile GPU limits. Real-device checks are manual (see questions).
- The hash must be independent of pointer width and of host float formatting: native is 64-bit, WASM is 32-bit. WASM float arithmetic is deterministic apart from NaN bit patterns; native-vs-WASM divergence comes from libm functions and FMA contraction. That constrains `simulation.md` (section 4).
- Slow suite "heavy mode" after Factorio: snapshot → load → hash equality every K ticks during a replay, natively.

### 3.9 Performance regression checks — confidence: medium

- **Fast suite: deterministic counters only, never wall-clock.** Per scripted scenario, snapshot-style exact values with a budget ceiling: bytes sent per client per tick and per chunk subscribe; message counts; JS allocation per frame per isolate (from 3.3); draw calls, buffer-upload bytes and pipeline switches per frame; WASM linear-memory high-water mark; entities/chunks touched per tick if the sim exposes such counters. These are noise-free, so a 1 % regression is detectable and a change shows up as a reviewed diff in a checked-in numbers file.
- **Slow suite: timing.** Native tick-time benchmarks (criterion or divan) on a standard large-factory save; browser frame time from a CDP trace on the real GPU with real rAF pacing; compared against a checked-in baseline with a generous threshold (start at 25 %) and only meaningful on Tyler's machine. CI timing is recorded but not gating.
- Optional, low confidence: deterministic instruction counts by running the sim WASM under wasmtime with fuel metering, which would give a noise-free CPU-cost proxy. Costs a heavy dev-dependency or an installed CLI; defer until timing noise is actually a problem.

## 4. Cross-domain interactions

What the engine must expose or guarantee so the above is possible:

- **Clock and scheduler adapter** (all domains): one injectable source of time and timers on main thread, workers and server. Production binds it to `performance.now`/rAF/`setTimeout`; tests bind a virtual clock. Same for the PRNG seed.
- **Manual stepping**: `stepTick()` on the sim and `stepFrame(dt)` on the client, callable without rAF, plus a way to await cross-thread quiescence ("all messages produced by that step have been consumed") so a test can run N frames deterministically across main thread and workers. With SharedArrayBuffer ring buffers this needs an explicit sequence/ack counter.
- **Frame stepping vs WebGPU canvas textures**: `getCurrentTexture()` is tied to the current task, so stepping many frames in one task cannot present each to the canvas. The renderer should accept an arbitrary render target (offscreen texture in tests, canvas texture in production). This also gives readback tests a fixed-size, fixed-format target independent of DPR.
- **State hash API** (`simulation.md`, `world.md`, `sync.md`): whole-world hash on the sim; per-chunk/region hash usable by a client holding partial state (shared with production desync detection); hash defined over a canonical serialisation, independent of pointer width, map iteration order and allocation addresses. Checkpoint hashes at arbitrary ticks.
- **Float determinism** (`simulation.md`): integer/fixed-point in the sim, or no libm transcendental functions and no FMA contraction, otherwise native goldens will not match WASM.
- **Snapshot/replay** (`world.md` persistence): action-log record and replay is both a feature and the main test fixture; save→load must be hash-identical (heavy mode).
- **Transport interface** (`sync.md`, `runtime-and-packaging.md`): the injected transport adapter that host-agnosticism and "zero npm deps vs WebSocket server" already suggest is the same seam the conditioner wraps. The client sync layer must be usable without DOM or renderer (headless client in Node).
- **Headless client and input injection** (`client.md`): input arrives as engine-level events through an API, so tests script "pan, zoom, tap" without synthesising DOM events; one or two Playwright tests cover the real DOM event path.
- **Zero-GC definition** (`runtime-and-packaging.md`): must be phrased as "no GC events in steady-state windows, ~0 JS allocation on non-WebGPU isolates, and a fixed per-frame floor on the WebGPU isolate", because WebGPU calls allocate wrappers. Worker topology affects the test: if rendering moves to an OffscreenCanvas worker, the floor moves with it and the main thread's budget drops to ~0. A wasm-bindgen boundary would show up directly in assertion B.
- **Cross-origin isolation**: the test server must send COOP/COEP (the probe did); the same requirement lands on the reference game's Vite dev server and production host.
- **Test builds**: a `test` entry/flag exposing the stepping hooks, counters and the negative-control allocation hook; it must not ship in the production bundle. Engine tests probably want tiny fixture games (one per feature) in addition to the reference game, since the reference game "exercises every feature" and is therefore the slowest fixture.
- **Worktrees and build caches** (`docs/process.md`): agents in fresh worktrees pay a cold Rust build unless sccache or a shared target dir is configured.

## 5. Needs a spike, and questions for Tyler

### Spike A (required): zero-GC / allocation assertion in headless Chrome with a real WebGPU device

Must prove, on Tyler's Mac with Playwright `channel: 'chromium'` headless and a Metal adapter:
1. A page with a main thread issuing one real WebGPU render pass per frame and at least one worker running a WASM module that ticks, communicating the way the engine plans to (SAB ring or transferables), can be **stepped manually** (no rAF pacing) for W = 120 warm-up + N = 600 measured frames in **under 3 s** wall clock. Settle how frames are stepped given `getCurrentTexture()`'s per-task lifetime (offscreen target vs one task per frame) and how cross-thread quiescence is awaited without allocating.
2. The clean variant passes assertions A and B from 3.3 on every isolate in **at least 50 consecutive runs** (and under parallel load from other suites) with zero flakes; record the measured floor per isolate and its run-to-run spread with `--sampling-heap-profiler-suppress-randomness`.
3. Deliberately allocating variants **fail**: one small object per frame on main fails B on main only; the same in the worker fails B on the worker only; about 2000 objects per frame fails A on the right thread. Each in 50/50 runs.
4. Tracing overhead and trace size are acceptable (probe: about 25–60k events for a 5 s window with the wide category set; try the narrow set) and the whole test fits in about 5 s.
5. Whether `--single-threaded-gc`, a fixed semi-space, or a fresh browser context per test is needed for stability, and whether the same test behaves on the SwiftShader adapter.

### Spike B (recommended): WebGPU in Chromium on a GitHub `ubuntu-latest` runner

Prove that Playwright Chromium with the SwiftShader flag set (1.2) returns an adapter and device on a stock runner, which apt packages it needs, whether the old headless shell or new headless is required, that offscreen render + readback of a tile scene matches macOS Metal within the 3.4 tolerance, and how long browser install + the suite take with caching. If it fails, fall back to Dawn node bindings for readback tests in CI or accept that GPU tests run only locally.

### Spike C (optional, can fold into Phase 3): ledger-based conditioner over real WebSockets

Prove that the `advanceTo(t)` design in 3.5 gives byte-identical client/server traces across 100 runs of one seed over loopback WebSockets, and measure ticks per second it sustains (target: a 60 s simulated session with 4 clients in under 2 s).

### Questions for Tyler

1. **Does the 1-minute budget cover compilation?** Recommended default: no. 60 s is test execution with warm caches; a separate target of ≤ 30 s for the incremental build after a one-line Rust edit; cold builds unbudgeted.
2. **Is there CI, and on what?** Recommended default: GitHub Actions on `ubuntu-latest` (free tier friendly), software WebGPU adapter, fast + slow suites on every push; real-GPU rendering and the timing benchmarks run only on your Mac. No GPU or macOS runners unless spike B fails.
3. **Dev dependencies are fine?** "Zero dependencies" is read as zero *runtime* npm dependencies of the published package. Recommended default: yes to Playwright, Vitest and TypeScript as devDependencies, and cargo-nextest and sccache as installed tools.
4. **Real iOS Safari.** Playwright's WebKit is desktop WebKit, not iOS. Recommended default: no paid device cloud; a short manual checklist on your own iPhone before anything is called done, and automated WebKit coverage limited to the sim hash plus one render smoke.
5. **Strictness of "zero GC".** WebGPU calls allocate about 90 B/frame of unavoidable wrappers, so the rendering isolate will scavenge once every few minutes to an hour. Recommended default: accept a fixed per-frame allocation floor on the WebGPU isolate and rare sub-millisecond scavenges; require zero major GCs in steady state and ~zero allocation on all other engine isolates.
6. **Golden-image churn.** Recommended default: goldens are regenerated by an explicit command and reviewed as image diffs in the PR; semantic pixel probes are the gate, goldens are secondary.
