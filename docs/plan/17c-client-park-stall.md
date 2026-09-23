# M17c: The client worker that never parks on `zero_gc_action`

Status: not started · After: 17b · Tyler-dependent: no

Written by the orchestrator at M17b's gate, from two instrumented occurrences.

## Goal

Find out why the client worker on the `zero_gc_action` page sometimes never parks, and fix it.
The symptom is the `parkWorkers: timed out after 10000 ms` watch item (`deferred-ledger.md`). It
now fails with the same state every time, which points at a deterministic stall rather than
machine saturation.

## The evidence, gathered by the orchestrator

M16e's instrumentation (`pollUntil` in `packages/engine/src/test/client.ts`, format in the
`gc-test` skill) captured two occurrences at the M17 and M17b gates. **The counters are identical
in both, byte for byte:**

```
parkWorkers: timed out after 10000 ms (turns=2022..2034, elapsedMs=10000.8..10004.5, longestGapMs=6.0)
workers=[{"isolate":"client","W_YIELD":1,"W_PARKED":0,"W_WAKE":1776,"W_ACK":1500,"dead":false},
         {"isolate":"sim","W_YIELD":1,"W_PARKED":1,"W_WAKE":3261,"W_ACK":3260,"dead":false},
         {"isolate":"gen0","W_YIELD":1,"W_PARKED":1,"W_WAKE":1589,"W_ACK":1588,"dead":false}]
```

| gate | condition | test |
|---|---|---|
| M17 (repeat loop) | quiet, 1 in 30 | `zero_gc_action neg object sim` |
| M17b (full `pnpm test`) | load 5.7, 1 of 3 full runs | `zero_gc_action neg object main` |

What this rules out, and what it leaves open:
- **Not (c), main starved:** `turns` ≈ 2,030 and `longestGapMs` 6.0. Main polled steadily for 10 s.
- **Not (d), dead:** `dead: false`.
- **`sim` and `gen0` parked** (`W_WAKE - W_ACK` = 1). **Only `client` did not:** it saw
  `W_YIELD = 1` but never set `W_PARKED`.
- **The same `W_WAKE`/`W_ACK` in two different tests** means the client stops at one fixed point in
  the page's scripted workload. 1,500 acknowledged passes is a round number; check whether it
  equals the frames the harness drives before `parkWorkers`.
- Earlier occurrences on this page (M16 through M16b, `deferred-ledger.md`, M16e's table) predate
  the instrumentation, so their state is unknown. They are probably the same defect.
- M16e's own occurrence was a different shape (`gen0` not parked, wake == ack, on `terrain`).
  Treat it as separate unless this milestone's cause explains it too.

**The orchestrator's guess, not a finding:** `parkWorkers` parks every worker, and `sim` parks
first. If the client is inside `body()` waiting for, or retrying against, something only the sim
provides, it never gets back to `runBlockingLoop`'s `W_YIELD` check. Examples: a full ring and
`RingConnection.pumpRetries()`, an uplink/downlink handshake, or M17's new
`worker/client-drawlist.ts` pump, which runs in the same `body()`. That would be a park-ordering
deadlock. Measure before believing it.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/16e-park-timeout-diagnosis.md` (Goal, the (a)-(d) cases, Deviations)
3. `docs/plan/06b-workers-and-spawn.md` Deviations (park/resume protocol)
4. the `gc-test` skill ("Production-topology pages": how to read the message)
Rules: `.claude/rules/hot-paths.md`.

## Scope
1. **Reproduce on demand.** Start with the `gc` project running
   `zero_gc_action neg object {main,sim,client}` with `--repeat-each`, quiet, then under load.
   Try forced interpreter (`--no-opt --no-sparkplug` in the `gc` project's `--js-flags`; a
   diagnostic, reverted). Identical counters suggest a fixed trigger point, so also try making
   the race wide on purpose: a temporary delay in the sim's park path, or in the client's `body()`,
   either reverted. Record which reproduces it and at what rate.
2. **Find where the client is.** When it reproduces, get the client worker's stack or its
   position in `body()`. A plain `Runtime.evaluate` does not run on a worker blocked in
   `Atomics.wait` (M17b Deviations), so use `Debugger.pause` over CDP on that worker target, or a
   temporary, reverted per-phase breadcrumb word in the control block written by `body()`. Name
   the function and the condition it waits on. Say what `W_ACK` counts and why it trails
   `W_WAKE` by 276.
3. **Fix the named cause** in the worker protocol or the pump that holds the client, with a test
   that fails without the fix. For a park-ordering deadlock, the fix is in the protocol (for
   example, a pump that returns to the loop when `W_YIELD` is set, or a park order), never in the
   harness's timeout. Consider every pump in the client's `body()` and say which ones can block on
   another worker.
4. If step 1 cannot reproduce it in a bounded effort (about 100 targeted runs plus two loaded
   suite batches), commit the strongest diagnostic you have (for example, a permanent
   zero-allocation breadcrumb reported in the timeout message) and record the attempt.

## Non-scope
Lengthening any timeout; changing `budgets.json`; the `gen0` shape of M16e unless the same cause
explains it; the fast suite's time budget (a separate ledger row).

## Files, packages and crates touched
`packages/engine/src/worker/` (`shell.ts`, `client.ts`, `client-net.ts`, `client-drawlist.ts`,
`sim.ts`), `src/sab/control.ts`, `src/test/client.ts`, their tests, and `tests/browser/gc/` if a
harness change is needed.

## Seams
**Provides:** nothing new unless step 4 lands a breadcrumb (record its exact word and format).
**Consumes:** M06b park/resume, M15b `RingConnection`, M16 `gc-slice.ts`, M16e's timeout message,
M17 `client-drawlist.ts`.

## Order of work
Steps 1-4 in order, each committed `M17c step k: …`.

## Tests added
A test for the step-3 fix that fails on the base commit. Say how you checked that it fails there.

## Exit criteria
- [ ] The client's stall is reproduced and its location named (function + awaited condition), or
      step 4's bounded attempt is recorded and a diagnostic is committed.
- [ ] If named: fixed, with a test that fails without the fix. `node scripts/repeat.mjs browser 15`
      and `... 15 --load 10` show no `parkWorkers` timeout.
- [ ] `zero_gc_action`'s negative controls still trip and every budget is unchanged.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm gc -t "zero_gc_action"` · `pnpm test browser -t <pattern>` ·
`node scripts/repeat.mjs browser <n> [--load 10]` (foreground, bounded, a per-run kill timeout, no
background load generators).

## Budgets
none changed.

## Context artifacts
The `gc-test` skill's debugging section: how to find a stalled worker's position (step 2's
technique).

## Manual device checks
none

## Deviations

### Step 1: reproduced on demand

`zero_gc_action`'s own script (`gc-slice.ts`) ticks the sim once per driven frame and drives
`WARMUP` (4000, split `WARMUP_PASSES = 8` calls of 500 frames each) plus two 600-frame measured
windows per `measure()` call (`tests/browser/gc/instrument.ts`); every `run(frames, marked)` pass
(`gc-page.ts`) itself calls `harness.resume()`, drives `frames` frames, then `harness.park()` --
`parkWorkers`, the exact function whose own 10 s `pollUntil` is what the watch item names. 1,500
acknowledged frames is therefore not an arbitrary number: it is exactly 3 of the 8 `WARMUP_PASSES`
(500 x 3), i.e. the client fully finished its third pass and stalled on that pass's own trailing
`parkWorkers` call.

Reproduces under `--repeat-each` plus parallel `gc`-project workers, on the `main`-isolate `object`
negative control specifically (not `client`/`sim`/`gen0`'s own `object` controls, and not the
`burst` controls, in any run of this session): `allocateObject`'s own per-frame allocation on
`main`, ahead of `gc-slice.ts`'s own `drive()` call, changes the timing enough to matter.

- Clean baseline, no diagnostic, no load (this session, before touching anything):
  `pnpm exec playwright test --config packages/engine/playwright.config.ts --project gc --grep
  "zero_gc_action neg object" --workers 3 --repeat-each 30` -- **120 passed (56.1s)**, 0 failures.
- First reproduction, `--repeat-each 15 --workers 3` plus 10 self-terminating CPU burners (the same
  technique `scripts/repeat.mjs --load` uses, run once in the foreground): **58 passed, 2 failed
  (45.3s)**, both `zero_gc_action neg object main`:
  ```
  Error: page.evaluate: Error: parkWorkers: timed out after 10000 ms (turns=2036, elapsedMs=10003.4, longestGapMs=6.0) workers=[{"isolate":"client","W_YIELD":1,"W_PARKED":0,"W_WAKE":1776,"W_ACK":1500,"dead":false},{"isolate":"sim","W_YIELD":1,"W_PARKED":1,"W_WAKE":3257,"W_ACK":3256,"dead":false},{"isolate":"gen0","W_YIELD":1,"W_PARKED":1,"W_WAKE":1589,"W_ACK":1588,"dead":false}]
  Error: page.evaluate: Error: parkWorkers: timed out after 10000 ms (turns=2037, elapsedMs=10005.0, longestGapMs=6.0) workers=[{"isolate":"client","W_YIELD":1,"W_PARKED":0,"W_WAKE":1776,"W_ACK":1500,"dead":false},{"isolate":"sim","W_YIELD":1,"W_PARKED":1,"W_WAKE":3261,"W_ACK":3260,"dead":false},{"isolate":"gen0","W_YIELD":1,"W_PARKED":1,"W_WAKE":1589,"W_ACK":1588,"dead":false}]
  ```
  `client`'s own `W_ACK` (1500) and `W_WAKE` (1776) are byte-identical to the brief's own evidence
  table from two earlier, independent gates (M17, M17b) -- the trigger point is exactly this
  deterministic, not a fresh coincidence.
- Rate: 2/15 (~13%) for `zero_gc_action neg object main` specifically, at `--repeat-each 15
  --workers 3` plus 10 burners; 0/45 for the other three `object` controls in the same batch. A
  second batch at `--repeat-each 25 --workers 3` plus 14 burners reproduced it again, 1/25 (~4%) for
  `main`, 99 passed -- used for step 2 (below).
- Forced interpreter (`--js-flags=--no-opt --no-sparkplug`, temporary, reverted) was not tried:
  reproduction on real V8 was already reliable enough that the skill's own caution ("a
  forced-interpreter reproduction of a change this small" can manufacture its own regression,
  M16e) did not need testing here.
- A widened race (a temporary, reverted delay in the sim's park path or the client's `body()`) was
  not needed either, for the same reason.
- **This session's own machine went through a period of heavy, unrelated ambient contention**
  (`uptime` load 1-second readings ranged from 1.7 to 18.5 across roughly 40 minutes of this
  session, unrelated to anything this session started deliberately -- a shared machine, 5 logged-in
  users) during which every `gc`-project batch, loaded or not, failed with bare `Test timeout of
  30000ms exceeded` (no per-worker diagnostic at all -- the CDP-round-trip gap the `gc-test` skill
  already documents, not this milestone's own defect) across most or all of the tests in the batch,
  not just the `parkWorkers` watch item. Two genuinely orphaned `ms-playwright` Chromium processes
  (unrelated to this milestone's own current run, dated well before this session) were found and
  killed along the way. No further large loaded batches were run once this was recognised as a
  separate, environmental problem rather than a reproduction lead; step 2 and step 3's own repeats
  (below) were run once the machine's `uptime` returned to single digits.

### Step 2: located, live, via CDP `Debugger.pause`

`tests/browser/gc/sessions.ts`'s `TunnelSession` only forwarded CDP *responses*
(`Target.receivedMessageFromTarget` messages carrying an `id`); a `Debugger.paused` event carries no
`id`, so it was silently dropped. Temporarily added `onEvent(method, cb)` (an event listener keyed
by CDP method, forwarding a message with no `id` to its registered listeners) and, in
`instrument.ts`'s `WARMUP_PASSES` loop, raced each pass's own `page.evaluate` against a 4 s timer;
past it, the client worker's own session got `Debugger.enable` + `Debugger.pause`. Both reverted
after this step (`git diff` was re-checked clean before continuing); the technique itself is now the
`gc-test` skill's own new bullet (Context artifacts, below).

Caught live, in the second reproduction batch above (`--repeat-each 25 --workers 3` plus 14
burners), on warm-up pass index 2 (0-indexed -- the third pass, frames 1001-1500, matching step 1's
own math exactly):

```
[M17c diag] pass 2 still unresolved after 4000ms, pausing 'client'
[M17c diag] Debugger.paused on 'client', top 2 frames: ["waitForWake","runBlockingLoop"]
```

The full `Debugger.paused` `callFrames` (4 frames, deepest first, `functionName` / `this.className`
/ `functionLocation` from the raw CDP payload; `location`s are the *built* worker bundle's line
numbers, not source):

1. `waitForWake` (`this`: `ControlBlock`) -- `sab/control.ts`'s own `Atomics.wait(this.words,
   workerWord(index, W_WAKE), last, timeoutMs)`, the *only* statement in that method.
2. `runBlockingLoop` (a plain function, no `this`) -- `worker/shell.ts`.
3. `resume` (`this`: `Shell`) -- `Shell.resume()`, `worker/shell.ts`.
4. `scope.onmessage` (closure `run`) -- `worker.ts`'s own `self.onmessage` handler, i.e. this
   `resume()` call was made processing a `{ type: 'resume' }` message.

The test that failed 10 s later, same run, same client worker:
```
parkWorkers: timed out after 10000 ms (turns=2040, elapsedMs=10001.7, longestGapMs=6.0) workers=[{"isolate":"client","W_YIELD":1,"W_PARKED":0,"W_WAKE":1776,"W_ACK":1500,"dead":false},{"isolate":"sim","W_YIELD":1,"W_PARKED":1,"W_WAKE":3261,"W_ACK":3260,"dead":false},{"isolate":"gen0","W_YIELD":1,"W_PARKED":1,"W_WAKE":1589,"W_ACK":1588,"dead":false}]
```

**Named cause: the client worker is genuinely blocked inside `Atomics.wait`, waiting on its own
`W_WAKE` word, having *already* correctly processed every one of the 1,500 frames driven so far --
not case (a) (stuck inside `body()` or a pump) and not case (d) (dead).** Reasoning, all from this
one capture plus the numbers already in the evidence table:

- **What `W_ACK` counts.** `worker/client.ts`'s `body()` stores `W_ACK = frameReq` (the just-read
  `CB_FRAME_REQ` value) unconditionally, on *every* wake, not only one where the frame request
  changed (its own comment: "idempotent when it didn't"). `W_ACK` is therefore not a wake tally --
  it is "the highest `CB_FRAME_REQ` this worker has fully applied", and it reads 1,500 because
  `stepFrame` (`gc-slice.ts`'s own `drive()`) increments `CB_FRAME_REQ` by exactly 1 per driven
  frame and exactly 1,500 frames had been driven (3 full `WARMUP_PASSES`).
- **Why `W_WAKE` trails by 276, and what that does *not* mean.** `client`'s own `W_WAKE` (a true,
  monotonic wake tally, unlike `W_ACK`) is 1,776, not 1,500, because `stepFrame` is not the only
  thing that wakes `client`: `worker/client-net.ts`'s own net pump is woken directly off the
  downlink ring by the sim/host's own tick (`src/CLAUDE.md`: "`downlink`: `RingProducer`, woken
  toward the client worker"), independent of `CB_FRAME_REQ`/`stepFrame` (`test/client.ts`'s own
  `pumpUntilLive` doc comment says the same). 276 is not a backlog of unprocessed work -- `W_ACK`
  already equals the highest `CB_FRAME_REQ` there is (1,500); it is simply how many of `client`'s
  own 1,776 real wakes were *not* `stepFrame`'s.
- **Main was never stuck, and drove every one of the 1,500 frames for every worker, not just
  `client`.** `gc-slice.ts`'s `drive()` calls `stepSimTickSync` (wakes `sim` once) and
  `harness.stepTick()` (wakes `sim` *and* `gen0` once each) every frame, in addition to
  `stepFrame`. Over 1,500 frames that is a floor of 3,000 wakes for `sim` and 1,500 for `gen0`
  (both undercounts: `pumpUntilLive`'s own bootstrap loop calls `stepSimTickSync` repeatedly,
  before frame-driving even starts, adding an unknown-but-bounded prelude to `sim`'s own count
  only). The observed `sim` `W_WAKE` (3,257-3,261 across the two captures) and `gen0` `W_WAKE`
  (1,589 both times) sit right at that floor plus a small, `sim`-only prelude -- consistent with
  *exactly* 1,500 frames driven, for every worker, and nothing more. Main is not case (c) either:
  `parkWorkers`'s own `pollUntil` recorded `turns=2036-2040` over the full `elapsedMs=10001.7-
  10005.0`, a steady ~5 ms/turn macrotask poll, not a starved one (`longestGapMs=6.0` both times).
- **`body()` cannot itself block on another worker -- checked, not assumed.** Every pump `body()`
  calls (`worker/client-{net,gen,upload,input,action}.ts`) is a bounded, allocation-free drain: each
  loop is `for (;;) { ...; if (nothing left / ring full / claim failed) break }`, with **no retry
  against a producer or consumer it does not own**. `client-net.ts`'s own uplink push
  (`uplinkProducer.tryPush`) drops and counts on a full ring rather than retrying; `client-gen.ts`'s
  own request-side `tryClaim` breaks rather than retrying. **This rules out the orchestrator's own
  guess** (a full ring, `RingConnection.pumpRetries()`, or an uplink/downlink handshake holding
  `body()`): nothing in `body()` can wait on anything at all. `worker/gen.ts`'s own M16e-flagged
  yield-free drain loop is also not implicated -- this occurrence is `client`, not `gen0`, and
  `gen0` parked correctly.
- **What is left, and what was not pinned down.** `wake()` (`ControlBlock.wake`, `sab/control.ts`)
  is `Atomics.add` then `Atomics.notify`; `waitForWake` is a bare `Atomics.wait`. Traced through
  every interleaving this session could construct: a worker that has *not yet* re-entered
  `Atomics.wait` when a `wake()` runs always recovers on its own next wait (the word has already
  changed, so `Atomics.wait`'s own check-then-sleep returns immediately instead of blocking) --
  that race is provably safe. A worker *already asleep, already registered* as a waiter is
  different: if the matching `Atomics.notify` is ever missed for that one waiter, nothing wakes it
  again, no matter how many more times the word changes afterwards, since nothing re-notifies. This
  session could not pin down *why* one `Atomics.notify` call, for this one worker, on this one
  pass, does not reach an already-sleeping waiter -- every JS-level ordering this session checked
  (including `Shell.resume()`'s own `observeWake`/`lastSeen` discipline, M06b fix round 3's fix for
  the *other* class of this bug) is safe by the language's own spec, so the miss is either a rare
  engine/OS-level one, or a mechanism this session did not find. **Named per the brief's own bar
  ("function + the condition it waits on"): `ControlBlock.waitForWake`, called from
  `Shell.resume()` -> `runBlockingLoop`, waiting on its own `W_WAKE` word for a notification that
  was not observed.** The root mechanism behind the one missed notification is not further named;
  said so per the binding rules, rather than presenting a guess as a finding.
