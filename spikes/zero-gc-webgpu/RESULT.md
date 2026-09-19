# Spike A result: zero-GC / allocation assertion with a real WebGPU device

Date 2026-09-19. Machine: Apple M3 Max (14 cores), macOS, Node 22.18, `@playwright/test` 1.63.0, bundled Chromium build 1243 (`HeadlessChrome/153.0.0.0`). Throwaway code; every number below was observed on this machine.

## Verdict

**Feasible, with zero assertion flakes.** A Playwright test can step a real Metal WebGPU render loop plus a WASM sim worker for 120 warm-up + 600 measured frames, and assert per isolate (page main thread and dedicated worker) both "no GC events" and an exact "bytes allocated per frame" budget.

- Clean variants: **820/820 passes** (410 plain-view, 410 shared-WASM-memory view), including 100 under 12 CPU burner processes and all with 8 parallel Playwright workers.
- Negative controls: **150/150 failed exactly where expected** and nowhere else (6 controls x 25 runs, 60 of them under CPU load).
- Cost: about **0.2 s per test run alone, 0.4 s median / 0.55 s p95 with 8 parallel workers**; the whole 8-test suite (2 clean + 6 negative controls) takes **2.4-2.7 s** wall clock with 4 workers. The measured 600-frame window itself is about 20 ms.
- One wall-clock hazard found: `Tracing.start` stalled for ~10 s in 4 of 570 runs (results still correct). See caveats.

Two changes to the research recommendation (`docs/research/testing.md` 3.3):

1. **Use `samplingInterval: 1`, not 128.** At interval 1 the sampling heap profiler reports exact bytes. At larger intervals V8 still applies its Poisson scaling to deterministic samples, which biases totals by object size (the same 64 B/frame of 16-byte wrappers reads as 64.0 at interval 1, 101 at 16, 68 at 128). With interval 1, `--sampling-heap-profiler-suppress-randomness` made no difference (identical numbers with and without, 40 runs), and the overhead is unmeasurable for clean code (window 19 ms vs 21 ms).
2. **The WebGPU floor is lower and more exact than estimated**: 16 bytes per wrapper object, so 48-104 B/frame depending on how the frame is driven (table below), not "about 90".

## What was built

- `public/main.js`: one pipeline, a 4096-instance buffer updated every frame with one `queue.writeBuffer` from a long-lived view, one draw; every descriptor reused. No rAF: `window.spike.run(n)` steps n frames. Default stepping is all frames in one task into an offscreen texture (`createView` per frame).
- `public/worker.js` + `public/sim.wasm` (148 bytes, hand-assembled by `gen-wasm.mjs`): a module worker whose WASM `tick` writes instance data into an imported `WebAssembly.Memory({shared: true})`. Lockstep with the main thread over the SAB: main does `Atomics.store` + `Atomics.notify` and spins on the ack; the worker sits in an `Atomics.wait` loop. Zero allocation per tick on both sides. The worker leaves the loop after each run so CDP can reach it.
- `server.mjs`: static server with COOP/COEP (`crossOriginIsolated === true` verified in every test).
- `tests/harness.mjs`: the CDP harness. `tests/zero-gc.spec.mjs`: the suite. `tests/probe.spec.mjs` + `summarize.mjs`: exploration tools.

## Launch flags and CDP calls that worked

```js
use: { channel: 'chromium', headless: true,
  launchOptions: { args: ['--enable-unsafe-webgpu',
    '--js-flags=--expose-gc --sampling-heap-profiler-suppress-randomness'] } }
```

Adapter (asserted in every test): `vendor: "apple", architecture: "metal-3", device: "", description: "", isFallbackAdapter: false`. `gc` is exposed on main and in the worker. Not needed: `--single-threaded-gc`, a fixed semi-space, a fresh browser per test (one browser per Playwright worker, new context per test, was stable).

Sequence per test:
1. `page.goto`, await `spike.ready`.
2. `pageSession = context.newCDPSession(page)`; `Target.setAutoAttach {autoAttach: true, waitForDebuggerOnStart: false, flatten: false}`. It attaches to the already-running worker and fires `Target.attachedToTarget` (`targetInfo.type === 'worker'`). Playwright's `CDPSession` cannot address flattened child sessions, so the worker is driven with `Target.sendMessageToTarget` / `Target.receivedMessageFromTarget` (deprecated, works). `browser.newBrowserCDPSession()` for tracing.
3. Warm-up `spike.run(120)`.
4. On both isolates: `HeapProfiler.enable`, `HeapProfiler.collectGarbage`.
5. Browser session: `Tracing.start {transferMode: 'ReportEvents', traceConfig: {recordMode: 'recordUntilFull', includedCategories: ['v8', 'devtools.timeline', 'blink.user_timing']}}`.
6. On both isolates: `HeapProfiler.startSampling {samplingInterval: 1, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true}`.
7. `spike.run(600, 'window')`, which calls `performance.mark('window-start' / 'window-end')` around the frames.
8. `HeapProfiler.stopSampling` on both (sum `selfSize` over the tree; per-function attribution comes free), `Tracing.end`, collect `Tracing.dataCollected` until `Tracing.tracingComplete`.
9. Trace analysis: the marks give the renderer `pid`, the main `tid` and the window; count `MinorGC`/`MajorGC` with `ts` inside the window; `thread_name` metadata separates `CrRendererMain` from `DedicatedWorker thread`. The narrow category set yields only ~400 events per test (1.6k with one task per frame, 7.6k with a postMessage per frame).

## Numbers (N = 600 frames, exact bytes, sampling interval 1)

Per-isolate totals include a fixed harness overhead inside the window (Playwright `evaluate`, the `run` promise, marks, the arm message): about 21.7 KB on main (= 36 B/frame at N = 600; measured 35.0-37.2 with `gpu=off`) and 0.6 KB on the worker (0.99 B/frame).

| Variant | main B/frame (min..max) | worker B/frame | GCs in window main / worker | runs | outcome |
|---|---|---|---|---|---|
| clean (plain ArrayBuffer view) | 100.41..102.01 | 0.99 (constant) | 0 / 0 | 410 | 410 pass |
| clean, `writeBuffer` from view over shared WASM memory | 100.27..101.87 | 0.99 | 0 / 0 | 410 | 410 pass |
| neg: main allocates 1 small object/frame | 121.80..123.47 | 0.99 | 0 / 0 | 25 | fails B on main only, 25/25 |
| neg: main allocates ~0.7 KB/frame (measured 404 B/frame) | 504.40..506.66 | 0.99 | **0 / 0** | 25 | fails B on main only, 25/25; **A is blind to it**, as predicted |
| neg: worker allocates 1 small object/tick | 100.41..102.01 | 22.35..22.41 | 0 / 0 | 25 | fails B on worker only, 25/25 |
| neg: `postMessage` per frame (main to worker, reply drives next frame) | 140.58 (constant) | 314.57..315.50 | 0 / 0 | 25 | fails B on both isolates, 25/25 (both receive a MessageEvent per frame) |
| neg: main allocates 2000 objects/frame | 56112..56114 | 0.99 | 32 MinorGC / 0 | 25 | fails A and B on main only, 25/25 |
| neg: worker allocates 2000 objects/tick | 100.41..102.01 | 56001.05 | 0 / 32 MinorGC | 25 | fails A and B on worker only, 25/25 |

Run-to-run spread of the clean main total is 1.6 B/frame (about 1 KB per window, not load dependent); the worker is bit-identical every run. No GC of either kind ever appeared inside a clean window. (`HeapProfiler.stopSampling` triggers MajorGCs after the window; the marks exclude them.)

### The WebGPU per-frame allocation floor (bytes attributed to the frame function, exact)

| Frame shape | B/frame | Reading |
|---|---|---|
| Offscreen target, cached view, all frames in one task | 48.0 | encoder + pass + command buffer = 3 x 16 B |
| Offscreen target, `createView()` per frame, one task (the suite's clean variant) | 64.0 | 4 x 16 B |
| Canvas, all frames in one task | 64.1 | `getCurrentTexture()` returns the same wrapper within a task (2 distinct textures in 720 frames), so this does not exercise the production path |
| Offscreen, one task per frame (MessageChannel) | 88.0 | +24 B per task in which WebGPU is used (cause not identified; not a JIT-tier effect: unchanged after 20 000 warm-up frames) |
| Canvas, one task per frame, texture passed directly as attachment view (Chrome 140+) | 88.0 | fresh `GPUTexture` wrapper each task, no view |
| Canvas, one task per frame, `createView()` (production shape) | 104.0 | 5 x 16 B + 24 B |
| Canvas + real `requestAnimationFrame` | 104.0 + ~13.6 for the rAF callback | 720 distinct textures in 720 frames |

Plus 16 B per received `MessageEvent` on the receiving isolate when a MessageChannel drives the frames. Production estimate for the rendering isolate: **about 118 B/frame**, i.e. a 1 MB semi-space fills roughly every 2.5 minutes at 60 Hz.

`writeBuffer` from `new Uint8Array(wasmMemory.buffer)` with `shared: true` memory (a SharedArrayBuffer), using the `(buffer, 0, view, srcOffset, size)` overload: **accepted, no validation or uncaptured errors, the data reaches the GPU (readback shows 36 864 lit pixels, all from that upload), and the JS-heap cost is zero** (frame function 38 424 B per 600 frames in both the shared and the plain variant). Whatever copy Chrome makes into its staging/wire buffer is native memory and invisible to this instrument.

Frame stepping, settled: step all frames in one task into an offscreen target (fast and adds nothing to the floor). Real rAF at 60 Hz costs 10 s per 600 frames; with `--disable-frame-rate-limit --disable-gpu-vsync` the same rAF-driven canvas path ran 600 frames in 93 ms (one run), which makes a production-shaped variant affordable too.

## Recommended assertion and thresholds

Per isolate, over a 600-frame window after 120 warm-up frames and `HeapProfiler.collectGarbage`:

- **A:** zero `MinorGC` + `MajorGC` trace events inside the mark window on `CrRendererMain` and on every `DedicatedWorker thread` of the page's renderer pid.
- **B:** exact sampled bytes (`samplingInterval: 1`) divided by N:
  - WebGPU isolate, offscreen one-task stepping: **budget 110 B/frame**. Clean max 102.0; smallest dirty case (one 16-byte object per frame) min 121.8. Margin 8 B above clean, 12 B below dirty.
  - Non-WebGPU worker: **budget 8 B/frame**. Clean 0.99; one object per tick 22.35.
- Better than a total/N budget, and needed if N ever differs: subtract the fixed harness overhead (about 21.7 KB main, 0.6 KB worker) or assert on the bytes attributed to the engine's frame/tick functions, which were exact constants here (38 424 B main, 0 B worker). The SwiftShader run below shows why: with N = 100 the same clean code reads 277 B/frame as total/N while the frame function is still 64.2 B/frame.
- Keep the negative controls in the suite permanently; they cost 0.2-1.3 s each. The 2000-object controls are the slow ones (about 1.0-1.3 s; 33 MB sampled at interval 1).
- B caught everything A caught. A stays for GCs that are not caused by JS-heap allocation (not exercised here).

## Caveats

- **`Tracing.start` stall.** 4 of 570 runs spent ~10.04 s inside `Tracing.start` (looks like Chrome's timeout waiting for a child process to acknowledge). Assertions still passed. With `--disable-features=SpareRendererForSitePerProcess` there were 0 stalls in 400 runs; at a base rate near 0.7 % that would happen by chance about 6 % of the time, so the fix is suggestive, not proven. A single stall fits inside the 25 s browser budget but not comfortably.
- **SwiftShader / Linux CI is untested on Linux.** Locally, the old headless shell + `--enable-unsafe-webgpu` gave `vendor: google, architecture: swiftshader, isFallbackAdapter: true`; with N = 100 the instrument worked and the frame function cost the same 64.2 B/frame with zero GCs. But this scene (4096 instanced quads, 256x256) drained at about 58 ms per frame on SwiftShader (5.8 s for 100 frames in `onSubmittedWorkDone`), so N = 600 timed out. On a software adapter the GC test needs a trivial scene or a smaller N, and a budget that is not total/N.
- The 24 B per task is unexplained; the "one 16-byte object" control measured +21.3 B/frame, not +16. Neither affects the separation.
- One anomaly: in the 2000-objects-on-main control the frame function read 28 832 B instead of 38 424 B. Not investigated.
- Only the V8 heap is measured. Oilpan (C++ wrappers' backing objects), Dawn wire buffers and GPU-process memory are invisible to B; only A would notice if they triggered a GC.
- `Target.sendMessageToTarget` is deprecated. If Chrome removes it, the harness needs its own CDP WebSocket (`--remote-debugging-port`) to use flattened sessions.
- The main thread busy-spins on the sim ack. Fine for a test driver, not a production pattern; posting `arm` to the worker only takes effect once the main task yields, so the driver awaits an "armed" flag before starting the window.
- Desktop Chromium only. Safari, Firefox and real phones are out of scope. Spike A item "50/50 per negative control" was run at 25 per control, not 50.

## How to re-run

```sh
cd spikes/zero-gc-webgpu
pnpm install && npx playwright install chromium
node gen-wasm.mjs                      # regenerates public/sim.wasm (checked in)
pnpm test                              # 8 tests, ~3 s
pnpm reliability                       # clean x60 each, negatives x15 each
node summarize.mjs results/results.jsonl -v
# exploration: any query-string variant, e.g. the production-shaped frame
PROBE='target=canvas&step=task;target=canvas&step=raf' RESULTS=probe npx playwright test tests/probe.spec.mjs
# knobs: SAMPLING_INTERVAL, WARMUP, FRAMES, BUDGET_MAIN, BUDGET_WORKER, JS_FLAGS, EXTRA_ARGS, TRACE_CATS,
#        CHANNEL=shell ALLOW_FALLBACK=1 FRAMES=100 (SwiftShader), RESULTS=<name> (results/<name>.jsonl)
```

The server listens on `127.0.0.1:4517`. Raw per-run data from this session is in `results/*.jsonl` (gitignored).
