# M39p: A measuring window measures only itself, and the driver keeps quiet during it

Status: not started · After: 39o · Tyler-dependent: no

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
- [ ] The step 1 and step 4 tests exist, pass, and were seen red (red lines pasted). The step 1 audit of `steady.*` criteria is in Deviations.
- [ ] The gap ring appears in a loopback walk's evidence (paste one), and `pnpm test:slow browser -t walk` is green (pasted line).
- [ ] No golden, budget or baseline changed; `[gc]` fixture pages stay within budget.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t device-walk` · `pnpm test:slow browser -t walk` (targeted, foreground).

## Manual device checks
After landing, the orchestrator re-runs M09b-fill-rate and M16-coexist driven on the Pixel, and on the iPhone once its passcode is off. If the iPhone still fails, the next brief compares no driver, an attached inspector and active polling, three runs each in rotated order (the diagnosis's design, in the scratchpad file named in the delegation).

## Deviations
(filled in during Phase 3)
