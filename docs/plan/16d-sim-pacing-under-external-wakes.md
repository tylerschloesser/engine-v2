# M16d: The sim keeps ticking while a client wakes it every frame

Status: not started · After: 16c · Tyler-dependent: no

## Goal

A production sim worker linked to a continuously rendering client ticks steadily at its tick rate:
no multi-second stall followed by a catch-up burst. A committed test fails if ring wakes can starve
the timer again. The sim isolate keeps its strict zero-GC budget. With the stall gone,
`vertical_slice` drops under 0020 §4's 3 s, and its pixel probe is proven independent of elapsed
time.

## The defect, found by M16c's attribution and confirmed in source by the orchestrator

`docs/plan/16c-browser-suite-time.md` Deviations, Step 1: on `slice.html` (a real production page,
the one Tyler's M16 device check opens), `tick` sits at exactly **1** for 0.4-2.9 s after boot,
then jumps to 60-66 in one resync catch-up. That stall is 85-90 % of `vertical_slice`'s 5.7 s.

The mechanism, read from source rather than inferred:
- `worker/atomics-timer.ts`: since M13b (ADR 0030), `timeoutMs()` returns the **fixed** armed
  interval, not the time left until the next deadline, and `poll()` fires unconditionally.
- `worker/shell.ts` `runBlockingLoop`: every wake restarts `Atomics.wait` with that full interval.
- `worker/sim.ts` `body`: `if (wokenBy === lastWokenBy) atomicsTimer.poll()`, so a ring wake never
  ticks. That is correct: it is what stops a ring wake from running a spurious tick
  (`poll_skips_a_spurious_tick_on_a_ring_wake`).
- So **any producer that wakes the sim worker more often than once per tick interval (a linked
  client's uplink every frame, later presence and actions) keeps `Atomics.wait` from ever timing
  out, and no tick runs until a gap opens.** `server.ts`'s `resync()` then runs the missing ticks
  back to back. Tick timing is wrong, even though the tick count eventually catches up.

This is ADR 0030's design meeting its first continuously waking producer. The ledger row "`AtomicsTimer.poll()` can be starved" (`deferred-ledger.md`, from M16) is this milestone's.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0030-sim-host-resync-based-pacing.md` (all)
3. `docs/decisions/0010-rates-and-subscriptions.md` (tick rate and tick budget)
4. `docs/plan/13b-tick-timing-allocation.md` Deviations (why the clock reads were removed:
   `performance.now()` boxes ~12 B per read in the interpreter tier against the sim's strict 8
   B/frame), and `docs/plan/16c-browser-suite-time.md` Deviations Steps 1-2.
Rules that apply: `.claude/rules/hot-paths.md`.

## Scope

1. **A failing test first.** Drive the real sim worker body (or `AtomicsTimer` + `runBlockingLoop`
   in the `wasm`/`unit` harness, whichever is closest to production) with external wakes at ~60
   Hz for ~2 s. Assert that ticks advance steadily: the tick count at every ~250 ms sample is within
   a stated tolerance of elapsed time × tick rate, and never flat for longer than ~2 tick
   intervals. It must fail on base. Paste the failure.
2. **Fix it without allocating per wake.** The design is yours, but record it as a new ADR amending
   0030 (`write-adr` skill). Constraints: `poll_skips_a_spurious_tick_on_a_ring_wake` stays green
   and meaningful (a ring wake must still not add a tick); the `sim` isolate's strict zero-GC
   budget holds on every page that has one (`gc-sim`, `gc-sim-paced`, `connected-*`,
   `zero_gc_action`), including under forced `--no-opt --no-sparkplug` (the `gc-test` skill; revert
   that flag edit afterwards, it is a diagnostic). Any clock read you add must be justified by a
   measured `windowByFn`. Note that `Atomics.wait` returns `"timed-out"` or `"ok"` (interned
   strings, which do not allocate) and that `waitForWake` currently discards it. That is a lead,
   not a prescribed fix.
3. **Shrink `vertical_slice` under 3 s** now that the stall is gone. Keep every phase's assertion,
   `TOL`, the pre-paint `GRASS` read, `__probeTile` and `__sliceSettle`.
4. **Prove the pixel probe is time-independent.** M16c found that resolving phase 4 sooner brought
   back `expectPixel(8, 8) channel r: got 34, want 30` (post-paint WATER read seeing GRASS) in 2/8
   loaded suite runs. So `__sliceSettle` + `__probeTile` pass partly *because* time elapses, which
   is this repo's signature defect. Attribute it before fixing: at the failing read, is the chunk's
   overlay in the client store, uploaded to the GPU, or neither? Then make the wait be on the real
   event. `node scripts/repeat.mjs browser 8 --load 10` is the command that reproduces it; the 30
   sequential single-test runs M16c tried never did.

## Non-scope
Changing tick rate, `RESYNC_TICKS`, the 600-frame windows, any `budgets.json` number upward, the
`parkWorkers` timeout, or `slice.html`'s render cadence (Tyler's device check uses that page as
it is).

## Files, packages and crates touched
`packages/engine/src/worker/{sim,atomics-timer,shell}.ts`, `src/sab/control.ts`, `src/server.ts`,
their tests; `tests/browser/**` (`vertical-slice.spec.ts`, `pages/src/slice.ts`, new test page if
needed); a new ADR.

## Seams
**Provides:** whatever the ADR names (record exact shapes in Deviations). **Consumes:** M13
`AtomicsTimer`, `SimHost`; M13b `RESYNC_TICKS`, `resync`; M15b `RingConnection.drainUplink`;
M16 `__sliceSettle`, `__probeTile`.

## Order of work
Scope 1, 2, 3, 4, each committed `M16d step k: …`. Step 4 may show the pixel race and the stall
share a cause. Say so if it does, but prove it with the step 1 test and a loaded repeat, not by
inference.

## Tests added
Step 1's steady-tick test (name it in Deviations); any step 4 regression test.

## Exit criteria
- [ ] Step 1's test fails on base (pasted) and passes after the fix.
- [ ] `poll_skips_a_spurious_tick_on_a_ring_wake` passes unchanged in what it asserts.
- [ ] Every zero-GC page with a `sim` isolate passes at an unchanged or lower budget, and its
      controls still trip (`pnpm gc` pasted), including once under `--no-opt --no-sparkplug`.
- [ ] A new ADR amends 0030.
- [ ] `vertical_slice` is under 3 s in `report.json` with every assertion kept.
- [ ] `node scripts/repeat.mjs browser 15 --load 10`: 0 failures, 0 hangs (orchestrator's gate).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test unit|wasm|browser -t <pattern>` · `pnpm gc -t <page>` ·
`node scripts/repeat.mjs browser <n> [--load 10]` (in the foreground, bounded; no background load
generators).

## Budgets
0010 tick rate; 0016 strict `sim` 8 B/frame; 0020 §4 browser p95 ≤ 3 s.

## Context artifacts
Update `packages/engine/CLAUDE.md` or the `gc-test` skill only if a stated pacing fact changes.

## Manual device checks
none (M16's device check covers `slice.html`'s advancing tick).

## Deviations
(filled in during Phase 3)
