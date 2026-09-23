# 0032: `AtomicsTimer` paces between proven and estimated bounds when external wakes interrupt it

Status: Accepted (2026-09-22). Amends [0030](0030-sim-host-resync-based-pacing.md) §2 (what `AtomicsTimer.poll()`/`timeoutMs()` do) and settles 0030's Consequences item "whether a future milestone wiring a real external wake ... needs `AtomicsTimer` to distinguish a genuine timeout wake from an external one". Implemented in M16d (`docs/plan/16d-sim-pacing-under-external-wakes.md`).

## Context

0030 §2 made every wake of an armed `AtomicsTimer` fire one tick, with `timeoutMs()` always answering the fixed interval. M15b added the first external producer (a linked client's uplink ring wakes the sim worker) and guarded `poll()` with `wokenBy === lastWokenBy` in `worker/sim.ts`, so a ring wake runs no tick (`poll_skips_a_spurious_tick_on_a_ring_wake`). Together these starve the sim: every external wake restarts `Atomics.wait` with the full interval, so a producer waking more often than once per interval means no wait ever times out and no tick runs. M16c measured it on `slice.html` (tick flat at 1 for 0.4-2.9 s, then a resync burst). M16d's `sim_ticks_steadily_under_external_wakes` (wakes at ~60 Hz for 2 s) measured **0 ticks in 2004 ms** on base.

Constraints: the sim isolate's strict 8 B/frame budget ([0016](0016-zero-gc-definition.md) §1) under every V8 tier, and a `clock.now()` read boxes ~12 B (0030 Context; M15d found this is so under optimised code too).

Measured before this design, as a clock-free candidate: crediting only timed-out waits against the interval, capping waits at a quantum after an interruption, and leaving the rest to 0030's resync. In Chrome a small `Atomics.wait` timeout overshoots by roughly 2-3 ms, so the credited time ran at about **60 %** of real time at every quantum tried (3, 6 and 12 ms). Resync's catch-up cap (`MAX_CATCHUP_TICKS`, 5 per 8-tick window) cannot absorb that: drift reached -5 to -9 ticks in 2 s. Accurate pacing under frequent external wakes needs a real clock reading, so the question is how rarely one can be taken.

## Decision

**1. Two integer bounds on "now", and a deadline.** `AtomicsTimer` keeps `lo` (proven: advanced only by waits that timed out), `hi` (estimated: advanced by every wait handed out) and `due`. All three are integer milliseconds since `every()` armed the timer, with the origin rounded up, so a reading never exceeds real elapsed time. The timer fires when `lo >= due`. Then `due += ms`, or `due = lo + ms` when it is a whole interval or more behind: the timer never fires back to back to catch up, because catching up belongs to `SimHost.resync` (0030 §3).

**2. The sim body says how each wait ended.** In `worker/sim.ts`, an unchanged wake word calls `poll()` (the wait timed out: credit it to `lo`). A changed one calls the new `interrupt()` (an external wake ended the wait: credit nothing). The guard stays exactly where it was, so reverting it still means "every wake counts as a timer fire" (Consequences).

**3. The clock is read only when the bounds disagree about the deadline.** In `poll()` or `interrupt()`, when `lo < due <= hi`, the timer reads `clock.now()` once and sets both bounds to it. With no interruptions `lo === hi` and nothing is read: one full-length wait per interval, the same as 0030. `timeoutMs()` never reads the clock.

**4. A quantum while interrupted.** After an interruption, and until one whole interval passes without one, waits are capped at `ms >> 3` (6 ms at 20 Hz). The cap keeps `hi` close to real time, so the one read lands near the deadline. When two interruptions arrive with no timed-out wait between them, the quantum is halved, down to 1 ms, so a very fast producer adds little to `hi` per wake.

**5. `createAtomicsTimer(clock)` takes a `Clock` again.** It reads it once per `every()` and, while interrupted, about once per tick. The M13b signature took none.

## Alternatives rejected

- **Clock-free crediting with quanta** (Context): about 60 % pace in Chrome, beyond what resync can correct.
- **A clock read on every external wake:** `gc-sim-paced` wakes its sim on every one of its 600 measured frames, so this would cost ~12 B/frame, over budget.
- **Stop the uplink ring from waking the sim** (drain it on the next tick instead): it removes this producer only. `CB_SIM_STEP_REQ`, presence and action producers would still wake the sim, and it changes M15b's decision rather than fixing the timer.
- **A shared-memory time word written by main or a dedicated thread:** rejected in 0030 for depending on main or adding a thread; nothing here changes that.
- **Raising `MAX_CATCHUP_TICKS` or shortening `RESYNC_TICKS`:** these hide a starved timer instead of feeding it, and are M16d Non-scope.

## Consequences

- Measured (M16d Deviations): steady 40 ticks in 2 s under 60 Hz wakes (worst drift 0.3 ticks, longest flat 69 ms). On `gc-sim-paced` the only new allocation site is `settle@` (the read in §3): 1.7-3.8 B/frame for `sim` under default V8 and 3.0-3.4 B/frame under forced `--no-opt --no-sparkplug`, against a budget of 8.
- Cost in production while a producer is active: about 1-3 clock reads per tick (~12-36 B per tick), and more wakes, because waits are quantised (roughly 200-400 wakes/s instead of 20). With no producer, cost is the same as 0030.
- `poll_skips_a_spurious_tick_on_a_ring_wake` still proves the guard. With the guard reverted to an unconditional `poll()`, each external wake credits its full wait, and the test reads 46-47 ticks against the `< 40.5` ceiling, as it did in M15e.
- The timer is never early. It is late by at most one quantum plus scheduling. Long-run drift and the one-directional correction (M15e's ledger row) are still 0030's.
- Revisit if a producer outruns the 1 ms quantum floor. The read rate then rises toward about one per 5-15 wakes (unit test `atomics_timer_keeps_pace_under_frequent_external_wakes`), still never one per wake.

## Sources

- `docs/plan/16d-sim-pacing-under-external-wakes.md` Deviations (every number above, the step 1 failure on base, the failability re-run).
- `docs/plan/16c-browser-suite-time.md` Deviations, Step 1 (the stall on `slice.html`).
- `docs/plan/15e-paced-tick-measurement.md` Deviations (the original failability proof).
- MDN, `Atomics.wait()` return values `"ok"`/`"not-equal"`/`"timed-out"` (checked 2026-09-22). Not used directly: the wake-word comparison already distinguishes the cases without changing `ControlBlock.waitForWake`, whose shape `sab.wait_for_wake_shape` pins.

## Amendment (M16d CI round 3, 2026-09-23): the resync warmer boxes at most one read per resync

CI run 35839212851 (`GC_MODE=software`, `ubuntu-latest`) failed `sim clean` with `sim` at 8.64 B/frame against the strict 8. Attribution comes from the bundle CI ran (`worker-auto-DRa3yvlc.js`, byte-identical locally):
- `now@…:1241` is `systemClock.now`, called from `server.ts`'s `warm()` loop condition.
- `warm@…:1507` is that function's fractional `now + WARM_BUDGET_MS` deadline.
- This ADR's timer is not involved. `gc-sim` never arms it (no `test.pace`), and `settle@` does not appear.

The cost was [0030](0030-sim-host-resync-based-pacing.md) §3's resync warmer:
- Every resync boxed its own read plus a second value: the loop-condition read or the fractional deadline.
- Every chunk actually warmed boxed one more read.
- On a slower runner the warming backlog still ran inside the measured windows, and the other window carried a one-off 5 KB `scope.onmessage` lump.

Reproduced locally under `--load 10` with software mode and forced `--no-opt --no-sparkplug`: the same `now@`/`warm@`/`simWarmOne@` sites in window 1 only.

**Decision (amends 0030 §3's warmer line).**
- `resync` floors its one reading, so every derived value (`elapsed`, `overshoot`, `behindTicks` by exact integer division) stays a Smi.
- `warm(nowMs)` warms its first chunk on that reading instead of re-reading the clock. It keeps an integer deadline and reads the clock again only after a chunk has actually been warmed, to police 0008 §2's 2 ms budget.
- A window that ran catch-up ticks skips warming, since its idle time was spent on ticks.

So a resync with nothing to warm costs exactly one box, and each chunk warmed costs one more. That cost is proportional to work done, not to elapsed time.

Measured (quiet; software mode with forced `--no-opt --no-sparkplug`; `sim` B/frame, before → after):

| page | before | after |
|---|---|---|
| `sim` | 3.83, 3.83 | 2.31, 2.33 |
| `connected-terrain` | 7.33, 7.63 | 5.83, 5.85 |
| `zero_gc_action` | 7.85, 7.83 | 6.35, 6.35 |
| `sim-paced` | 1.36, 2.68 | 2.11, 2.15 |
| `topology`, `echo` | < 1 | < 1 |

`resync@` went from 1800 to 900 B per window on `sim`, one box per resync. Under `--load 10` in the same mode: `sim` 2.33 (was 3.79), `connected-terrain` 5.85 (was 7.31), `zero_gc_action` 6.35 (was 7.81). No budget changed.

**Residual, recorded rather than fixed:**
- On `sim-paced`, this ADR's own read (`settle@`, §3) happens about once per tick of *real* time while the page wakes the sim every frame. It is therefore a per-time cost measured against a per-frame ceiling, like 0030's resync read on any paced page. It measured 0.4-2.2 B/frame here.
- It has headroom but no bound independent of window duration. An integer clock source without a `HeapNumber` does not exist in JS (0030 Alternatives rejected). Revisit if a slower runner pushes `sim-paced` toward 8.
