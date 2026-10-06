# M39k: Measure GPU execution time, not queue latency

Status: done (2026-10-06) · After: 39j · Tyler-dependent: no

## Goal
M09b-fill-rate and M18-fill-rate-with-anchors fail on both phones on `gpu_p95_ms` alone: Pixel 12-14 ms (19 ms with anchors), iPhone 6.5-14 ms. The limit is 6 ms, from `docs/decisions/0018-renderer.md` §9 ("GPU ≤ 6 ms") and Consequences ("GPU time under ~6 ms").

A read-only diagnosis (2026-10-06) found the metric is the wrong quantity.
- **What it measures:** `packages/engine/tests/browser/pages/src/device.ts` (the instrumented `requestFrame` wrapper, about lines 268-277 and the copy at 857-880) takes `performance.now()` after the frame's submit and resolves on `queue.onSubmittedWorkDone()`, every 30th frame. That is submit-to-done latency on a vsync-paced queue.
- **What that comes to:** on the Pixel, a trivial flat-colour full-screen pass reads the same 12.9 ms p50 / 14.7 ms p95 by that method, while its `timestamp-query` begin/end delta is 1.18 ms. So 12-14 ms is the vsync floor (about 0.8 of a frame interval), which is why no scale cap moved it.
- **Not enabled anywhere:** no code in the engine or the pages uses timestamp queries, and the engine's device requests no features.

When this is done the device page reports the main render pass's **GPU execution time** from timestamp queries (`gpu_exec_p95_ms`). The M09b and M18 fill-rate criteria judge that against 6 ms. The latency stays visible as an informational reading.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0018-renderer.md` §9 and Consequences (the fill-rate check)
3. `packages/engine/tests/browser/pages/src/device.ts` (the HUD and `__check.readings()`), the engine's device request and render pass (`grep -rn "requestDevice\|beginRenderPass\|DEVICE_REQUEST" packages/engine/src`), and `scripts/lib/device-walk/checks.mjs` (`gpu_p95_ms`)
Rules: `.claude/rules/hot-paths.md`. The render pass is per-frame: no allocation when timing is on, and nothing at all changes when it is off.

## Scope
1. **Opt-in GPU timing in the engine.** Add a render option (name it in Deviations, e.g. `ClientOptions.render.gpuTiming`, default off). When on and `adapter.features.has('timestamp-query')`, the device request adds `timestamp-query`. The main render pass(es) of a frame get `timestampWrites`, resolved into a small preallocated ring (query set, resolve buffer, mappable read buffers), and read back one or more frames late, never on the frame that wrote them. Expose the latest durations through an allocation-free accessor (e.g. a `Float64Array` view or a callback the page reads). With the option off, the device request, the passes and every existing test are byte-for-byte as before: `render/device.test.ts`'s assertion that no features are requested must still hold for the default.
2. **The device page** turns the option on and reports `gpu_exec_p95_ms` (and p50) in the HUD and `__check.readings()`. The old reading is renamed `gpu_latency_p95_ms` and labelled as such in the HUD. When `timestamp-query` is unavailable or a readback fails, `gpu_exec_p95_ms` is `null` and the HUD says why.
3. **The criteria** (`checks.mjs`): the fill-rate family's GPU criterion reads `gpu_exec_p95_ms ≤ 6` (ref 0018 §9). A `null` exec reading is **not** a pass: the criterion is `ok: null` and the item goes to a judge sheet that shows `gpu_latency_p95_ms` with "timestamp-query unavailable". `gpu_latency_p95_ms` is recorded as an informational metric.
4. If Chrome or Safari quantises or clamps timestamps, record the observed resolution in Deviations. Quantisation of about 65 µs is fine against 6 ms.

## Non-scope
Renderer performance work: if real execution time exceeds 6 ms, that is a finding for a new brief. Other pages' HUDs, the reference game, zero-GC budgets.

## Tests added (each seen red once, red line pasted)
- Unit (`device-walk-checks.test.mjs`): the GPU criterion reads `gpu_exec_p95_ms` (6.0 passes, 6.1 fails); `null` gives `ok: null`, not a pass.
- Engine unit: with the option off, the device request has no `requiredFeatures` (the existing assertion), and no `timestampWrites` appears on a pass descriptor; with it on and the feature present, both appear. Use the existing fake-device style of `render/device.test.ts`.
- The engine's timing ring reads back late (not on the writing frame), checked with a fake queue and buffers.

## Exit criteria
- [x] The tests exist and each was seen red.
- [x] Driven rounds on both phones (`pnpm device:walk --auto --drive android|ios --round m39k-<phone> --only M09b-fill-rate,M18-fill-rate-with-anchors`): status rows pasted with `gpu_exec_p95_ms` and `gpu_latency_p95_ms`. A fail on real execution time is reported as a finding, not tuned away.
- [x] No golden, budget or baseline changed; the zero-GC pages are unchanged (option off).
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Deviations
**Seams (Provides).**
- Option: `ClientOptions.render.gpuTiming?: boolean` (`RenderOptions` in `src/client.ts`), default off. It is read by `createGpuResources` (`GpuResourcesOptions.gpuTiming`, forwarded to `initDevice({ gpuTiming })` and `createTerrainRenderer(device, { ..., gpuTiming })`). The device page, which builds its own device and renderer, passes `gpuTiming: true` to both.
- `initDevice({ gpuTiming })` requests `timestamp-query` only when set and `adapter.features.has('timestamp-query')` (`deviceRequestFor`, `DEVICE_REQUEST_GPU_TIMING` in `render/device.ts`); `DEVICE_REQUEST` is unchanged and still empty. `RendererDevice.gpuTimingFeature: boolean`.
- Accessor: `TerrainRenderer.gpuTimer?: GpuTimer | null` (optional so existing test mocks of the interface compile unchanged; `null` when the option is off). `GpuTimer` (`render/gpu-timing.ts`, also exported from `render.ts` with `createGpuTimer`): `unavailable: string | null`, `lastMs`, `count`, `ring: Float64Array(64)`, `onSample: ((ms) => void) | null`, plus `begin(desc)` / `resolve(encoder)` / `afterSubmit()` which `terrain.draw` calls. Only the terrain pass (which contains the drawables via `onEncode`) is timed; the standalone `drawables.draw` pass is not.
- Ring: 3 slots (query set of 6, one 768 B resolve buffer, three 16 B MAP_READ buffers), one frame in 4 timed (`sampleEvery`), a busy ring skips the frame. A sample lands on a later task via `mapAsync().then(preallocated callback)`, never on the writing frame. Per sampled frame the browser still allocates the `mapAsync` promise and the mapped `ArrayBuffer` (and a `BigUint64Array` view over it): unavoidable, bounded by `sampleEvery`, and only with the option on.
- Page readings (`__check.readings()`, both `device.html` fill-rate and `?anchors=` pages): `gpu_exec_p95_ms`, `gpu_exec_p50_ms`, `gpu_exec_n`, `gpu_exec_unavailable` (string), `gpu_latency_p95_ms` (the old `gpu_p95_ms`, renamed), `gpu_n`. `gpu_exec_p95_ms` is `null` when the timer is off, unavailable, or has no sample in the 10 s window. HUD: a `GPU exec p50/p95 (10s, timestamp query)` line or `unavailable (<why>)`, and the latency line relabelled `informational: submit-to-done incl. vsync wait`.
- Criterion (`checks.mjs` `fillRate`): `gpu_exec_p95_ms` (`steady.*.gpu_exec_p95_ms`, max, <= 6, `nullIs: 'judge'`). Metrics added: `gpu_exec_p50_ms`, `gpu_latency_p95_ms` (`max-known`). `auto-round.mjs`: a judge sheet whose `gpu_exec_p95_ms` is null appends `timestamp-query unavailable, gpu_latency_p95_ms <v> (informational: submit-to-done, includes the vsync wait)` to its "Measured:" text.

**Differences from the brief.**
- Existing tests edited (renaming the reading the criterion consumes, not weakening): `scripts/lib/device-walk-checks.test.mjs` and `device-walk-auto.test.mjs` (`gpu_p95_ms` -> `gpu_exec_p95_ms` in the sample readings and the limit test). New tests: `render/gpu-timing.test.ts` (6, each seen red by mutation: `deviceRequestFor` ignoring the option, `begin` arming every frame, readback delivered on the writing frame) and one in `device-walk-checks.test.mjs` (6.0 passes, 6.1 fails, null is `ok: null` / verdict `judge`; red by renaming the criterion back).
- The Pass text of `M09b-fill-rate` and `M18-fill-rate-with-anchors` in `docs/plan/device-checks.md` still says "GPU latency p95 <= 6 ms". I did not edit it (not my section; the Pass hash in `checks.mjs` would change with it): it should read "GPU execution p95 (timestamp query) <= 6 ms". Orchestrator's call. `docs/plan/39f-device-auto-runner.md` line 250 lists `gpu_p95_ms` among the readings (history, not edited).
- The `[gc] terrain clean` pattern in the delegation is a regex character class and matches nothing; `pnpm test browser -t "terrain clean"` ran: `browser pass 2 tests`. Also `-t "device|anchors|fill"`: `browser pass 18 tests`.

**Observed timestamp resolution.** No quantisation visible at the 1 ms scale. iPhone 12 (Safari): p50 values step by 0.001 ms (0.533, 0.534 ... 0.539 across steady samples), so granularity is at most about 1 us after the page's 3-decimal rounding. Pixel (Chrome Android): distinct 3-decimal values (1.835, 5.505), no coarse steps seen. Neither device clamped to a multiple of 65 us in the readings.

**Driven rounds (logs `docs/plan/device-rounds/m39k-pixel.jsonl`, `m39k-iphone.jsonl`).**
- Pixel: M09b-fill-rate `pass` (raf p95 16.77, over20 0, `gpu_exec_p95_ms` 5.571 (p50 5.505), `gpu_latency_p95_ms` 13.74, hitch 0); M18-fill-rate-with-anchors `pass` (`gpu_exec_p95_ms` 2.097, p50 1.835, latency 22.27). Execution time is 0.93 of the 6 ms limit on the terrain scene at 256 tiles: a thin margin, a finding for whoever changes the renderer.
- iPhone: M09b `fail` on rAF only (default: raf p95 18.58, over20 10, hitch 3; the ladder rungs 19.3-20, 21-29 gaps), `gpu_exec_p95_ms` 3.852 (p50 2.567), `gpu_latency_p95_ms` 9.02. WDA, Appium and the tunnel run beside it (load 2-3, not a quiet-phone number; as in M39j). M18 on the iPhone: raf p95 17.1, over20 1, `gpu_exec_p95_ms` 0.69, one rAF gap over 25 ms -> judge sheet, left pending (not judged by me); screenshot `test-results/device-walk/m39k-iphone/M18-fill-rate-with-anchors-1-judge.png`. I SIGTERMed the driver after that (it does not exit by itself while a sheet is parked); cleanup shown clean (no device-walk/appium/xcodebuild/cloudflared/vite processes, `adb reverse`/`forward` empty).
- With the exec metric, the GPU criterion is met on both phones; the remaining iPhone M09b failure is the rAF criteria (a finding for a new brief, not the GPU share).

- **Gate (orchestrator):** device-checks.md Pass text of M09b-fill-rate and M18-fill-rate-with-anchors now says GPU execution p95 (timestamp queries, `gpu_exec_p95_ms`); `checks.mjs` pass hashes updated (`a6f372a8`, `58065580`). iPhone M18 judged pass (one dropped frame with automation beside it). Open: iPhone M09b fails on rAF only (p95 18.6 ms, 10 gaps > 20 ms) with WDA/tunnel beside the page: joins finding 5 (re-measure on a quiet phone). Pixel M09b passes at 5.57 ms of 6: thin margin.
