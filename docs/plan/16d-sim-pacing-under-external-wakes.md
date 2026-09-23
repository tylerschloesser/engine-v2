# M16d: The sim keeps ticking while a client wakes it every frame

Status: done · After: 16c · Tyler-dependent: no

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
- [x] Step 1's test fails on base (pasted) and passes after the fix.
- [x] `poll_skips_a_spurious_tick_on_a_ring_wake` passes unchanged in what it asserts.
- [x] Every zero-GC page with a `sim` isolate passes at an unchanged or lower budget, and its
      controls still trip (`pnpm gc` pasted), including once under `--no-opt --no-sparkplug`.
- [x] A new ADR amends 0030.
- [x] `vertical_slice` is under 3 s in `report.json` with every assertion kept.
- [x] `node scripts/repeat.mjs browser 15 --load 10`: 0 failures, 0 hangs (orchestrator's gate).
- [x] `pnpm test` and `pnpm lint` are green.

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

### Seams provided (exact shapes)
- `CB_SIM_TICKS_RUN = 6` (`src/sab/control.ts`): the sim worker's `ticksRun`, stored by `worker/sim.ts`'s
  `body()` every pass. Global word 6 was reserved; the "6-7 reserved" comment now reads "7 reserved".
- `createAtomicsTimer(clock: Clock): AtomicsTimer` (`src/worker/atomics-timer.ts`): takes a clock again.
  `AtomicsTimer` gained `interrupt(): void`. `poll()` now means "the last wait timed out". `worker/sim.ts`:
  `if (wokenBy === lastWokenBy) atomicsTimer.poll() else atomicsTimer.interrupt()`.
- ADR: [0032](../decisions/0032-atomics-timer-bounds-external-wakes.md) (amends 0030 §2). Not done, because
  they are outside the implementer's edit list: 0030's `Status:` "Amended by" line, `PRE-PLAN.md` §1,
  `PLAN.md` "Plan-level decisions", and the root `CLAUDE.md` ADR range.
- `__sliceSettle(tileX?, tileY?)` (`slice.ts`): an optional tile was added. `__probeTile` is unchanged.
- `window.__wakeSimFor(ms, intervalMs)` (`connected-paced.ts`).

### Step 1
`sim_ticks_steadily_under_external_wakes` (`connected-paced.spec.ts`): wakes `WORKER_HOST` directly every
16 ms for 2 s and samples `CB_SIM_TICKS_RUN` at every wake. Tolerance: 4 ticks at every ~250 ms sample, and
no flat stretch longer than 120 ms (2 intervals + one wake interval + 4 ms). On base (`5de7f8c` plus the
observation word only): `samples 262ms:0 512ms:0 ... 2004ms:0; worst drift -40.1 ticks; longest flat 2004 ms`.

### Step 2 (the design differs from the brief's lead; ADR 0032 has the reasoning)
- **Clock-free crediting was built first and measured insufficient.** It credits only timed-out waits and
  quantises waits after an interruption. In Chrome, small `Atomics.wait` timeouts overshoot, so credited time
  ran at ~60 % of real time for quantum shifts 2, 3 and 4. Step 1 then read drift -9.3, -5.3 and -8.2 ticks,
  beyond resync's catch-up cap.
- **Built instead: two integer bounds.** `lo` counts proven time (timed-out waits) and `hi` estimated time
  (every wait handed out). The clock is read only when `lo < due <= hi`. Waits are capped at `ms >> 3` while
  interrupted, and the cap halves down to 1 ms on back-to-back interruptions. There is never a read on an
  uninterrupted pass (unit test: 0 reads over 40 fires).
- Step 1 after the fix, 3 runs: `40` ticks at 2 s every time, worst drift 0.3 ticks, longest flat 69-70 ms.
- `poll_skips_a_spurious_tick_on_a_ring_wake` is unchanged and passes; it reads **30** of an expected 30 (3
  runs; M15e read 26-27). **Failability re-run:** with the guard reverted to an unconditional `atomicsTimer.poll()`,
  it reads **46** and **47** against the `< 40.5` ceiling. Step 1's test also fails then, at +77.7 and +75.9
  ticks, so it catches over-ticking as well as starvation.
- Unit tests: `src/worker/atomics-timer.test.ts` (5, simulated clock). They cover producer rates from 0.25 to
  49 ms with 0 and 2 ms overshoot: never early, at most one tick short in 2 s, at most 3.5 reads per fire at
  producer intervals of 5 ms or more, and at most wakes/5 reads at any rate (measured maximum 0.18 reads per
  wake at a 0.25 ms producer).
- **Zero-GC**, `sim` isolate, budget 8 unchanged everywhere. `windowByFn` came from forcing
  `gc.pages["sim-paced"].isolates.sim` to 1 (reverted).
  - `sim-paced` under default V8: 3.83, 1.69 and 1.99 B/frame. The new site `settle@` is 372-696 B per 600
    frames (the gated `clock.now()`, ~31-58 reads). `resync` does not appear.
  - Under forced `--no-opt --no-sparkplug`: 3.05 and 3.43 B/frame, `settle@` 1332-1560 B.
  - Base `sim-paced` passed even at a forced budget of 1: its sim never ticked inside the window. The 3.73-3.81
    in its `formula` string predates M15b's guard.
  - `pnpm gc -t "(sim|sim-paced|topology|echo|connected-terrain|zero_gc_action) (clean|neg)"`: **46 passed**
    under forced `--no-opt --no-sparkplug` (the flag edit in `playwright.config.ts` was reverted; `git
    checkout` confirmed), and **46 passed** under default V8. Every `object` and `@slow` `burst` control trips.

### Step 3
- The stall fix alone took `vertical_slice` from 5.7 s to 3.68-3.73 s.
- Phase attribution: the phase-4 `tick >= 50` poll then cost 2.9 s. `__tick` reads the clock block, which
  only moves on frames with content (the tick rule's paint at ticks 0, 20, 40, ...), so it resolved at tick 60.
- The threshold is now **20** (the first tick-rule paint after genesis). The checkpoint hash assertion and
  `referenceAt100` are unchanged. Result: 1.82-1.86 s.
- **Deviation to review:** a threshold changed, no assertion dropped. It is not on the gate's mask list, but
  it is a number in the spec.

### Step 4
- **Attribution.** Diagnostics used during the investigation were not committed.
  - Under `repeat.mjs browser 8 --load 10` with step 3 in place: 2/8 fails, then 2/8 again. The failure was
    no longer M16c's post-paint read but phase 2's pre-paint GRASS read.
  - That read got `32,32,32`, the shader's `NEUTRAL_COLOR`: no indirection entry for chunk (0,0).
  - At the failing read, parked: `client_chunk_hash(0,0)` = Ok, `client_gen_stats` 37/37 delivered with 0
    pending and 0 in flight, rings drained. So the chunk was **in the client store, not on the GPU**.
  - Another settle (one more client frame) fixed it. `Uploader::on_frame`, which queues resident chunks for
    upload, runs only inside a client `frame()`, so `untilQuiescent` holds vacuously between gen delivery
    and the next frame.
  - A forced-failure run also showed a resident chunk dropping back to NEUTRAL: host snapshot replacement.
- **Fix, test page only.**
  - `slice.ts` keeps a main-side indirection mirror by wrapping `renderer.writeIndir`.
  - `__sliceSettle` cycles rAF plus drain (client ack and every ring drained, no park). It ends when no ring
    except the uplink has pushed for 5 frames and 4 sim ticks (`CB_SIM_TICKS_RUN`) and, given a tile, that
    tile's chunk is in the mirror. There is a 10 s failure ceiling that throws.
  - An intermediate version that required one quiet cycle still failed 1/8 loaded runs. One that required an
    uplink batch hung, because the uplink sends only keepalives when the camera is still.
- **Result.**
  - Loaded: `repeat.mjs browser 8 --load 10`, twice: `pass=8 fail=0 hang=0` (slowest 25 s) and `pass=8
    fail=0 hang=0` (slowest 21 s). The second batch ran at a 1-minute load average of 30: Spotlight's
    `spotlightknowledged`/`mds_stores` and Steam were running, which is not this session's load.
  - `vertical_slice` quiet: 2.32-2.65 s. Settles take ~260, ~350 and ~180 ms, and phase 4's wait for tick 20
    ~700 ms.
- **The stall and the pixel race do not share a cause.** The race is client-side upload scheduling. The
  stall fix only changed which read lost the race (phase 2 instead of phase 5), because phase 4 no longer
  spends 3 s draining everything.

### Notes for later briefs
- With a camera that has just moved, `client_poll_uplink` sent a batch about every 50 ms (`slice.html`,
  phase 5 settle). Worth checking against 0010's "send only on change".
- `untilQuiescent` (`engine/test`) has the same vacuous-quiescence hole for any page that probes GPU
  residency. Only `slice.ts` was changed here.

### Orchestrator's gate (M16d done)

- **Failability re-run by the orchestrator:** restoring step 1's `worker/sim.ts` and `atomics-timer.ts` (`5aad01c`, which already writes `CB_SIM_TICKS_RUN`, so a zero there cannot be a missing counter) gives `samples 263ms:0 ... 2011ms:0; worst drift -40.2 ticks; longest flat 2011 ms`. Restored, it passes. Deleting only the `interrupt()` call does **not** make it fail, and that is by design, not a blind spot: `settle()` reads the clock from `poll()` too once `hi` reaches the deadline, so `interrupt()` only shortens the waits after an interruption.
- `pnpm test && pnpm lint` green: `unit` 193, `browser` 117 at 18 s. `repeat.mjs browser 15 --load 10`: **15/15, slowest 28 s**; 15 quiet: **15/15, slowest 19 s**.
- Masks checked: `budgets.json` untouched, no goldens changed, and no timeout, retry, sleep or `@slow` added. `tick >= 50` -> `>= 20` accepted: phase 4 compares the checkpoint to a native replay at the tick actually reached and still asserts the tick-100 golden separately, so a threshold of 20 still covers two tick-rule writes and drops no assertion.
- The orchestrator rewrote `atomics-timer.ts`'s header comment, which still said the timer takes no clock, and did the ADR bookkeeping (0030's status line, `PLAN.md`, root `CLAUDE.md`). The three notes for later briefs went into `deferred-ledger.md`.

