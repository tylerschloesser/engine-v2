# M39q: M29-net-heap waits for the page, and an empty window can't pass

Status: done (2026-10-06) · After: 39p · Tyler-dependent: no

## Goal
Finding 6 of the driven rounds: M29-net-heap fails in every driven round with `reloads: null` while `hitch_gaps_over_25ms` reads 0. M39j's note ("the `mp.html` adapter is missing") was wrong. A read-only diagnosis (2026-10-06) found:
- `mp.ts` defines `check.act.paint` and `linkLog`, but assigns `check.act` and `check.ready` only at the foot of the page, after `await client.ready`.
- `MP.netheap` (`scripts/lib/device-walk/agent/collect-life.js`, about line 570) is the only collector that goes straight to `measureWindow` without `ready(item)` and without waiting for `link === 'online'` (compare `MP.drops`).
- Over the tunnel the agent attaches before boot finishes. The Pixel and `ios-redo` rounds threw on `check().act` undefined; `ios-full` threw `engine: dispatch before ready`.
- The thrown error became `data={error}`, so `reloads` arrived null. The hitch criterion read 0 from a window that never ran: **a criterion that passes on no measurement.**

When this is done the collector waits for the page and the link, and a run with no measured window can't pass any criterion. A loopback test makes the race fail deterministically.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39f-device-auto-runner.md` Deviations (collectors, `measureWindow`, criteria and `nullIs`)
3. `docs/plan/39n-two-devices-join.md` Deviations (the `why` shape on a failed join, and the late-`check.js` walk-ref test: the precedent for a deterministic race test)

## Scope
1. `MP.netheap` waits for `ready(item)` and then `link === 'online'`, bounded by the item's timeout. If either times out it returns `{ ready: false, why }` (the M39n `why` shape), never a hard-coded `reloads: 0`.
2. **Empty windows.** When a measuring window did not run or collected no frames, every criterion computed from it is `null` (and so fails or goes to the judge per its `nullIs`), never 0. Check this in `checks.mjs` for M29-net-heap's `hitch_gaps_over_25ms` and `reloads`, and grep the other collectors for the same pattern: a reading defaulted to 0 when nothing was measured. List each one checked in Deviations and fix any you find.
3. **Test.** A slow-tier loopback test (extend `walk-life.spec.ts`'s M29-net-heap case or add one beside it) where the page's boot is delayed past the agent's attach (`?genDelay=` if it delays `client.ready`, otherwise a test-only `page.route` delay as in M39n). It is red on the old collector (an error, `reloads` null) and green on the new. A unit test in `scripts/lib/` checks that a result with no window yields null criteria, not a pass.

## Non-scope
`mp.ts` (unchanged unless the test shows the page itself is wrong); the `pagehide` interruption that arrives after a result (noted by the diagnosis, a separate item); the 10-minute window length.

## Files touched
`scripts/lib/device-walk/agent/collect-life.js`, `scripts/lib/device-walk/checks.mjs`, their tests under `scripts/lib/`, `packages/engine/tests/browser/walk-life.spec.ts` (and `support/walk-rig.ts` if it needs a page-query override).

## Exit criteria
- [x] The race test and the unit test exist, pass, and were seen red (red lines pasted).
- [x] The empty-window audit is listed in Deviations.
- [x] `pnpm test:slow browser -t walk-life` green (pasted line); no golden, budget or baseline changed.
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t device-walk` · `pnpm test:slow browser -t walk-life` (targeted, foreground).

## Manual device checks
After landing, the orchestrator runs M29-net-heap driven on the Pixel (10 min) and on the iPhone when its passcode is off.

## Deviations
- **Seams.** `collect-life.js` `MP.netheap`: waits `ready(item)` then `readings().link === 'online'` (both bounded by `item.opts.timeoutMs`); on a timeout returns `{ ready: false, why, errors }` with no `reloads` key. `why = { ready, link, errors, url, readyState }` (the M39n shape without `ui_seen` and `failedResources`; a small local `notReadyWhy`, because `collect-ref.js` is loaded only for reference pages). `driver.js` `measureWindow`: a window with `raf.frames === 0` reports `raf.long25/long50/max = null`. `checks.mjs` reducer `sum` of no values is `null` (it was 0: `[].every(num)` is true).
- **Cause of the pass on no measurement.** Two things: the thrown error left `windows` absent, and the `sum` reducer turned an absent list into 0, so `hitch_gaps_over_25ms` read 0 and passed. Now `reloads` is null (fail) and the hitch proxy is null (judge), verdict fail.
- **Empty-window audit** (`reloads: 0` and 0-defaults in `agent/*.js`, `checks.mjs` reducers):
  - `sum` reducer (all four hitch criteria, `frames`, `device_lost_total`, `uncaptured_errors_total`): fixed, empty is null. Other reducers: `max/min/median/max-known` already null on empty; `len/count-*/any/distinct` count facts (0 is the fact) and are not hitch or reload criteria.
  - `reloads: 0` on a not-ready return, fixed (key removed): `collect-life.js` `hidden-pause`, `collect-touch.js` `gestures`, `collect-ref.js` `bench`. Each then reads null, failing a `reloads` criterion.
  - `reloads: 0` on a finished measurement (netheap, slice/world/mp collectors after their window, `memory`, `collect-ref` runs): kept; it is the fact "this document did not reload", the driver's reload path sets the real number.
  - `collect-ref.js` `dom` (`ready: !!ready`, reloads 0 after a measured observe) and `drops` (`runs: mp.accepted`): measured, kept. `collect-mac.js` sums of `l.gpu?.x || 0` over legs: GPU counters, a missing leg is reported by `legs` itself; kept. `collect-life.js:408` `bytes ?? 0` is the export-import size check, which compares it with a lower bound (0 fails it).
  - `measureWindow` itself: zero-frame window now null counts (above). `steady` is already filtered by `raf_n >= MIN_STEADY_FRAMES`, so an empty window has no steady rows.
- **Race test.** `walk-life: M29-net-heap: a page that boots after the agent attached is waited for` (`walk-life.spec.ts`): a test-only `page.route` answers every `.wasm` 8 s late. `?genDelay=` did not work: the same spec with `genDelay=15000` ran 9.8 s and passed at base (it delays only the late gen workers after Welcome, not `client.ready`). Red at base (old `collect-life.js` only), both engines: `Error: a measured value, not an error ... Expected ok: true, value: 0; Received ok: false, value: null`, `browser FAIL 2 tests 32s`. Green: `browser pass 4 tests 18s` (`-t "walk-life: M29-net-heap"`).
- **Unit test.** `scripts/lib/device-walk-netheap.test.mjs` (7 tests, vm harness of M39p). Red at base (old `collect-life.js`, `driver.js`, `checks.mjs`): `FAIL 7 tests`, among them `expected +0 to be null`, `TypeError: Cannot read properties of undefined (reading 'paint')` (the finding-6 error), `expected Object{ frames: +0, long25: +0 ...} to match object { frames: +0, long25: null, max: null }`. Green: `unit pass 212 tests` (`pnpm test unit -t device-walk`).
- **Not done.** `mp.ts` unchanged; no phone run (the orchestrator's driven Pixel/iPhone round).
- **Gate (orchestrator):** the first full run had two fast-tier reds this milestone cannot reach (`[gc] no_ui_change clean`, `reference_furnace_pick_up`; it changed only device-walk scripts and a slow spec). They passed alone 3 of 3, and the full re-run was green (unit 614, browser 256 in 44 s): the ledger's full-suite-only flake pattern. The `sum` change (empty is null) is accepted: it was the unfailable criterion.

- **Driven Pixel round `m39q-pixel` (orchestrator):** M29-net-heap pass, measured: 10 min, 2,400 paints, `reloads` 0, `hitch_gaps_over_25ms` 0, max rAF gap 17 ms.
- **Driven iPhone round `m39r-iphone` (orchestrator):** M29-net-heap ran to the end (10 min, 2,400 paints, `reloads` 0; the boot race is fixed on the iPhone) but ran after M16-low-power left Low Power Mode on (finding 8, M39u), so throttled to 30 Hz; not a valid iPhone result, re-run owed after M39u: 17,977 gaps over 25 ms. Recorded `skip`.
- **Driven iPhone round `m39u-iphone`:** M29-net-heap **pass** (judged): 10 min, 35,985 frames, p95 17 ms, reloads 0; 9 gaps over 25 ms (7 of 25-29 ms jitter, 2 single drops) in pairs about 130 s apart, left for M39v's attribution.
