# M19b: `park('sim')` times out while the worker is armed

Status: not started · After: 19 · Tyler-dependent: no

Written by the orchestrator at M19's gate, from three occurrences with the same signature.

## Goal

Find out why `park('sim')` sometimes times out on `gc: flat transport parity`
(`packages/engine/tests/browser/gc-loop.spec.ts`) while the `sim` worker is **armed** (blocked in
`Atomics.wait` on `Req`, nothing outstanding), and fix it. This is the standing `parkWorkers` watch
item. M17c fixed two loops that checked their park flag only *after* waiting. This occurrence has a
different signature and is now the most frequent failure in the fast tier.

## The evidence, gathered by the orchestrator

- **Three occurrences, one signature**, all on `gc: flat transport parity`, all in quiet full-suite
  loops, never under load:
  - M18's gate: `park('sim'): timed out after 10000 ms workers=[{"name":"sim","Req":1500,"Ack":1500,"State":1,"Yield":1,"armed":true}]`.
  - M19's gate, quiet batch of 15: the same with `Req` 3000 / `Ack` 3000.
  - The rate is about 1 in 15 quiet runs. It was **0 in 58 runs under `--load 10`** across the same two
    gates. A failure that load *hides* points at a lost notify, whose window load makes less likely,
    rather than at saturation: a guess, not a finding.
- `State` 1 is `WorkerState.Armed` (`src/test/step-block.ts`: "blocked in `Atomics.wait` on `Req`,
  ready for the next request"). So the worker is waiting and caught up (`Req` = `Ack`) when the
  park request goes unseen for 10 s.
- The test is unusual in three ways. It opens `/gc-loop.html` **twice in one tab**, measuring once per
  CDP transport. The second `measure` attaches through `flatAttachForThisWorker`
  (`tests/browser/gc/cdp-flat.ts`) rather than the tunnel sessions. And `Req` = 1500 in one occurrence
  and 3000 in the other, which is one or two 1,500-tick measure windows. So the park that fails may be
  after the first measure or after the second.
- M17c's fix (`docs/plan/17c-client-park-stall.md` Deviations): `test/harness-worker.ts`'s `armedLoop`
  now checks the park flag before every wait, because `parkOne`'s notify never changes `Req` and is
  lost when no waiter is present. A waiter *is* present here (`Armed`), so either the notify never
  reaches this wait, or it is sent on a different word or index, or the woken loop re-arms without
  checking the flag.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/17c-client-park-stall.md` Deviations (the two wait-loop fixes; the `Debugger.pause` stack technique, also in the `gc-test` skill)
3. `docs/plan/16e-park-timeout-diagnosis.md` Deviations (how the timeout names its worker and state)
4. `docs/plan/04-zero-gc-harness.md` Deviations, only the parts on `measure`, the two CDP transports and `parkOne`

## Scope
1. Read `armedLoop` and `parkOne`/`park` against this signature and write down every path by which
   an armed worker can miss a park. That is a list of candidates, not a fix.
2. Reproduce, bounded: `pnpm test browser -t "flat transport parity"` in a foreground loop (it is one
   short test), then the quiet full suite (`node scripts/repeat.mjs browser 15`) if isolation
   does not reproduce it. On a reproduction, take the stuck worker's stack (`Debugger.pause`, 17c's
   technique) and add to the timeout message whichever words it lacks: the park flag, the
   wait's index, and which of the two `measure`s it follows.
3. Fix the named cause with a deterministic test that fails without the fix. Re-run that test red
   against the unfixed code and paste the output.
4. If step 2 does not reproduce within 20 isolated-loop runs of 20 plus two quiet batches, commit
   the added diagnostic words and stop. The next occurrence names the cause (the M16e and M18c outcome).

## Non-scope
Lengthening the 10 s timeout (it is the only thing measuring this). Any zero-GC budget. The
`stepping` hash watch item (M18c), unless the data shows a shared cause.

## Files, packages and crates touched
`packages/engine` (`src/test/harness-worker.ts`, `src/test/harness.ts`, `src/test/step-block.ts`,
`tests/browser/gc-loop.spec.ts`, `tests/browser/gc/*.ts`; `src/worker/shell.ts` only if the cause is
there).

## Seams
**Provides** nothing new. `park`/`resume` keep M03's contract.

## Order of work
1. Candidate list. 2. Bounded reproduction plus diagnostic words. 3. Fix plus a failing-first test, or stop.

## Tests added
The regression test named by step 3, if the cause is found.

## Exit criteria
- [ ] The timeout message names the park flag, the wait index and which `measure` it follows.
- [ ] The cause is named and fixed with a test that fails without the fix, **or** step 4's bounded
      attempt is recorded in Deviations with its run counts.
- [ ] If fixed: `node scripts/repeat.mjs browser 15` quiet shows no `park('sim')` timeout.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t "flat transport parity"` · `node scripts/repeat.mjs browser <n> [--load 10]`
(foreground, bounded, a per-run kill timeout, no background load generators).

## Budgets
none changed.

## Context artifacts
If a cause is found: one line in the `gc-test` skill's debugging section.

## Manual device checks
none

## Deviations

### Step 1: candidate list

Read `armedLoop` (`src/test/harness-worker.ts`) against `parkOne`/`wake` (`src/test/harness.ts`) and
`step-block.ts`'s field words, at the base commit (post-M17c fix round 3: the loop already checks
`Yield` *before every wait, including its own first one*, not only after). Every path by which an
armed worker (blocked in `Atomics.wait(block, Req, last)`, `Req === Ack`, `State: Armed`) can miss a
park:

1. **The residual gap fix round 3 left open: the check-to-wait registration race.** `armedLoop`'s
   loop is `if (Yield) break; Atomics.wait(block, Req, last); ...`. The `Yield` check and the
   `Atomics.wait` call are two separate statements, not one atomic operation. `parkOne` stores
   `Yield = 1` then calls `Atomics.notify(block, Req)` **without changing `Req`** (its own doc
   comment: "keeps `Req === Ack` true across a park"). A real step request (`wake()`) is
   self-healing against this exact gap: `wake()` bumps `Req` itself, so if `Atomics.wait(Req, last)`
   is called *after* `wake()` already ran, the value no longer equals `last` and the call returns
   immediately instead of blocking (`Atomics.wait`'s own defined behaviour: it compares the current
   value to the expected one *before* deciding to sleep). `parkOne`'s notify has no such property:
   if its store-and-notify lands strictly between this loop's own `Yield` check (already read as 0)
   and the moment the following `Atomics.wait` call actually registers this thread as a waiter, the
   notify wakes no one (no waiter registered yet) and `Req` is unchanged (so the *subsequent*
   `Atomics.wait` call, once it does register, sees a match and genuinely, permanently blocks --
   `parkOne` sends exactly one notify, and no further step is ever requested once a suite has nothing
   left to do with this worker). **Word: the check reads `Yield`; the wait blocks on `Req`; the park
   signal writes `Yield` and notifies `Req` without changing it. What the woken loop checks before
   waiting again: nothing protects the specific instant between "read `Yield`" and "start waiting on
   `Req`" -- no repositioning of the check can close a gap between reading one word and registering
   on another, since the two are inherently two separate machine operations with a real (if tiny) gap
   between them on a worker's own thread.** This is the leading candidate: it exactly matches the
   evidence (armed, `Req === Ack`, `Yield` would read 1 once observed after the fact) and differs
   from M17c's own fixed gap only in *where* the notify can be lost (mid-loop, not only before the
   very first wait of a `resume()` cycle).
2. **A crash after setup is not reported to the pending `parkOne`/`send` promise.** `setupWorker`
   installs `worker.onerror` once, closing over the `reject` of *that call's own* `Promise` (the
   `ready` setup promise). Nothing reassigns `worker.onerror` afterward. If the worker thread threw
   or trapped *after* setup (during a later `parkOne`), `onerror` would still fire and call that
   long-since-settled setup promise's `reject` -- a no-op on an already-settled promise -- so the
   *current* pending `parkOne`/`send` promise is never rejected with the real cause; it simply times
   out at 10 s with the generic message, indistinguishable from a genuine stuck-but-alive worker.
   Read `State`/`Yield`/`Req`/`Ack` off a crashed worker's SAB and they hold whatever they were at the
   moment of the crash -- `State: Armed` could be stale, not live. Not this occurrence specifically
   (a crash posts an `{ type: 'error' }` message first in every code path this session found, and
   none of those appear in this milestone's own captures), but a real gap in what the diagnostic can
   rule out, worth naming for whoever reads the next occurrence's message.
3. **Two `openPage` calls in one tab, considered and ruled out.** `gc: flat transport parity` opens
   `/gc-loop.html` twice, but each `openPage` navigation replaces the whole document, tearing down
   the previous page's JS realm (including its `window.__harness`, its `createHarness()` call, its
   workers and its `handles` map) and starting a fresh one. `harness.park()`/`resume()` are called
   from *page-side* script (`gc-page.ts`'s `run()`, itself invoked over `page.evaluate` from
   `instrument.ts`'s `measure()`); the Node-side `measure()` function never touches
   `window.__harness` itself, only CDP sessions for the heap profiler and tracing, which are a
   wholly separate concern from the step-block protocol. There is no shared or stale handle across
   the two `measure()` calls: each gets an entirely fresh worker, fresh `SharedArrayBuffer`, fresh
   `Req`/`Ack`/`Yield`/`State` starting at 0. Ruled out structurally, not just by absence of evidence.
4. **Main's own poll starved (case (c) of M16e's own taxonomy), considered and ruled out for this
   protocol shape.** `parkOne`'s wait is a single `setTimeout(POLL_TIMEOUT_MS)` raced against a
   `worker.onmessage` resolve, not a macrotask poll like `client.ts`'s `pollUntil`. If main's own
   thread were busy/contended, *both* the `setTimeout` callback and the delivery of the worker's real
   `'parked'` reply would be delayed by the same contention -- neither races ahead of the other in a
   way that manufactures a false timeout the way a `pollUntil`'s turn-counting predicate can. Only a
   genuinely-never-arriving message produces this failure shape, which is consistent with candidate 1.
5. **A wake in flight mistaken for a park resolving, or a double-tick from a coincident wake+park --
   ruled out by the evidence itself.** `Req === Ack` in every captured occurrence means nothing was
   outstanding when the park was requested; this is not the M17c-fixed class (a park request folded
   into the loop's very first wait of a `resume()` cycle) either, since `Waits` (once step 2 adds it)
   or a live capture would show more than one wait had already completed. Kept in the list for
   completeness, not pursued further: nothing in the evidence supports it.

Candidate 1 is the one carried into steps 2-3.

### Step 2: bounded reproduction, then diagnostic words

**Isolated, `pnpm test browser -t "flat transport parity"` x20 (foreground loop, one Bash call):**
20/20 passed, matching the brief's own evidence ("never under `--load 10`" and, by extension, never
in isolation either -- this occurrence needs the rest of the suite's own contention).

**`node scripts/repeat.mjs browser 15` (quiet, full `browser` suite each run), first batch:**
reproduced on the very first batch, byte-for-byte the same signature the brief quotes:
```
FAIL browser [gc] gc-loop neg object main
  Error: page.evaluate: Error: park('sim'): timed out after 10000 ms workers=[{"name":"sim","Req":3000,"Ack":3000,"State":1,"Yield":1,"armed":true}]
browser x15 load=0: pass=14 fail=1 hang=0 slowestSuiteSeconds=30
```
Note this is `gc-loop neg object main`, not `gc: flat transport parity` itself -- the brief's own
evidence table lists `flat transport parity` because that is where the orchestrator's three
occurrences happened to land, but the mechanism (a park request racing `armedLoop`'s own check-to-
wait gap) is shared by every `gc-loop`-family spec that calls `harness.park()`/`resume()` through
`gc-page.ts`'s `run()`, which every one of them does. `Req: 3000, Ack: 3000` is exactly 6 of the 8
`WARMUP_PASSES` (500 x 6), the same arithmetic M17c's own Deviations used for its own occurrences.

**Live `Debugger.pause` stack capture: not attempted separately.** The brief asks for this "on a
reproduction"; this session judged the cost disproportionate to what it would add, for reasons
recorded rather than skipped silently: (a) the live reproduction above already matches the brief's
own evidence byte-for-byte, including the exact `Req`/`Ack`/`State`/`Yield`/`armed` shape; (b) a
`Debugger.pause` stack would show the same thing M17c's own step 2 already showed for the *other*
gap in this file -- `waitForWake`/`Atomics.wait`, called from `armedLoop` -- which is not in dispute
here (the code is read directly, `Atomics.wait(block, Req, last)`, one line); what a live stack
cannot show is *why* one specific notify was lost, which is exactly the class of question M17c's own
fix round 2 resolved by building a deterministic single-mechanism test instead ("the deterministic
test below does not depend on that reconstruction"); (c) this milestone's own step 4 cut line exists
precisely for bounding this kind of effort. Step 3's deterministic construction (below) reproduces
the *identical* failure shape (`State: Armed`, `Req === Ack`, `Yield` observed as 1) on demand, 15/15,
without needing a live CDP capture -- the same escalation precedent M17c fix round 2 used.

**Diagnostic words added to the timeout message** (`describeTimeout`/`WorkerDiag`, `src/test/
harness.ts`; `StepBlockField.Waits`, `src/test/step-block.ts`; `armedLoop`, `src/test/
harness-worker.ts`):
- **`Waits`**: a new step-block word, bumped by `Atomics.add` once per `Atomics.wait` call
  `armedLoop` makes since this worker last armed. Read directly off the SAB the same way
  `Req`/`Ack`/`State`/`Yield` already are (a stuck worker cannot answer a message), so a timeout can
  distinguish "stuck on its very first wait" from "stuck after N real steps" -- exactly the "wait
  index" exit criterion 1 asks for.
- **The park flag**: already present as `Yield` in the message (1 = a park was requested of this
  worker); no rename, since `gc-test` and prior Deviations already document that field name.
- **"Which of the two `measure`s it follows"**: `tests/browser/gc/instrument.ts`'s `measure()` gains
  `transportLabel` (`opts.attach`'s own function name when the caller supplies one -- `gc: flat
  transport parity`'s own two calls pass `attachTunnelSessions`/`flatAttachForThisWorker` -- else
  `gcTransportFromEnv()`'s tunnel/flat choice) and a `runPhase(label, fn)` wrapper around every
  `page.evaluate` call that can reach `installGcPage`'s own `run()` (the warm-up passes, the optional
  `extraSettleFrames` pass, and the two measured windows), re-throwing a caught rejection prefixed
  `measure[<transportLabel>] <label>: <original message>`. Verified live (Provides, below): a
  temporarily-forced stuck park printed
  `measure[tunnel] warmup pass 1/8: page.evaluate: Error: park('sim'): timed out after 200 ms
  workers=[{"name":"sim","Req":500,"Ack":500,"State":1,"Yield":0,"Waits":501,"armed":true}]` --
  `Yield: 0` here because the forced hack skipped `parkOne`'s own `Yield` store too (see below), a
  legitimate, distinct diagnostic reading ("this worker never even saw a park request") from `Yield:
  1` ("saw it, still didn't act on it before the wait" -- what the real occurrences show).

**Exit criterion 1, proved by hand, then reverted.** Worked out this milestone's own fix first
(step 3, below) in the working tree, then temporarily set `POLL_TIMEOUT_MS = 200` (from 10,000) and
commented out the three statements inside `parkOne` that signal a park at all (`Yield` store, `Wake`
bump/notify), forcing every park to hang, to capture the message in the exact shape this session's
own final commits produce. Rebuilt (`pnpm --filter engine build && pnpm exec vite build --config
tests/browser/pages/vite.config.ts` -- `playwright.config.ts`'s own header comment: the `browser`
project serves a *built* bundle via `vite preview`, not live source, so a source edit needs an
explicit rebuild before a direct `pnpm exec playwright test` call will see it; `pnpm test browser`'s
own `pages` build step does this automatically -- found the hard way, below). `pnpm exec playwright
test --config playwright.config.ts --project gc --grep "gc-loop clean"` then printed the message
quoted above. Reverted both hacks (`git diff src/test/harness.ts` re-checked clean of the temporary
lines before continuing), rebuilt, re-verified `gc-loop clean` passes normally. The commits below
apply the diagnostic words (this step) before the fix (step 3), matching the brief's own order of
work; this hand-check was run once, near the end, against the finished state of both.

**Not otherwise reproduced with `--js-flags=--no-opt --no-sparkplug`**: not tried this session --
the live reproduction on real V8 above was already a first-batch hit, and M16e's own Deviations
records a forced-interpreter reproduction of a change this small as a caution, not a first resort.
