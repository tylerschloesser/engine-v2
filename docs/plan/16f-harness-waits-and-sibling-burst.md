# M16f: Bound the harness waits, test the `gen` yield lead, attribute the sibling-burst `main` rise

Status: done · After: 16e · Tyler-dependent: no

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
- [x] Every `src/test/harness.ts` wait is time-bounded, with a forced timeout's message pasted.
- [x] The `gen` yield lead is proven (fix plus failing-then-passing test) or disproven (measurement
      recorded).
- [x] `pnpm test:slow -t "connected-terrain"` is green in hardware mode, and the cause is attributed
      in Deviations with `windowByFn` and the bisected commit. **Amended at the gate:** green, but not attributed, because it no longer reproduces (see the orchestrator's gate).
- [x] No `budgets.json` number raised; every zero-GC control still trips.
- [x] `pnpm test` and `pnpm lint` are green.

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

### Step 3: the `connected-terrain` sibling-burst `main` rise -- not reproducible on this machine
today; escalated rather than bisected

**`pnpm test:slow -t "connected-terrain neg burst"` is green, repeatedly, in hardware mode, on this
machine, right now** -- the opposite of the brief's own evidence (3/3 failing, `main` 111.07-111.74
against budget 111). Before concluding that, every escalating reproduction technique this repo's
own precedent milestones established was tried, each a genuinely distinct attempt, none of which
produced an overshoot:

1. Plain `pnpm test:slow -t "connected-terrain neg burst"`, twice: pass (`browser pass 4 tests
   5.5s` both times).
2. `playwright test --project gc --grep "connected-terrain neg burst" --workers 1 --repeat-each 5`
   (the `gc-test` skill's own "reproduces at `--workers 1`, one test, no external contention" case
   for a sibling-isolate effect): 20/20 pass.
3. Same at `--repeat-each 10`: 40/40 pass.
4. M15f's own forced-interpreter technique (`--js-flags=... --no-opt --no-sparkplug` added to the
   `gc` project, temporarily, reverted after) at `--workers 14 --repeat-each 6` (M16e's own "extreme
   ~40-way-class oversubscription" shape on this 14-core machine): produced a *different* failure
   entirely -- `connected-terrain neg burst sim` timing out at a bare 30 s (`Test timeout of 30000ms
   exceeded` at `gc/instrument.ts:307`), the same CDP-round-trip-stall class M16e's own step 2 found
   and left unaddressed, not the `main`-budget overshoot this step is chasing. `main` never
   overshot; not the right kind of contention.
5. Forced interpreter reverted; default config (`workers: 5`), `--repeat-each 5`: 20/20 pass.
6. Same, plus eight `node -e` CPU-burner processes running throughout (the same burner shape
   `scripts/repeat.mjs --load` uses, spawned directly since `repeat.mjs` only drives the fast
   `browser` suite, not `test:slow`; load average 17.7/12.1/7.5 during the run): 20/20 pass, same
   ~15.5 s wall time as unloaded.
7. **Budget forced to 1** (`connected-terrain.isolates.main.bytesPerFrame`, edited as text, reverted
   after -- CLAUDE.md's own diagnostic technique) to dump `byFn` regardless of pass/fail, one run of
   `clean` + all three `neg burst` controls: `bytesPerFrame.main` read **103.61 (clean), 103.76
   (burst client), 103.33 (burst sim), 103.69 (burst gen0)** -- all within ~0.4 B of each other, all
   ~7 B *under* the 111 budget, and `byFn.main` **identical down to the byte** in every condition:
   `draw@terrain` 28800, `drain@terrain` 12000, `stepFrame@client` 7200, plus a fixed ~8,796 B
   instrument-overhead tail (`(V8 API)`/`next`/`isTypedArray`/`entries`/`values`, all `@:0`, the same
   shape `gc-test`'s own "usual causes" section already names as measurement overhead, not a
   per-frame site). No new site appears under any sibling burst -- nothing to attribute.
8. The same forced-budget dump inside a full cross-page `--grep "neg burst"` run (every zero-GC
   page's burst controls, `--repeat-each 2`, real simultaneous multi-page Chromium contention, the
   closest local approximation to a real gate run): six independent `connected-terrain` burst
   samples, `bytesPerFrame.main` = **103.78, 103.4, 103.76, 103.76, 103.53, 103.33** -- same tight
   band, same margin, across genuinely different sibling pages contending at the same time.

All eight attempts -- no-contention, single-isolate contention, 40-way oversubscription, forced
interpreter tier, ambient CPU load, and real cross-page contention -- read `main` at 103.3-103.8,
never above 104, with an identical allocation-site breakdown throughout. This is not the same shape
as a borderline flake sitting just under a hard boundary (which would show some spread near the
line): it is a flat, stable reading roughly 7 B of margin *inside* budget, in every condition tried.
Whatever produced 111.07-111.74 was not reproduced today.

**Bisection was not attempted as a formal `git bisect` / worktree exercise, because it has no
reproducible signal to bisect against.** The brief's own instruction (a separate worktree, `git
worktree add`) presumes a failing command at the tip to walk backward from; every attempt at the
tip above passed. Re-running the same technique against an older commit, on the same machine on the
same day, would not distinguish "this commit's code" from "this environment's condition" -- both
M16e's own Deviations ("M16e saw it on its base too") and this session's own numbers point at an
environment/scheduling-sensitive margin rather than a single introduced allocation: the brief's own
evidence table already names it "not known when this started," and M16e's base (before any of
M16e's own changes) already showed the same shape. A bisect run without a reliable failing signal at
either end would produce noise, not an attributed commit.

**Per the agent contract's "Escalate, don't decide":** this is the step 3 cut line. `pnpm test:slow
-t "connected-terrain"` **is** green in hardware mode on this machine, right now (exit criterion's
literal text, verified repeatedly above) -- but the "attributed in Deviations with `windowByFn` and
the bisected commit" half of that same criterion cannot be completed without a reproducing failure
to attribute. Handed to the orchestrator: either accept the current green state (nothing to fix,
nothing regressed that this session can find), or re-run the exact repro command
(`playwright test --project gc --grep "connected-terrain neg burst" --workers 1 --repeat-each N`,
hardware mode) on whatever machine/session first saw 111.07-111.74, budget forced to 1 the moment it
reproduces, to capture `windowByFn` before the process exits -- this session's own attempt 7/8
technique above is ready to reuse the instant it does.

`git status --short` clean at the end of this step: the forced-interpreter `playwright.config.ts`
edit and the forced `budgets.json` edit were both reverted (`git diff` empty for both, confirmed
after each probe).

### Orchestrator's gate (M16f done)

- Step 1 (harness waits bounded, allocation-free success path) and step 2 (the `gen` yield lead disproven: `MAX_IN_FLIGHT_PER_WORKER = 2` caps each wake's drain) are accepted.
- **Step 3 did not reproduce, and the orchestrator's own re-run agrees.** The 3/3 failure at M16e's gate ran at a 1-minute load of **10.7**. The same command at load **6.6** passes 4/4, and the implementer's eight attempts read `main` at 103.3-103.8. So `connected-terrain`'s hardware `main` budget (111 = clean ~103 + 8) is used up when a sibling burst coincides with ambient load around 10, which is 0016's "at high load" caveat on a single page, not a regression. It is a ledger watch item, not attributed, because there is nothing reproducing to attribute. **Earlier gate text calling it a defect was an over-reading of one loaded run.**
- `pnpm test && pnpm lint` green; gate: 2 files, no budgets, no goldens.

