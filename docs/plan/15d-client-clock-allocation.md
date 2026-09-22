# M15d: The client's per-frame clock read, off the main-thread hot path

Status: not started · After: 15b · Tyler-dependent: no (acts on `questions-for-tyler.md` Q13's recommended default)

Written by the orchestrator at M15b's gate. This is M13b's fix applied to the isolate M13b did not
touch, and it is now blocking rather than cosmetic: see "Why now" below.

## Goal
`client.ts` stops reading the wall clock on the per-frame path of the `main` isolate. Every zero-GC
page's `main` reading drops by the ~11.96 B/frame that read currently costs in the interpreter tier,
`gc-sim-paced` stops failing intermittently, and the budgets that were sized around the old cost are
**re-derived downward** rather than left slack.

## Why now
M13b recorded this cost and deliberately left it: "`client.ts`'s `now()` costs ~11.94 B/frame on
`main` in the interpreter tier -- the same defect class M13b fixed on the sim worker, quietly
absorbed by every page's `main` budget since 0028's re-derivation, and a candidate milestone of its
own." Three measurements since then have turned "candidate" into "blocking":
- At M15's gate, `[gc] sim-paced clean` and `[gc] sim-paced neg object sim` failed **1 run in 6
  under `--load 10`**, with `main` raw ~33.5 against its hardware budget of 30 and **11.96 B/frame
  attributed to `now@client-*.js`**. Confirmed pre-existing: the same rate on M15's base commit
  `ebea2a3`, and M15 changed zero TS/JS.
- At M15b's gate, with the suite grown from 98 to 103 tests, the same failure reached **7 runs in 15
  with no injected load at all** (5 of them `sim-paced clean`; no `connected*` test ever failed).
- M15c adds another zero-GC page, which raises the concurrency that provokes it again.

A gate that is red roughly half the time cannot certify anything, and **the remedy must not be a
budget**: ADR 0029 makes a budget that stops a negative control tripping the exact failure mode to
avoid, and `main`'s figure was deliberately held at 30 by M13b for that reason.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0030-sim-host-resync-based-pacing.md` (the same defect solved on the sim worker:
   what worked, and the two measured rejections that must not be re-litigated)
3. `docs/decisions/0016-zero-gc-definition.md` (§1, §3) and `docs/decisions/0028-zero-gc-two-measured-windows.md`
   (the two-window rule and how every `main` budget was re-derived)
4. `docs/decisions/0029-zero-gc-software-mode-attribution.md` (attribution nests inside the root;
   never widen a root or relax a budget to make a control behave)

Also read `docs/plan/13b-tick-timing-allocation.md`'s **Deviations** (the measured numbers and the
seam shapes of the sim-side fix). Rules: `.claude/rules/hot-paths.md`.

## Scope
- Find **every** wall-clock read on the `main` isolate's per-frame path in `packages/engine/src/`
  (`client.ts` is the known one; do not assume it is the only one -- attribute first, then fix).
- Remove them from the per-frame path. 0030's sim-side answer was to read once every `RESYNC_TICKS`
  and use integer arithmetic between reads; the client's frame path has a different shape (it is
  driven by rAF or by `stepFrame`, and a timestamp is often already in hand), so **pick the shape
  that fits and say why in Deviations**. If a rAF timestamp argument is already available, prefer it
  to a fresh `performance.now()` call -- but *measure* that it does not box in the same way rather
  than assuming.
- **Re-derive downward** every zero-GC budget that was sized to absorb this cost, the way ADR 0028
  re-derived them after the last instrument correction. A fix that leaves the old slack in place
  hides the next regression of the same kind.
- Prove the fix under the forced-interpreter condition, not only the optimised one:
  `--js-flags=--no-opt --no-sparkplug` on the `gc` project, which is how M13b's equivalent was
  proven (and how the original defect was made reproducible on demand).

## Non-scope
The sim worker (M13b, done). The **other** open intermittent red -- `sim neg burst main`/`burst sim`
on `gc-sim`, where `main` attributes 28 against a software budget of 0 -- is a different phenomenon
whose leading hypothesis is the M06b sibling-isolate nudge; do not conflate the two, and do not
"fix" it here. If this milestone's fix happens to change that page's numbers, report it as a
measurement, do not chase it.

## Files, packages and crates touched
`packages/engine/src` (`client.ts` and whatever else attribution names), `packages/engine/budgets.json`.

## Seams
**Provides:** no new public API expected. If the fix changes an `engine/test` or `ClientOptions`
shape, name it exactly in Deviations -- M15c and M16 both build on this file.
**Consumes:** M04 zero-GC harness, `pnpm gc <software|flat|reliability>`, the `gc-test` skill;
M13b's `gc-sim-paced` page; ADR 0028's two-window assertion.

## Planning decisions
- **Two mechanisms are already measured and rejected; do not re-litigate them** (0030): a
  WASM-imported clock still allocated 7.98 B/tick, because its glue is ordinary JS; and
  `Math.trunc()` does not help, because the box happens at the native call's return boundary, not at
  the arithmetic.
- **A budget may go down in this milestone, never up.** If some page's `main` cannot meet a
  re-derived figure, that is a finding to report, not a number to raise.
- **The negative controls must still trip.** M13b's own trap is the precedent: a margin wide enough
  to swallow the `object` control's 16 B/frame made the control measure 0/8 trips, and the
  implementer caught it and narrowed the margin instead. Verify controls still trip after every
  budget change.

## Order of work
1. Attribute: `windowByFn` on `gc-sim-paced` and the other pages, forced-interpreter, to list every
   per-frame clock read on `main` by function and byte cost. 2. Fix. 3. Re-derive budgets downward,
   verifying controls still trip. 4. Repeat evidence.

## Tests added
No new page. The evidence is: `gc-sim-paced`'s `main` reading before and after (optimised and
forced-interpreter); `byFn` no longer naming any `now@`-shaped frame on `main`; every existing
zero-GC page still green with its re-derived budget; every negative control still tripping.

## Exit criteria
- [ ] Attribution table: every per-frame `main` clock read, its function and its B/frame, before and after.
- [ ] `byFn` for `main` on `gc-sim-paced` names no clock read after the fix, forced-interpreter included.
- [ ] Budgets re-derived downward where the old figure absorbed this cost, with each new number's derivation stated.
- [ ] Every zero-GC negative control still trips (paste the trip counts).
- [ ] `node scripts/repeat.mjs browser 15` is **15/15** with no injected load, and the `sim-paced` failures are gone.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm gc software` · `pnpm gc flat` · `pnpm test browser -t sim-paced` · `node scripts/repeat.mjs browser 15` · `pnpm lint`.

## Budgets
`budgets.json` `gc.pages.*.isolates.main.bytesPerFrame` rows, revised downward. No row goes up.

## Context artifacts
If the fix establishes a rule for clock access on the client frame path, state it in
`packages/engine/src/CLAUDE.md` in one or two lines.

## Manual device checks
none

## Deviations

### Step 1: attribution (before)

Forced-interpreter (`--js-flags=--no-opt --no-sparkplug`, temporary edit to `playwright.config.ts`'s
`gc` project, reverted after each measurement session): `sim-paced clean` read `main` at
33.4-33.5 B/frame against budget 30, `attributedBytesPerFrame.main` 11.94-11.96, `byFn.main`'s
dominant entry `stepFrame@client-*.js:162` at 7164-7200 B / 600 frames -- `src/test/client.ts`'s
`stepFrame` (`h.cameraState.frameTimeMs = clockLike.now()`), the only per-frame wall-clock read
`gc-sim-paced`'s `main` isolate makes (it is the one zero-GC page whose `test.clock` defaults to
the real `systemClock` *and* whose `drive()` is `installGcPage`'s default, i.e. calls `stepFrame`).

Sweeping the other 7 zero-GC pages under the same forced condition (temporary
`budgets.json` main-row zero-outs, reverted after each read) found no other page currently exercises
this exact site with a real clock -- `echo`'s `drive()` never calls `stepFrame`; `gc-sim`'s custom
`drive()` calls only `stepSimTickSync`; `topology`/`gen`/`terrain`/`input`/`gc-loop` all inject a
`ManualClock` for `test.clock`, so their own `stepFrame`/`harness.stepFrame` calls read a fake
clock, not `performance.now()`. Two *different* findings turned up on that same sweep, neither a
wall-clock read, neither fixed here (below).

### Step 2: fix, round 1 (superseded in part)

`clock.ts`'s `createResyncingClock(clock, resyncEvery)`: reads the real clock once every
`resyncEvery` calls, does integer arithmetic (`Math.floor`) between reads, corrects to the real
elapsed time at each resync -- the same shape as `SimHost.resync()` (0030), applied to a frame path
instead of a tick path. Wired into `test/client.ts`'s `stepFrame` (`RESYNC_FRAMES = 30`) and, in
round 1, into `frame-loop.ts`'s production `tick()` too, using a nominal `FRAME_MS = 1000/60`
between resyncs since `tick()` took no `dtMs` argument.

**`RESYNC_FRAMES` is 30, not 0030's own `RESYNC_TICKS = 8`.** Measured (both `--repeat-each 8`,
`playwright test --project gc --grep "sim-paced clean" --workers 1`, this machine): with
`RESYNC_FRAMES = 8`, default-V8 clean read 22.93-22.99 B/frame (`next@client-*.js` attributing
900 B / 600 frames = 1.5 B/frame), which would have required raising `sim-paced`'s `main` budget
from 30 to 31 (`ceil(22.99) + 8 = 31`) -- the brief forbids that. Unlike 0030's own finding (its
sim-worker read cost ~11.92 B only in the interpreter tier), **this box costs ~12 B per *read*
regardless of V8 tier**: the same ~12 B/read total showed up whether `next()` ran under forced
`--no-opt --no-sparkplug` or under default/optimised V8, once the read moved into
`createResyncingClock`'s own closure-captured accumulator instead of a direct property store (the
shape the *original* unfixed code had, which V8's optimiser could apparently eliminate entirely
once warm -- the intermittency in "Why now" is exactly that: sometimes V8 wins that race, sometimes
it does not). `RESYNC_FRAMES = 30` amortises the same ~12 B/read to ~0.4 B/frame (20 real reads over
600 frames), measured: 21.83-21.89 B/frame default V8, 21.85-21.89 B/frame forced-interpreter --
the two tiers now read the same, and `ceil(21.89) + 8 = 30`, unchanged from the existing budget.

### Step 2: fix, round 2 (coordinator correction, accepted)

Round 1's use of a nominal `FRAME_MS` on `frame-loop.ts`'s production `tick()` was wrong:
`cameraState.frameTimeMs` is not a delta, it is a **timestamp**, copied into the camera block and
read Rust-side as `camera.frame_time_ms` by both `Instance::frame` and `client_poll_uplink`
(`crates/engine/src/abi/mod.rs`), which drive `ClientCore::poll_uplink`'s 50 ms uplink rate limit
and 1 s keep-alive (0010 "Rates", M15). A nominal 60 fps advances that clock at the wrong *rate* on
any other real refresh rate -- roughly 2x at 120 Hz, 0.5x at 30 Hz, snapping back to real time at
every resync -- which is exactly the device-check class of bug this milestone must not introduce
(Tyler's own device checks run on a phone, not a 60 Hz desktop).

The actual fix needs no clock read at all on the production path: `Scheduler.requestFrame(cb:
(tMs: number) => void)` (`clock.ts`) already delivers a real `DOMHighResTimeStamp` to its callback,
and `systemScheduler.requestFrame = (cb) => requestAnimationFrame(cb)` means that argument *is*
`requestAnimationFrame`'s own timestamp. `frame-loop.ts`'s `frame(tMs)` now forwards it to
`tick(tMs)`, which assigns `tMs` straight to `cameraState.frameTimeMs` -- no `clock.now()` call,
so nothing to box, stronger than amortising a read. `createResyncingClock` stays wired into
`tick()` only as the fallback for a caller with no `tMs` in hand (a direct manual `tick()` call --
`engine/test`, `frame-loop.test.ts`'s fakes-only unit tests); it is otherwise unchanged and remains
the real fix for `test/client.ts`'s `stepFrame`, which owns its own clock and has no rAF-delivered
timestamp to borrow.

**Measured, not assumed, that assigning the already-in-hand double allocates nothing**: no
committed zero-GC page runs a real `FrameLoop` (`createRealFrameLoop`), so this could not be
measured the same way as `stepFrame`. A temporary, session-only diagnostic spec
(`gc-tmp-measure.spec.ts`, deleted before this milestone's commit, never part of any suite) opened
`device.html` -- the one production page running `createRealFrameLoop` against real
`systemClock`/`systemScheduler` (real `requestAnimationFrame`) -- attached a CDP `HeapProfiler`
sampling session (`samplingInterval: 1`, matching 0016 §3's own instrument), ran for 3 real
seconds, and summed the resulting profile (`gc/analyse.ts`'s own `sumProfile`). Result: `byFn`
contains no `tick@frame-loop` entry and no clock-read entry at all -- the top sites are
`push@:0` 9024 B, `(anonymous)@device` 2324 B, `drain@terrain` 1624 B, `integrate@client` 940 B,
`applyPending@frame-loop:107` 848 B (M09b's viewport path, a different line, unrelated to this
fix) and three smaller ones. Assigning `tMs` is invisible to the sampler.

### Budgets re-derived

- `gc.pages["sim-paced"].isolates.main.bytesPerFrame`: **30 -> 30**, unchanged. `ceil(21.89) + 8 =
  30` (measured clean, 8 runs, default V8 and forced-interpreter alike -- both tiers read the same
  after the fix). `RESYNC_FRAMES = 30` was chosen specifically so this figure would not need to
  rise.
- `gc.pages["sim-paced"].software.isolates.main.attributedBytesPerFrame`: **14 -> 9**. Measured
  (`GC_MODE=software`, `--repeat-each 8`): 0.38-0.40 B/frame attributed, clean. M13b's original
  landing of this row used an ad hoc +2 B margin (`ceil(11.98) + 2 = 14`) because the ordinary
  +8 B convention collided with the `object` control's own attributed 16 B/frame. With clean now at
  0.40, the ordinary 0016 §1 margin applies without collision: `ceil(0.40) + 8 = 9`.
- No other page's `main` row changed: none of them carries this cost (Step 1).

### Controls verified tripping

Hardware mode: `pnpm gc reliability -t sim-paced` (clean x50 within the run, every negative control
x15) -- **60/60 passed**, i.e. every control tripped every time. A direct `--repeat-each 8` of all
four `sim-paced neg *` controls: **32/32**. Software mode: `GC_MODE=software`, `--repeat-each 15`,
clean plus all four controls: **75/75**.

### Exit-criterion evidence

`node scripts/repeat.mjs browser 15`, foreground, no injected load, against the final tree (both
fix rounds committed): `browser x15 load=0: pass=15 fail=0 hang=0 slowestSuiteSeconds=20`.

### Findings reported, not chased (Non-scope)

1. **`src/test/manual-clock.ts`'s `ManualClock.frame()`/`.advance()`** box a fresh `HeapNumber` on
   their own `now += ms` update, ~12 B/frame, on every page whose `test.clock` is a `ManualClock`
   (`gc-loop` via `.frame()`; `topology`/`gen`/`terrain`/`input` in their `gc-*` forms via
   `.advance()` inside `stepFrame`). Same defect class as this milestone's own fix, currently
   absorbed by those pages' larger budgets, never causing a red test. Not a wall-clock read (no
   `performance.now()` involved), so out of this milestone's Scope; a candidate for a future
   milestone of its own, same shape as this one.
2. **`gc-sim`'s own `main`** (via `test/client.ts`'s `stepSimTickSync`, `gc-sim.ts`'s custom
   `drive()`) reads 28 B/frame under forced interpreter, attributed to `stepSimTickSync`'s own
   `Atomics.add`/`Atomics.load` calls -- an Atomics-related box, not a clock read. Currently passes
   because `sim`'s budget (30) happens to cover it under default V8; flagged for a future look, not
   fixed here.

### Non-scope respected

`gc-sim`'s own `neg burst main`/`neg burst sim` (the M06b sibling-isolate nudge) was run 12x
(`--repeat-each 6`) during verification and passed every time in this session -- not chased, not
touched, reported as a measurement only, per the brief's own Non-scope.
