# M16f: Bound the harness waits, test the `gen` yield lead, attribute the sibling-burst `main` rise

Status: not started · After: 16e · Tyler-dependent: no

## Goal

Every wait in the engine's test harness fails within a bound, with M16e's per-worker message. No
hang can end as a bare Playwright timeout again. M16e's leading candidate for a stuck worker
(`gen.ts` draining its whole request ring without checking `W_YIELD`) is proven or disproven with
a synthetic backlog. The local hardware slow tier is green again, and the `connected-terrain`
`main` rise under a sibling burst is attributed by function first.

## The evidence

- **M16e** (`docs/plan/16e-park-timeout-diagnosis.md` Deviations) instrumented `pollUntil` and the
  spin-waits and caught two real occurrences:
  - `parkWorkers` named `gen0`: its ack had caught up but its wake counter never moved.
  - A bare 30 s timeout on `gc-loop clean`, inside the M03 harness (`src/test/harness.ts`), whose
    `resume`/`park`/`hash`/`admit`/`memoryBytes`/`memGrows` waits have no time bound and whose
    `awaitAck` spin is bounded only by iteration count.
  - Its candidate, not applied as a guess-fix: `src/worker/gen.ts`'s `body()` drains the whole
    request ring in one `for (;;)` with no `W_YIELD` check.
- **Slow tier, hardware mode, local only:** `pnpm test:slow -t "connected-terrain neg burst"` fails
  3/3. The burst isolate trips correctly (40,134-80,075 B/frame). `main` reads **111.07-111.74
  B/frame against its strict hardware budget of 111** whenever a *sibling* isolate (`client`,
  `sim` or `gen0`) bursts. M16e reports the same on its base. CI's slow tier is software mode and
  green. That is the shape of M15f, where a sibling burst starved `main`'s JIT and exposed a real
  allocation (`stepSimTickSync`'s closure). **It is not known when this started.** Bisect it in a
  separate git worktree (`git worktree add`), never by checking old paths into the main tree.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/16e-park-timeout-diagnosis.md` (Deviations)
3. `docs/plan/15f-step-sim-tick-sync-allocation.md` (the sibling-burst precedent and its method)
4. the `gc-test` skill
Rules: `.claude/rules/hot-paths.md`.

## Scope
1. **Bound every harness wait** in `src/test/harness.ts` (and any other `engine/test` wait M16e
   left unbounded), failing with M16e's per-worker message format. Keep the success path
   allocation-free, prove the `gc-loop` page's controls still trip, and paste a forced timeout.
2. **Test the `gen` yield lead.** Build a synthetic backlog (many `genRequest`s queued, then
   `parkWorkers`) and measure how long `gen0` takes to park. If a long drain delays parking, add a
   `W_YIELD` check between requests, with a test that fails without it. If it does not, record the
   measurement and leave `gen.ts` alone.
3. **Attribute the `connected-terrain` sibling-burst `main` rise.** Force the budget to 1 to dump
   `windowByFn.main` for clean and for each sibling burst, and diff them. Bisect in a worktree to
   the commit where the rise appeared. Fix the allocation if it is avoidable, as M15f did. Only if
   it is inherent, re-derive with ADR 0029's check on both sides. Never widen the budget to clear it.

## Non-scope
The 10 s `pollUntil` bound, Playwright's 30 s, `budgets.json` upward, the 600-frame windows.

## Files, packages and crates touched
`packages/engine/src/test/{harness,client}.ts`, `src/worker/gen.ts` (step 2 only, if proven),
`tests/browser/**`, whatever step 3's attribution names.

## Seams
**Provides:** bounded harness waits with M16e's message format. **Consumes:** M03 harness, M04
`zeroGcSuite`, M08b gen worker, M16e message format.

## Order of work
1, 2, 3, each committed `M16f step k: …`.

## Tests added
Step 2's backlog test (if the lead holds) and whatever step 3's fix needs.

## Exit criteria
- [ ] Every `src/test/harness.ts` wait is time-bounded, with a forced timeout's message pasted.
- [ ] The `gen` yield lead is proven (fix plus failing-then-passing test) or disproven (measurement
      recorded).
- [ ] `pnpm test:slow -t "connected-terrain"` is green in hardware mode, and the cause is attributed
      in Deviations with `windowByFn` and the bisected commit.
- [ ] No `budgets.json` number raised; every zero-GC control still trips.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test:slow -t <pattern>` · `pnpm gc -t <page>` · `pnpm test browser -t <pattern>`.

## Budgets
none raised.

## Context artifacts
The `gc-test` skill, if the harness message or a debugging step changes.

## Manual device checks
none

## Deviations

### Step 1: bounding the M03 harness waits

`send()` (used by `resumeOne`/`hash`/`admit`/`memoryBytes`/`memGrows`/`messageTick`/
`markIsolates`), `parkOne` and `setupWorker` were bare `new Promise` executors with no timeout at
all -- exactly the gap M16e's own Deviations found live (`gc-loop clean`'s bare 30 s Playwright
timeout, traced to `resume()`/`park()`'s `send`/`parkOne`). Each now rejects after
`POLL_TIMEOUT_MS` (10,000 ms, matching `src/test/client.ts`'s `pollUntil`) with a per-worker
diagnostic built only in the reject branch, never the success path. The message shape reuses
M16e's own (`<what>: timed out after <n> [ms|spins] ... workers=[...]`) but names this harness's
own step-block fields (`Req`/`Ack`/`State`/`Yield`, `armed` -- `step-block.ts`), not `sab/
control.ts`'s `W_*` words: a different protocol, per M16e's own Deviations note that this file
"is not in this milestone's Files list" and carries "no `W_WAKE`/`W_YIELD`/`W_PARKED`/`W_ACK`". A
message-wait here (`send`/`setupWorker`/`parkOne`) is one `setTimeout`, not a macrotask poll, so it
has no `turns`/`longestGapMs` to report the way `pollUntil` does -- just the bound and the snapshot
at the moment it fired.

`awaitAck`'s busy-spin keeps its pre-existing `SPIN_LIMIT` (2,000,000,000 iterations) bound
unchanged (Non-scope): only its throw message gained the same per-worker detail, built with a
single `now()` read on the already-failing path -- no periodic wall-clock check anywhere on the
spin's success path, the exact lesson M16e's own CI round drew (a periodic `now()` check, even one
gated behind a coarse mask, still fires -- and boxes -- on a success path that is merely *slow*, not
stuck, and CI's software-mode strict budgets have no room for that).

**Whether the success path stays allocation-free matters differently for each wait here than it
does in `client.ts`.** `resume()`/`park()` both run *outside* `installGcPage`'s measured window
(`gc-page.ts`'s `run()`: `resume()` before `performance.mark('window-start')`, `park()` after
`'window-end'`), so their `send`/`parkOne` timers never execute inside a budgeted window at all.
`messageTick` (`send`) is the one exception -- called once per frame, *inside* the window, but only
under the `post-message` negative control, and `suite.ts`'s own `expectedVerdict` already expects
`B.main = false` there (`gc-page.ts`, "a message per frame allocates on both ends"): the one
in-window caller of the newly-timed `send` is already the one case allowed to allocate on `main`.
Verified directly: `pnpm gc -t "gc-loop"` 7/7, including `gc-loop neg post-message main<->sim` and
`gc: flat transport parity`, and `pnpm test browser` unchanged at 123/123, 18 s/25 s (matching the
base measurement `M16e done`'s own gate recorded).

**Forced-timeout messages (temporary, reverted, never committed)**, each produced by breaking the
one mechanism under test (an impossible `replyType`, or `SPIN_LIMIT` set to 5) against a real
`stepping.html` page, then reverted:

```
send('resume') to worker 'sim': timed out after 10000 ms workers=[{"name":"sim","Req":0,"Ack":0,"State":1,"Yield":0,"armed":false}]
```
```
park('sim'): timed out after 10000 ms workers=[{"name":"sim","Req":1000,"Ack":1000,"State":0,"Yield":0,"armed":true}]
```
```
harness: worker 'sim' did not ack a step (resume() first?): timed out after 6 spins (limit 5, detectedAtMs=76.1) workers=[{"name":"sim","Req":1,"Ack":0,"State":2,"Yield":0,"armed":true}]
```
(The `setupWorker` path was also forced, with `POLL_TIMEOUT_MS` briefly at 1 ms:
`harness worker 'sim' setup: timed out after 1 ms workers=[{"name":"sim","Req":0,"Ack":0,"State":0,"Yield":0,"armed":false}]`.)

`git diff` was empty at the end of each probe before moving to the next; `pnpm --filter engine
typecheck` clean throughout.

### Step 2: the `gen` yield lead -- disproven by measurement

`gen.ts`'s `body()` for-loop cannot drain an unboundedly large backlog in one call: `gen_queue.rs`'s
`take(worker)` returns `None` once that worker already has `MAX_IN_FLIGHT_PER_WORKER = 2` chunks
outstanding (`crates/engine/src/gen_queue.rs:21`), and the client's own pump (`worker/client-gen.ts`)
only ever calls `gen_take` until it returns 0 -- so no matter how large the backlog waiting in
`GenQueue::pending` is (up to 169 for the 0008 §5 view-clamp join, the game's own maximum), at most
**2** requests can ever be sitting in `genRequest[gen0]` for one worker to drain in a single wake.
`gen.ts`'s `for (;;)` loop (docs/plan/16e-park-timeout-diagnosis.md's candidate) therefore never
runs more than 2 `gen_chunk` calls before returning to check `W_YIELD` on the next wake, regardless
of total backlog size.

Measured directly (temporary probe appended to `gen.spec.ts`, run, then reverted -- never
committed, `git diff` empty afterward): one gen worker, view jumped to the full 0008 §5 view-clamp
join (169 chunks, `budget('counters.gen.genJoinChunks')`), then 60 cycles of one `stepFrame` +
`parkWorkers()` (timed with `performance.now()` immediately around the call) + `resumeWorkers()`,
sampling `parkWorkers`'s own elapsed time across the whole join-to-quiescent lifecycle:

- **Baseline** (no backlog, workers already idle): **0.090 ms**.
- **Under the full 169-chunk backlog**, sampled at all 60 points across the drain (`gen: drops 0,
  mem_grows 0, stats exact`'s own `client_gen_stats` confirmed `delivered: 169, pending: 0,
  inFlight: 0` by the end, so the whole join was exercised): **min 4.025 ms, max 5.850 ms, mean
  5.002 ms**.

The ~4-6 ms figure is consistent with `pollUntil`'s own macrotask-poll granularity (a real browser
clamps a nested `setTimeout(fn, 0)` to ~4 ms after a handful of calls), not with `gen0`'s own drain
cost -- the baseline case, which resolves on `pollUntil`'s first synchronous check with no real wait
at all, reads under a tenth of a millisecond. Nowhere close to `POLL_TIMEOUT_MS` (10,000 ms), and
nowhere close to explaining the real `gen0` `parkWorkers: timed out after 10000 ms` occurrence
M16e's Deviations recorded (whose own numbers -- `W_ACK === W_WAKE` -- already ruled out a
mid-`body()` stall for that specific occurrence, per M16e's own reading). `gen.ts` is left
unchanged, per Scope.

Verification commands run: `pnpm exec playwright test --config packages/engine/playwright.config.ts
--project chromium --grep "TEMP M16f probe" --reporter=list` (the probe itself, reverted after);
`pnpm --filter engine typecheck` clean (no diff outstanding).
