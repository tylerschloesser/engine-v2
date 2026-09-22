# M15e: the paced-tick test measures a window, not a lifetime

Status: not started · After: 15b · Tyler-dependent: no

## Goal

`poll_skips_a_spurious_tick_on_a_ring_wake` (`tests/browser/connected-paced.spec.ts`) passes on
`ubuntu-latest` as well as locally, because it measures the ticks the sim ran **during its poke
window** instead of every tick the sim has run since the worker booted — and it still fails, loudly,
when ADR 0030's `wokenBy === lastWokenBy` guard in `worker/sim.ts` is reverted. CI on `main` is green
again.

## The defect, measured by the orchestrator before this brief was written

`SimHostCounters.ticksRun` is cumulative from `simHost.start()`, which `worker/sim.ts` calls at the
end of `setup()`. The test reads it **once**, after the poke, and compares it against
`expectedTicks = pokeMs / TICK_MS` (30) — the ticks of the poke window alone. Everything the sim
ticked between worker setup and the first poke is counted too.

Measured on `main` @ `efde638`, macOS/arm64, by inserting `page.waitForTimeout(extraMs)` between
`openPage` and `__pokeFor` in a throwaway spec:

| idle inserted before the poke | `ticksRun` read after it |
|---|---|
| 0 ms | 26 |
| 1000 ms | 48 |
| 3000 ms | 86 |

One extra tick per 50 ms of pre-poke wall time — exactly the 20 Hz pacing, accruing before the
window the assertion is about. The two CI reds (79 on run `35745490470`, 83 on `35737464059`) are
that slope at ~2.5–2.8 s of runner-side page-load, wasm-instantiate and Playwright IPC latency, all
of which is ordinary for `ubuntu-latest` under SwiftShader and absent on a warm local machine (~0.3 s
there, hence 26).

**The diagnosis recorded in `PROMPT.md`'s Blockers was wrong and its reasoning was inverted.** It
read 79 as ADR 0030's spurious-tick symptom on the grounds that "a slow runner would run *fewer*
ticks, not more". A slow runner spends *longer* before the poke starts, so it accumulates *more*.
There is no evidence of a spurious-tick defect here, and nothing in `worker/sim.ts`,
`worker/atomics-timer.ts` or `server.ts` needs to change to make CI green.

Note also, measured in the same run: at 0 ms of inserted idle the poke window itself yields 26 ticks,
**below** the nominal 30. External wakes suppress polls rather than adding them (a wake changes the
wake word, so `body()` skips `poll()` for that pass, and `Atomics.wait` re-arms the full 50 ms
afterwards). The guard's direction of error is fewer ticks; a reverted guard is what adds them.

## Scope

- Make the test assert over the poke window: take a `ticksRun` reading before the poke and one after,
  and assert on the **delta**, with the existing `expectedTicks * 0.5` / `* 1.35` bounds unchanged.
- Whatever page plumbing that needs. `__simCounters` currently calls `parkWorkers(client)`, so a
  before-reading parks the workers mid-run; `resumeWorkers()` (`src/test/client.ts`) is the pair. A
  resume re-enters `runBlockingLoop`, whose entry `runBodyOnce` runs one `body()` pass with the wake
  word unchanged and therefore fires exactly one `poll()` — one extra tick in the delta, well inside
  the margin, but **say so in a comment** rather than leaving a future reader to rediscover it. If
  you find a shape that reads the counter without parking, prefer it and explain why it is sound.
- Update the file-header comment and the assertion comment so they describe what is now measured.

## Non-scope

- **Do not change `expectedTicks`, `0.5`, `1.35`, `TICK_MS`, `pokeMs` or `pokeIntervalMs`** to clear
  the red. The bound is not the problem and a widened bound would be a mask. If your corrected
  measurement does not fit these bounds, stop and report — that would be a real finding, not a
  licence to retune.
- `worker/sim.ts`, `worker/atomics-timer.ts`, `server.ts`, ADR 0030, any budget in `budgets.json`.
- The `resync()` asymmetry noted below. Record it, do not fix it.

## Files touched

`packages/engine/tests/browser/connected-paced.spec.ts`,
`packages/engine/tests/browser/pages/src/connected-paced.ts`, and `src/test/client.ts` only if a
counter read without parking needs a helper there.

## Seams

**Provides:** nothing new. **Consumes:** M15b's `connected-paced` page and `__pokeFor` /
`__simCounters`; M13's `SimHostCounters.ticksRun`; M06b's `parkWorkers` / `resumeWorkers`.

## Order of work

1. Reproduce the slope yourself before changing anything: insert `page.waitForTimeout(3000)` between
   `openPage` and the poke in the existing spec, run it, and confirm `ticksRun` lands near 86. Revert
   that edit. Paste the number you saw.
2. Change the measurement to a window delta. Commit.
3. **Prove the test can still fail.** Revert the `wokenBy === lastWokenBy` guard in `worker/sim.ts`
   to an unconditional `atomicsTimer.poll()`, run the fixed test, and record the delta it reports and
   that it fails the upper bound. Restore the guard, re-run, record the passing delta. Both numbers go
   in Deviations. **Do not commit the reverted guard.** If the reverted guard does *not* fail the
   test, that is the finding — stop and report it, because then the test proves nothing and the
   milestone is not done.
4. Run the spec 20 times locally in the foreground (`node scripts/repeat.mjs browser 20` is
   whole-suite; a targeted loop over `pnpm test browser -t poll_skips_a_spurious_tick_on_a_ring_wake`
   is what is wanted here) and report the spread of deltas, so the orchestrator can see the margin.
   Foreground, bounded, with a per-run kill timeout; no background load generators.
5. Add a row to `docs/plan/deferred-ledger.md` for the `resync()` asymmetry (below). Commit.

## The ledger row to add (record, do not fix)

`server.ts`'s `resync()` corrects the sim only when it is **behind** (`if (overshoot > 0)`); there is
no branch for running ahead. `syncBaseMs += accountedTicks * tickMs` advances by the nominal amount
regardless, so if anything ever makes `poll()` fire faster than the tick rate, the sim runs fast with
nothing pulling it back — uncorrected, not bounded at one window as ADR 0030's own text claims. Not
reachable today (the measured error is in the other direction) and not this milestone's to fix.
Candidate owner: M36b, or whichever milestone next touches pacing.

## Tests added

None. This milestone repairs the measurement inside an existing test; its evidence is step 3.

## Exit criteria

- [ ] `poll_skips_a_spurious_tick_on_a_ring_wake` asserts a poke-window delta, not a lifetime total,
      and the `0.5` / `1.35` bounds and `expectedTicks` are unchanged in the diff.
- [ ] Step 1's reproduction number and step 3's two numbers (guard reverted → fails; guard restored →
      passes) are pasted in Deviations.
- [ ] Step 4's 20 local repeats: 0 failures, with the spread of deltas reported.
- [ ] The `resync()` asymmetry has a row in `docs/plan/deferred-ledger.md`.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands

- `pnpm test browser -t poll_skips_a_spurious_tick_on_a_ring_wake`
- `pnpm test && pnpm lint` (the orchestrator runs this; you run targeted, foreground runs only)

## Budgets

None new. The `browser` suite is at 21 s of 25 s (0020 §4): this milestone must not add a test, and
the delta read must not add measurable wall time to the existing one. Report the spec's duration
before and after.

## Context artifacts

None.

## Manual device checks

None.

## Deviations

(filled in during Phase 3)
