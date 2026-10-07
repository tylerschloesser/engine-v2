# M39p: A measuring window measures only itself, and the driver keeps quiet during it

Status: done (2026-10-06) · After: 39o · Tyler-dependent: no

## Goal
Finding 5 of the driven rounds: on the USB iPhone 12, M09b-fill-rate fails on rAF only (`m39k-iphone`: p95 18.58 against 17.5, 10 gaps over 20 ms per 10 s against 5; GPU exec 3.9 ms passes), and M16-coexist counts 15 hitches in 10 min. The Pixel passes M09b (p95 16.77, 0 gaps). A read-only diagnosis (2026-10-06) found:
1. **A measurement flaw that overstates every steady reading.** The page HUD's rAF stats are a rolling 600-frame (about 10 s) window that is **not reset at window start**. `warmupMs` is exactly 10 s, and the criterion takes the `max` over steady samples. So the first steady samples still hold the rotation hitch and page load. In `m39k-iphone` attempt 1 (portrait) the 18.58 comes from t = 10-11 s; after about 17 s, p95 sits at 17.6-17.7.
2. **The driver sends nothing to the phone during a window** (screenshots and `readPage` happen outside). What does run: on the Mac, the drive loop's 250 ms tick (`drive/loop.mjs`: watchdog, `settle()`, `readEvents` of the whole log; no phone traffic). On the page, the agent's 2 s ping and `step?` (`agent/agent.js`), the 1 s `readings()` clone (`agent/driver.js`), and for M16-coexist a scripted `act('paint')` once a second (`agent/collect-life.js`). Passively, the Appium/WDA session and the attached Web Inspector session stay open (`drive/ios.mjs` `web()`).
3. An undriven iPhone round (`m39-auto`, 2026-10-04, QR) nearly passed: p95 17.62 and 17.42, 5 and 2 gaps. That comparison is confounded (Safari 27.0 against 27.0.1, a different day, one window).
4. Lighter render rungs don't help (gaps 10 → 24-29 down the ladder, GPU exec flat), and the gaps come in 15-30 s swells, not a comb.

When this is done a window's numbers come only from frames inside it, a window is quiet by construction on both sides and enforced by tests, each gap is timestamped so it can be lined up with anything else, and the orchestrator re-measures.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39f-device-auto-runner.md` Deviations (`measureWindow`, `beginMeasure`, warm-up, steady samples, criteria `source: 'steady.*'`)
3. `docs/plan/39j-device-driver.md` Deviations (drive loop, iOS backend, `web()`)

## Order of work
1. **Window-local stats (decision, recorded here).** A steady sample's rAF statistics (p95, gaps over 20 ms, hitch gaps over 25 ms, max gap) cover only frames after the warm-up ends: reset the rolling stats at the warm-up's end, or compute from a window-local ring. The HUD may keep its rolling view for people; the criteria read the window-local values. This is a correctness fix, not a loosening: a steady-state criterion must not include warm-up frames. Check every `steady.*` criterion that reads a rolling statistic (rAF, GPU exec/latency, tick, main and frame p95) and list them in Deviations. A unit test with a synthetic frame series (a 60 ms hitch at t = 9.5 s, warm-up 10 s, smooth afterwards) gives a steady p95 of the smooth frames. It is red today.
2. **Per-gap ring.** The agent records each rAF gap over 20 ms with its page time into a preallocated ring (no per-frame allocation, `.claude/rules/hot-paths.md`) and puts it in the evidence. The drive loop logs its own phone-facing calls with timestamps when `IOS_TRACE` is set, already in the same clock or converted.
3. **Quiet windows.** `beginMeasure`/`endMeasure` send start and end markers. Between them the page agent sends no ping, no `step?` and no outbox flush (it flushes at the end, inside a bounded size), and the drive loop skips its watchdog, `settle()` and log reads and waits on the end marker or a timer. Any backend call inside a window throws in tests (`backend.quiet(until)`). Leave the 1 Hz paint of M16-coexist alone: it is the item's own load, the "coexist" in its name.
4. **Tests** (each seen red on the old code): a fake backend records timestamped calls, and none falls inside a window; a call inside a window throws; a fake phone counts the agent's WebSocket frames inside a window and gets 0.

## Non-scope
Detaching Web Inspector or WDA during a window (a later brief if the re-measure still fails); render settings; the criteria limits themselves; phone runs (the orchestrator's).

## Files touched
`scripts/lib/device-walk/{agent/agent.js,agent/driver.js,agent/collect-*.js,drive/loop.mjs,drive/ios.mjs,drive/android.mjs,checks.mjs}`, their tests under `scripts/lib/`, and the fixture page HUD if the window-local stats live there (`packages/engine/tests/browser/pages/src/`).

## Exit criteria
- [x] The step 1 and step 4 tests exist, pass, and were seen red (red lines pasted). The step 1 audit of `steady.*` criteria is in Deviations.
- [x] The gap ring appears in a loopback walk's evidence (paste one), and `pnpm test:slow browser -t walk` is green (pasted line).
- [x] No golden, budget or baseline changed; `[gc]` fixture pages stay within budget.
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t device-walk` · `pnpm test:slow browser -t walk` (targeted, foreground).

## Manual device checks
After landing, the orchestrator re-runs M09b-fill-rate and M16-coexist driven on the Pixel, and on the iPhone once its passcode is off. If the iPhone still fails, the next brief compares no driver, an attached inspector and active polling, three runs each in rotated order (the diagnosis's design, in the scratchpad file named in the delegation).

## Deviations
**Seams (as built).**
- `agent.js`: `A.beginMeasure(id, n, ms?)` sends a sequenced `window` event `{phase:'start', id, n, ms}` (`ms` defaults to 12 min), then sets the quiet; `A.endMeasure()` sends `{phase:'end', id, n, interrupted}` (which flushes the queue). `quiet()` is true while `meas.on` and before `ms + 20 s`: the 2 s interval (ping, `step?`, dead-socket check), `flush()` and `postFlush()` do nothing. A hide interrupts (`meas.on = false`), which lifts the quiet. `phone-api.mjs` accepts `window` (`SEQUENCED`) and `api.onWindow(fn) -> unsubscribe`; `auto-main.mjs` passes it to `startDrive` as `onWindow`.
- Window-local rAF: preallocated `Float64Array(2048)`/`Float32Array(2048)` frame rings and a 256-entry ring of gaps over 20 ms (no allocation in `rafTick`). `A.rafWindow(fromMs, toMs?) -> {n, p50, p95, max, over20, over25}`, `A.rafGaps() -> {total, kept, origin, list: [{t, gap}]}` (`t` in ms since `beginMeasure`, `origin` the phone's `Date.now()` of that moment), `A.windowT()`. `rafReset` now also zeroes `rafLast` and sets the window origin.
- `driver.js` `measureWindow`: each sample's `raf_p50_ms/raf_p95_ms/raf_worst_ms/raf_n/raf_over20` come from `A.rafWindow(max(warmupMs, t - 10 s), t)`, plus `raf_over25`; the HUD's own values stay as `page_raf_p95_ms`, `page_raf_over20`. Window evidence gains `gaps`. A steady sample needs `t >= steadyFrom` and `raf_n >= 10`; `steadyFrom = warmupMs`, or `warmupMs + 10 s` (`opts.rollingMs`) when the window is at least 30 s past the warm-up.
- `drive/backend.mjs`: `QuietWindowError`, `withQuiet(b, {now, onViolation})`, `quiet` in `BACKEND_METHODS`; android, ios and the fake backend go through `withQuiet` (`cleanup` lifts the quiet first). `fake-backend.mjs` gains `times[]` (parallel to `calls`; `calls` itself is unchanged, existing tests deep-equal it) and `violations[]`.
- `drive/loop.mjs`: `openWindow(events, now, graceMs)`; options `onWindow`, `quietGraceMs` (3 s). In a window: `backend.quiet(until)`, one timer to `start + ms + grace` or the end marker, no watchdog, `settle()` or prompt handling; `backend.quiet(0)` after. The log is read first each pass, so a stale phone no longer triggers the watchdog inside a window. A `QuietWindowError` from a handler is logged `drive: quiet violation: ...`.
- `IOS_TRACE` lines now start `ios> @<epoch ms>`. Android is untouched (its `ANDROID_TRACE` line has no timing).
- New files: `scripts/lib/device-walk/fake-agent-page.mjs` (agent + driver in a `vm` on a virtual clock), `scripts/lib/device-walk-quiet.test.mjs` (6 tests). No existing test edited.

**Step 1 audit: every `steady.*` criterion that reads a rolling statistic.** The page's HUD rings are 10 s (`rafInterval`, `callbackDuration`, GPU, and the bench meter's tick/main/frame/sim_tick stats):
- rAF, now window-local (agent ring): `raf_p95_ms` and `raf_over20_per_10s` (M09b fill-rate and every `fillMetrics` check: M18 etc.), `raf_p50_ms`. Source: `checks.mjs` lines 62, 70, 103, 824.
- Rolling but page-side, now protected by the one-window margin on windows of 30 s or more past the warm-up: `gpu_exec_p95_ms`, `gpu_exec_p50_ms`, `gpu_latency_p95_ms` (82, 104, 106), `tick_p95_ms`, `tick_p50_ms_median`, `sim_tick_p50_ms_median`, `sim_tick_p95_ms_max`, `seal_p95_ms_max`, `frame_build_p95_ms_max`, `resync_p95_ms_max`, `catchup_ticks_per_10s`, `main_p95_ms`, `frame_p95_ms` (1542-1616: M39-large-save, M39-frame-shares). Not rolling statistics (counters or constants): `engine_mem_grows*`, `isolated`, `adapter`.
- Windows shorter than 30 s past the warm-up keep `steadyFrom = warmupMs`: the page's non-rAF rolling values still include up to 10 s before it there (no such check runs on a phone: the 60 s, 10 min windows and the 12 s unit configs are the cases).
- M39-large-save (600 s, warm-up 10 s) now takes its steady samples from t = 20 s. Pass texts, hashes and limits are unchanged.

**Evidence of the old behaviour.** `pnpm test unit -t "device-walk quiet"` on the base agent and driver: `a steady p95 holds no warm-up frame: expected 99 to be less than 17.5`, `expected 10000 to be greater than or equal to 20000`; on the pre-step-3 loop `calls to the phone inside the window: expected [ ...(3) ] to deeply equal []` and `until: condition not met in time`; on the base agent `expected [ 'reading', 'ping', 'ping', ... ] to deeply equal [ 'window' ]`.

**Slow tier.** `pnpm test:slow browser -t walk`: `browser FAIL 68 tests 133s`, two failures, both `walk-life: coexist ... low power` (chromium, webkit): `M16-low-power` result `by: 'auto'`, the test expects `'mixed'` (walk-life.spec.ts:97). The same two fail with the base `agent.js`, `driver.js`, `collect-ref.js`, `phone-api.mjs` restored (`browser FAIL 2 tests 21s`, same `by` difference), so they are not from this milestone; the 66 others pass. Needs the orchestrator.

**Loopback evidence.** `node scripts/lib/device-walk/fake-phone-run.mjs M09b-fill-rate chromium ...` (3 s windows, chromium): `[ 'M09b-fill-rate', 'pass', 'auto' ]`; `windows[0].gaps` = `{"total":0,"kept":0,"origin":1791327395778,"list":[]}` (a smooth run: a non-empty list is in the unit test), `steady` 6 samples, the round log has `window` start/end pairs (`"phase":"start",...,"ms":3000` then `"phase":"end"` 3.006 s later).

**Not done / for the next brief.** The loop's own phone-facing calls are timestamped only for iOS (`IOS_TRACE`); Android has none. The quiet wake on the end marker is wired only through `onWindow` (auto-main); without it the loop waits for the timer. No device run.
- **Gate (orchestrator):** round 1 stopped on a misread commit gate: the implementer blamed the `bench.ts` `heldD` warning, but the only error was in its own `fake-agent-page.mjs`. The two `walk-life: M16-low-power` reds the report found at base were M39m's miss: the item became `auto` when the ratio became a failable criterion, and M39m never ran the slow walk specs. The orchestrator fixed the spec (`by: 'auto'`, both ratio criteria `ok: true`): `pnpm test:slow browser -t walk-life` pass 20. `pnpm test && pnpm lint` green (unit 607, browser 256 in 45 s). The steady-start margin for windows of 30 s or more past warm-up is accepted: it keeps rolling 10 s page statistics from reading warm-up frames, without changing a limit.
- **Driven Pixel round `m39p-pixel` (orchestrator):** M09b-fill-rate pass (raf p95 16.79, over20 0, gpu exec p95 5.636, 2 windows), M16-coexist pass (600 paints, hitches 0, 10 min); no quiet-window error from the Android driver. The iPhone re-run (the finding itself) waits for its passcode to be off.
- **Driven iPhone round `m39r-iphone` (orchestrator, 2026-10-06), before Low Power Mode was left on:** M09b-fill-rate **fail** on every rung (default to `&scaleCap=1&cutoff=4`): `raf_p95_ms` 18 (limit 17.5), `raf_over20_per_10s` 13 (limit 5), `gpu_exec_p95_ms` 2.78 (limit 6, pass), 7,184 frames, max gap 29.3 ms. M16-coexist **fail** (judged): 74 rAF gaps over 25 ms in 600 paints, max 54.2 ms (Pixel 0). Quiet windows did not clear finding 5 on the iPhone; it stays open and needs a fresh diagnosis.
