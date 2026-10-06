# M39k: Measure GPU execution time, not queue latency

Status: not started · After: 39j · Tyler-dependent: no

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
- [ ] The tests exist and each was seen red.
- [ ] Driven rounds on both phones (`pnpm device:walk --auto --drive android|ios --round m39k-<phone> --only M09b-fill-rate,M18-fill-rate-with-anchors`): status rows pasted with `gpu_exec_p95_ms` and `gpu_latency_p95_ms`. A fail on real execution time is reported as a finding, not tuned away.
- [ ] No golden, budget or baseline changed; the zero-GC pages are unchanged (option off).
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Deviations
(filled in during Phase 3)
