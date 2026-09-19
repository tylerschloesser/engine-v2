# 0016: What "zero GC" means, and how it is asserted

Status: Accepted (2026-09-19)

## Context

Requirements in [`../spec/testing.md`](../spec/testing.md) give Tyler's wording: zero major GCs and approximately zero allocation on every engine-owned isolate in steady state, with a fixed floor of about 100 B/frame on the rendering thread. That needs a measurable form: which isolates, what counts as steady state, which instrument, which numbers. Forces: each worker has its own V8 heap ([0015](0015-threads-memory-and-topology.md)); every WebGPU call that returns an object allocates a 16-byte JS wrapper, so the rendering isolate cannot reach zero; the WebSocket API allocates per message; V8's young generation absorbs about 1 MB before the first scavenge, so "no GC happened" proves little. `spikes/zero-gc-webgpu` measured what is assertable (820/820 clean passes, 150/150 negative controls failing exactly where expected, about 0.2 s per test).

## Decision

**1. Isolates** (topology: [0015](0015-threads-memory-and-topology.md)). "Bytes per frame" is always exact sampled bytes on that isolate over the window, divided by the N main-thread frames in it.

| Isolate | Class | Budget in the window |
|---|---|---|
| Main thread (TypeScript: WebGPU, camera, input) | strict, WebGPU floor | **110 B/frame**, zero `MinorGC`, zero `MajorGC` |
| Client worker, sim worker (single-player), each worldgen worker | strict | **8 B/frame**, zero `MinorGC`, zero `MajorGC` |
| Net worker (multiplayer) | budgeted | **≤ 1 KB per received message**, zero `MajorGC`; scavenges allowed |
| Every WASM instance | | `memory.buffer.byteLength` unchanged (no `memory.grow`; arena: [0015](0015-threads-memory-and-topology.md)) |

The net worker is the one isolate not held to about zero: `WebSocket` hands every message over as a fresh `MessageEvent` + `ArrayBuffer`, and the worker exists to confine that garbage to a heap where a scavenge cannot delay a frame or a tick ([0009](0009-transport-and-hosting.md)). It is still measured; its own code (copying into the SAB ring) must add nothing beyond what the API forces. At one network frame per tick ([0010](0010-rates-and-subscriptions.md)) the budget means at most about 20 KB/s, a sub-millisecond scavenge roughly once a minute.

The main-thread floor is 16 B per WebGPU wrapper object (encoder, pass, command buffer, view, canvas texture) plus 24 B per task that touches WebGPU. Measured clean: 100.3–102.0 B/frame including 36 B/frame of test-harness overhead; one extra 16-byte object per frame reads ≥ 121.8. In production (canvas, `requestAnimationFrame`) the floor is about 118 B/frame: a 1 MB semi-space fills every ~2.5 minutes at 60 Hz and the scavenge of an all-dead nursery is sub-millisecond. That is the "rare scavenge" the Requirements accept. The renderer ([0018](0018-renderer.md)) keeps the count of wrapper-returning calls per frame constant; the budget is 16 B x that count + 24 + harness overhead + 8 B margin, held in one checked-in budgets file, and raising it is a reviewed change.

**2. Steady state is normal play, including panning.** The measured window runs ticks, receives deltas, pans and zooms continuously so chunks are subscribed, generated, uploaded and evicted, and submits game actions. **Chunk-enter bursts are not exempt**: panning is the normal state of this genre and a GC hitch while panning is the failure the rule exists to prevent. Consequence: chunk CPU and GPU storage is pooled and created at setup, never per chunk.

Exempt by nature:
- One-time setup: load, module compile, device/pipeline/pool creation, and the 120 warm-up frames (JIT tiers and inline caches settle).
- The game's DOM UI and anything it triggers on the main thread. The engine cannot bound game DOM code; the test page mounts no UI. Overlay anchoring ([0019](0019-camera-input-and-overlay.md)) is engine code: with no anchors mounted it writes no styles, so the strict window above sees none of it; with anchors mounted, the 1–2 short style strings per moving-camera frame are a separate line in the budgets file, asserted by its own test with a fixed anchor count (number deferred below with the main-thread number).
- UI-driven action dispatch: `client.dispatch` JSON-encodes on the main thread ([0003](0003-game-facing-api.md)), once per human gesture, not per frame. Only that encode is exempt. In the window the test writes pre-encoded action bytes into the ring, so the ring, the WASM parse, prediction and wire encode are all covered.
- Rare discontinuities: resize/DPR change, device loss, reconnect, tab background/foreground, panic recovery ([0005](0005-persistence-and-recovery.md)).

**3. The assertion** (Playwright Test, Chromium, raw CDP; one test per topology: single-player and multiplayer against a real local server). Full flag and call listing, with the working harness: [`../../spikes/zero-gc-webgpu/RESULT.md`](../../spikes/zero-gc-webgpu/RESULT.md).

```js
use: { channel: 'chromium', headless: true, launchOptions: { args: ['--enable-unsafe-webgpu',
  '--disable-features=SpareRendererForSitePerProcess',
  '--js-flags=--expose-gc --sampling-heap-profiler-suppress-randomness'] } }
```

1. Page served with COOP/COEP; assert `crossOriginIsolated` and a non-null adapter (record `adapter.info`).
2. `context.newCDPSession(page)`; `Target.setAutoAttach {autoAttach: true, waitForDebuggerOnStart: false, flatten: false}`; workers are driven with `Target.sendMessageToTarget`. `browser.newBrowserCDPSession()` for tracing.
3. Step 120 warm-up frames. On every isolate: `HeapProfiler.enable`, `HeapProfiler.collectGarbage`.
4. `Tracing.start` with categories `v8`, `devtools.timeline`, `blink.user_timing`. On every isolate: `HeapProfiler.startSampling {samplingInterval: 1, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true}`.
5. `performance.mark('window-start')`, step **N = 600 frames** manually (all frames in one task, rendering into an offscreen target; workers in lockstep over `Atomics`; stepping API: [0020](0020-testing-strategy.md)), `performance.mark('window-end')`. `stopSampling`, `Tracing.end`.
6. **A (GC events):** zero `MinorGC`/`MajorGC` trace events with `ts` inside the marks on `CrRendererMain` and every `DedicatedWorker thread` of the page's renderer pid (net worker: `MajorGC` only).
7. **B (allocation):** sum of `selfSize` per isolate / N ≤ the budget above. At `samplingInterval: 1` the profiler reports exact bytes; the worker total was bit-identical in 820 runs and main varied by 1.6 B/frame. On failure the test prints the top call frames by bytes, which names the allocation site.
8. **Permanent negative controls** behind a test-only hook, each of which must fail on the named isolate and nowhere else: one small object per frame on main (B); one per tick in a worker (B); a `postMessage` per frame (B on both ends); 2000 objects per frame on main, and in a worker (A and B). Each control test passes only when its assertion trips, so if a Chrome update blinds the instrument the suite goes red.

**Caveats that are part of the decision.** (a) `Tracing.start` stalled ~10 s in 4 of 570 runs with results still correct, apparently waiting on Chrome's spare renderer; with the `--disable-features` flag above, 0 of 400. The harness times `Tracing.start` and reports a stall as a named warning, not as a budget failure. (b) On SwiftShader (Linux CI) the spike's 4096-quad scene drained at ~58 ms/frame and N = 600 timed out; with N = 100 the frame function still cost 64.2 B/frame with zero GCs, but total/N read 277 because harness overhead no longer amortises. On a software adapter the test therefore uses a trivial scene or smaller N and asserts on bytes attributed to the engine's frame and tick functions (exact constants in the spike: 38 424 B main, 0 B worker per 600 frames) instead of total/N. (c) Only the V8 heap is measured; Oilpan, Dawn and GPU-process memory are invisible to B, and only A would notice them.

## Alternatives rejected

- **GC-event-only assertion.** A control leaking 10 objects per frame (404 B/frame measured) produced zero GC events in 25/25 runs; A is blind below about 1 MB per window. B caught everything A caught. A stays for GCs not caused by JS-heap allocation.
- **Heap-size sampling** (`Runtime.getHeapUsage` delta ≤ 64 KB, or polling `performance.memory`): meaningless once any GC runs in the window, no call-site attribution, and 64 KB per 600 frames cannot separate the WebGPU floor from one stray object per frame.
- **`--js-flags=--trace-gc` parsing:** nothing reached the launcher's pipes from headless Chrome on macOS; unstructured text without thread names.
- **`performance.measureUserAgentSpecificMemory()`:** resolves only after a future GC, coarse per-realm sizes; cannot bound a frame window. `FinalizationRegistry` canaries fail the same way.
- **`samplingInterval` 128 with suppressed randomness:** V8 still applies Poisson scaling, biasing totals by object size (64 B/frame reads 68 at 128 and 101 at 16). Interval 1 cost nothing measurable (19 vs 21 ms window).
- **Shrinking the semi-space to force scavenges:** whole-MB granularity, and it changes the thing being measured.
- **Exempting chunk-enter, or the net worker entirely:** the first hides the most likely source of hitches; the second lets engine code in that worker rot unmeasured.

## Consequences

- Forces elsewhere: no `postMessage` on any per-frame or per-tick path (SAB rings only, [0015](0015-threads-memory-and-topology.md)); reused descriptor objects and pooled chunk GPU resources ([0018](0018-renderer.md)); preallocated views for every SAB/WASM copy ([0014](0014-js-wasm-boundary.md)); engine-level input injection that does not allocate ([0019](0019-camera-input-and-overlay.md)); a test-only build exposing stepping, the negative-control hook and per-instance memory size ([0020](0020-testing-strategy.md)).
- Desktop Chromium only. JavaScriptCore and SpiderMonkey have no equivalent instrument; on iOS the rule is checked by feel ([0020](0020-testing-strategy.md) checklist).
- `Target.sendMessageToTarget` is deprecated; if Chrome removes it the harness opens its own CDP WebSocket (`--remote-debugging-port`) and uses flattened sessions.
- The 24 B per WebGPU task is unexplained, and one 16-byte control object measured +21.3 B; neither affects the 8 B / 12 B separation around the budget.
- Deferred to Phase 3: the final main-thread number and the overlay-anchoring string constant, because the first is 16 B x the real renderer's wrapper count and no renderer or overlay exists; 110 is correct for a one-pass frame and the formula above fixes how it changes.
- Deferred to Phase 3: the software-adapter form of B (scene, N, per-function numbers), because SwiftShader on a GitHub runner was not measured (spike B in [0020](0020-testing-strategy.md)); the rule in caveat (b) is decided, only the numbers are open.
- Deferred to Phase 2: whether the periodic snapshot write ([0005](0005-persistence-and-recovery.md)) is inside the strict window or a budgeted event like a net message, because no persistence code or measurement exists. Default until measured: inside (the test forces one snapshot in the window through the injected clock).

## Sources

- Spike: [`../../spikes/zero-gc-webgpu/RESULT.md`](../../spikes/zero-gc-webgpu/RESULT.md) (all numbers above; Chromium 153, Playwright 1.63, M3 Max)
- [`../research/testing.md`](../research/testing.md) 1.3, 3.3, 3.7; [`../research/runtime-and-packaging.md`](../research/runtime-and-packaging.md) 3.4
- CDP: https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/ , https://chromedevtools.github.io/devtools-protocol/tot/Tracing/ , https://chromedevtools.github.io/devtools-protocol/tot/Target/
- V8 tracing: https://v8.dev/docs/trace ; `measureUserAgentSpecificMemory`: https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory
