# M17c: The client worker that never parks on `zero_gc_action`

Status: done · After: 17b · Tyler-dependent: no

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
- [x] The client's stall is reproduced and its location named (function + awaited condition), or
      step 4's bounded attempt is recorded and a diagnostic is committed.
- [x] If named: fixed, with a test that fails without the fix. `node scripts/repeat.mjs browser 15`
      and `... 15 --load 10` show no `parkWorkers` timeout.
- [x] `zero_gc_action`'s negative controls still trip and every budget is unchanged.
- [x] `pnpm test` and `pnpm lint` are green.

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

  **Superseded by fix round 2, below.** No engine-level lost notify is needed: the orchestrator
  (coordinator gate on this milestone) traced a real gap in `runBlockingLoop` itself -- it checked
  `W_YIELD` only *after* a wait returned, never before its own *first* one, so a park request whose
  own `W_YIELD = 1` store and wake both land inside the gap `Shell.resume()`'s own steps leave
  between reading `W_WAKE` (`seen`) and calling here is folded into that first wait's own baseline
  with no further wake ever coming to reveal it. The stack this section captured (`waitForWake`
  reached from `Shell.resume()` via `onmessage`) is exactly what that gap produces; this session's
  own exhaustive Atomics-safety trace was real but answered a narrower question ("can a *registered*
  waiter's notify go missing") than the one that mattered ("does the loop ever check its own flag
  before committing to wait at all"). Fix round 2's own section has the corrected mechanism and the
  deterministic, unit-level proof.

### Step 3, fix round 1 -- superseded by fix round 2, below

The coordinator gate on this milestone found the fix in this round landed at the wrong layer: a
harness that keeps re-signalling until a worker parks measures away exactly the class of protocol
defect this milestone actually found (a park request the worker's own loop structurally could not
observe, not a one-off dropped OS-level notify), and the `parkWorkers` 10 s message is the only
thing that would have caught a real regression of that kind. `rewakeUnparked` was reverted in favour
of the real fix (`runBlockingLoop` itself, fix round 2); `parkWorkers` is back to a single up-front
`wake()` per worker, unchanged from before this milestone. Kept here for the record, superseded in
full by fix round 2.

**Fix (round 1, reverted).** `parkWorkers` (`src/test/client.ts`) used to `wake()` every worker exactly once, up front,
then poll `W_PARKED` for up to 10 s with no further signal. `pollUntil`'s own predicate
(`rewakeUnparked`, replacing `allEqual` for this call site) now re-issues `wake()` to every
not-yet-parked worker on *every* poll turn, not just once: a real park signal a worker's own thread
was already asleep for and somehow missed gets a second (and third, ...) chance within the same,
unwidened 10 s bound, at the cost of nothing on the success path (`wake()` is two `Atomics`
primitives, no allocation, and the predicate already walked every worker once per tick before this
change). `resumeWorkers` is unchanged: it resumes over `postMessage`, delivered through the
browser's own message queue to a worker that is *not* asleep in `Atomics.wait` at the time (a
parked worker is, by construction, back in its own event loop), so it is not exposed to this same
class of miss.

**Test, and how it was checked red on the base commit.** `workers.park_recovers_from_missed_notify`
(`tests/browser/workers.spec.ts`) calls a new debug hook, `__testParkRecoversFromMissedNotify`
(`tests/browser/pages/src/topology.ts`): settle every worker idle via `resumeWorkers` (so `client`
is genuinely asleep in its own `Atomics.wait`, the exact precondition step 2 found), monkeypatch
*this session's own* `ControlBlock` instance's `wake` method so the *first* call targeting the
`client`-kind worker performs only the `Atomics.add` half of `wake()` (never `Atomics.notify` --
faithfully simulating "the producer's own bookkeeping advanced, the signal did not", not "`wake()`
was never called" -- restored via a `try/finally` regardless of outcome, and this shadows only the
one JS object main holds, never the worker's own separate `ControlBlock` instance over the same
SAB), then calls the real `parkWorkers`. The spec races the result against a 3 s timer.

Checked red by temporarily reverting only the fix (`git checkout -- packages/engine/src/test/
client.ts`, restoring `allEqual`/the single up-front `wake()`; the test hook and spec stayed in
place) and running `pnpm test browser -t workers.park_recovers_from_missed_notify`:
```
FAIL browser [chromium] workers.park_recovers_from_missed_notify
  Error: expect(received).toEqual(expected) // deep equality

  Expected: {"ok": true}
  Received: "timed-out"

    238 |     new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 3000)),
    239 |   ])
  > 240 |   expect(result).toEqual({ ok: true })
        |                  ^
```
The fix was then re-applied (`git apply` of the saved diff) and the same command passes:
`browser pass 1 tests    1.8s/25s`. Reliability: `pnpm exec playwright test --config
packages/engine/playwright.config.ts --project chromium --grep
"workers.park_recovers_from_missed_notify" --repeat-each 10` -- **10 passed (2.8s)**.

**Hot-path check (binding rule: `body()` and the park/resume path allocate nothing new on the
success path).** `pnpm gc -t "topology clean|echo clean|zero_gc_action clean|gc-loop clean"` --
**4 passed (2.4s)**, budgets unchanged (`rewakeUnparked`'s own success-path shape -- one indexed
walk, `Atomics.load`, no allocation -- is the same one `allEqual` already had; `parkWorkers` runs
inside every one of these pages' own measured windows, `.claude/rules/hot-paths.md`).
`pnpm gc -t "gc-loop|topology|echo|zero_gc_action"` -- **34 passed (12.1s)**: every `object`/`burst`
negative control on every named isolate of every affected page still trips (`zero_gc_action`'s own
included), and `gc: flat transport parity` still passes.

**`zero_gc_action`'s own negative controls, the ones this defect was found through, targeted
directly:** `pnpm exec playwright test --config packages/engine/playwright.config.ts --project gc
--grep "zero_gc_action neg object" --workers 3 --repeat-each 30` -- **120 passed (56.1s)**, 0
`parkWorkers` timeouts (matches step 1's own clean baseline exactly, with the fix now in place).

### Step 3, fix round 2: the real cause, at the protocol layer

**The coordinator's trace, checked against the code.** `worker/shell.ts`'s `Shell.resume()` does,
in order: (1) `store W_YIELD = 0`; (2) `seen = observeWake()`; (3) `store W_PARKED = 0`; (4)
`runBlockingLoop(..., seen)`. Re-read `runBlockingLoop` (fix round 1's own section quoted it) with
this specific question in mind -- **does it check `W_YIELD` before its own first wait, the same way
it checks after every later one?** It does not:
```
let last = lastSeen ?? Atomics.load(control.words, workerWord(index, W_WAKE))
if (!runBodyOnce(shell, body, last)) return         // entry drain -- no yield check either side
for (;;) {
  control.waitForWake(index, last, timeoutMs())      // <- the loop's own first wait: nothing
  if (shell.stopped()) return                        //    checked W_YIELD before this call
  if (Atomics.load(control.words, workerWord(index, W_YIELD))) break   // checked only AFTER
  ...
}
```
Confirmed, unambiguously, by reading the code: this is real. A park request whose own `W_YIELD = 1`
store and wake both land in the gap between `Shell.resume()`'s steps (1)/(2) and step (4)'s own
first wait folds itself into `seen`/`last`, and nothing checks the flag until *after* a wake this
worker now has no reason to expect arrives -- which, for a worker parked and never touched again,
never happens. This is a **different, better-supported** mechanism than fix round 1's own guess (an
engine/OS-level `Atomics.notify` miss against an *already-registered* waiter): it requires no
unproven engine rarity, it is directly demonstrable in a single-threaded unit test (below), and it
explains the exact captured shape (`W_YIELD: 1, W_PARKED: 0`, the stack through `Shell.resume()`).

**Where this session's own live occurrence sits, honestly.** Reconstructing gc-slice.ts's own
timeline in detail: `run()`'s per-pass `resume()`/drive/`park()` sequence is strictly gated on
observable `SharedArrayBuffer` state on both ends -- `resumeWorkers()` only returns once `W_PARKED`
reads 0 (already past `Shell.resume()`'s own step (3)), and `parkWorkers()` only returns once
`W_PARKED` reads 1 (`runBlockingLoop` has already returned) -- and `stepFrame`'s own ack-spin
locksteps main to the client one frame at a time throughout a pass, so `parkWorkers` for pass *N*
cannot fire until client has already finished processing pass *N*'s own last frame, long past that
pass's *own* one-time first-wait window. This session could not, by static reading, place a
concurrent `parkWorkers` call inside *this specific page's* own per-pass `resume()` gap to explain
"3 full passes, then frozen at exactly that boundary" end to end. What resolves this: the
deterministic test below does not depend on that reconstruction -- it constructs the interleaving
directly, on one thread, and it reproduces the *identical* failure shape from the *live* capture
(same stack, same `{W_YIELD: 1, W_PARKED: 0}`) without needing gc-slice.ts, load, or CDP at all.
Whatever the precise live trigger inside the browser (a worker OS thread scheduled late relative to
main after storing its own ack -- plausible under the load this needed to reproduce, and outside
what static reading alone can confirm), the *mechanism* the coordinator named is real, is a strictly
better-supported explanation than fix round 1's own guess, and is now fixed at its actual source.

**Fix.** `runBlockingLoop` (`worker/shell.ts`) now checks `W_YIELD` at the top of every pass through
its loop, *before* calling `waitForWake`, not only after one returns -- covering the loop's own
first pass (right after the entry drain) the same way as every later one, and uniformly for all
three callers (`worker.ts`'s first entry, `Shell.resume()`, `Shell.runAsync`'s re-entry) without
changing any of them. The post-wait check was removed rather than kept alongside the new one: it is
not needed for correctness (the top-of-loop check now covers every wait), and the only thing it
bought was skipping one possible extra `runBodyOnce` call on the rare pass where a wake turns out to
also carry a park request -- a harmless, allocation-free extra call, not a hot-path concern (park is
rare, not per-frame). `waitForWake` itself (`sab/control.ts`) is untouched, as the brief's own
binding rule required -- `sab/no-alloc-syntax.test.ts` still passes, having pinned only that method.

**`Shell.resume()`'s own step order was left unchanged** (`W_YIELD = 0` still stored before
`observeWake()`). Reasoned through explicitly, since the brief asked for a choice: the new
before-every-wait check re-validates `W_YIELD`'s *current* value at the exact instant before
blocking, regardless of what `last`/`seen` captured or when -- so whichever order `resume()` uses,
a park signal already visible by the time the loop is about to wait is always caught. Reordering
would only matter if some *other* window depended on it, and none does: `W_YIELD` is a flag this
worker reads on itself, never a value another thread polls to decide whether to interact with it
(unlike `W_PARKED`, whose own ordering relative to `observeWake` is untouched and still load-bearing
for `resumeWorkers`'s poll). Changing it would be motion with no corresponding safety gain.

**Test, built to construct the race directly (not to reproduce it live), and checked red then
green.** `shell.checks_yield_before_its_own_first_wait` (`src/worker/shell.test.ts`), beside the
existing `shell.resume_does_not_lose_a_wake` this mirrors: on one thread, store `W_YIELD = 1` and
call `control.wake(INDEX)` *before* reading `seen = shell.observeWake()` -- exactly the ordering the
coordinator's trace describes, with a finite `timeoutMs` (`WAIT_MS = 400`, this file's own constant)
so a still-broken protocol times out instead of hanging the test -- then calls `runBlockingLoop`
with that `seen` as `lastSeen` and asserts it returns quickly, having parked, having run `body` only
once (the entry drain).

Checked red by temporarily reverting only `runBlockingLoop` (`git checkout HEAD -- src/worker/
shell.ts`, saving the diff first; the new test stayed in place) and running `pnpm test unit -t
"shell.checks_yield_before_its_own_first_wait"`:
```
FAIL unit shell.checks_yield_before_its_own_first_wait
  AssertionError: expected 410.29420899999997 to be less than 200
```
410 ms is the full `WAIT_MS` (400) plus overhead -- the base protocol genuinely blocked for the
whole timeout, exactly as the trace predicted, before its post-wait check finally saw `W_YIELD = 1`
and broke out. The fix was then re-applied (`git apply` of the saved diff): `unit pass 1 tests`
(0.8s), and the existing two `shell.*` tests plus `sab/no-alloc-syntax`/`atomics-timer` tests stay
green (`pnpm test unit -t "shell\."` -- 3 passed; `pnpm test unit -t "no_alloc_syntax|atomics.timer"`
-- 6 passed).

**`rewakeUnparked` reverted.** `parkWorkers` (`src/test/client.ts`) is back to a single `wake()` per
worker up front and `pollUntil(() => allEqual(h, W_PARKED, 1), ...)`, byte-identical to before this
milestone (`git diff bec19fd..HEAD -- src/test/client.ts` now shows only a comment explaining why
it is *not* retried, no behavioural change). `workers.park_recovers_from_missed_notify`
(`tests/browser/workers.spec.ts`) and its `__testParkRecoversFromMissedNotify` hook
(`tests/browser/pages/src/topology.ts`) were removed along with it (`git checkout bec19fd --
tests/browser/workers.spec.ts tests/browser/pages/src/topology.ts`): that test exercised the
harness-level symptom (a dropped notify to an already-registered waiter), which fix round 1's own
retry papered over rather than fixing, and which fix round 2 no longer needs to simulate separately
-- `shell.checks_yield_before_its_own_first_wait` exercises the real mechanism directly.

**Production paths, checked (binding rule: say whether a production worker could hit this).**
`grep -rn "\.resume(\|runAsync(" src/` (excluding tests) finds exactly three call sites of
`runBlockingLoop`'s own re-entry: `worker.ts`'s first entry (once, at startup, before `ready`
posts), `Shell.resume()` (called only from `worker.ts`'s own `onmessage` on a `{ type: 'resume' }`
message), and `Shell.runAsync`'s own re-entry (defined, not yet called by any shipped kind body --
reserved for a Promise-only host API, M23). **`{ type: 'resume' }` is posted only by `engine/test`'s
`resumeWorkers`** (`grep -n "type: 'resume'" src/client.ts` -- nothing; M06b Deviations already
recorded this: "`resume`/`stop` are posted only by `test/client.ts`'s `resumeWorkers`/`parkWorkers`
-- reserved for whichever later milestone... drives them from production code"). **A production
`createClient()` result today never calls `resume()` again after a worker's own first entry, and
never calls `runAsync` at all** -- this race is unreachable in production as shipped: a production
worker enters `runBlockingLoop` once and stays there (or traps) until `destroy()` terminates it
outright. It is a live, real gap in the *protocol* `engine/test`'s own harness already exercises
today, and a **latent one** for whichever future milestone wires real backgrounding pause/resume for
a production client worker (`FrameLoop.pause()/resume()`, `src/frame-loop.ts`, is the *main-thread*
rAF loop and is unrelated -- it never touches `Shell.resume()`/`W_YIELD` at all): if that milestone
ever issues a park-like signal that can land in the gap this fix closes, the consequence there would
be the same one this milestone found -- a worker thread permanently blocked in `Atomics.wait`
(`timeoutMs()` is `Infinity` for every kind but `sim`'s own future tick deadline), invisible except
as a silent freeze, since nothing in production polls `W_PARKED` the way `parkWorkers` does.

**Hot-path re-check.** `runBlockingLoop` is not test-only -- it is the blocking-loop shell *every*
worker kind runs inside, so the reordered check runs on every real wake of every isolate, not only
during a park. `pnpm gc -t "gc-loop|topology|echo|zero_gc_action"` -- **34 passed (12.2s)**: every
clean measurement and every `object`/`burst` negative control on every named isolate of every
affected page still trips on its own isolate only, `gc: flat transport parity` still passes, and no
`budgets.json` number changed (unchanged by this milestone throughout).

**Reproduction re-run, protocol fix in place, harness re-wake reverted** (the same two configurations
that found the failure in step 1, foreground, this machine's own `uptime` noted before each):
- `--repeat-each 15 --workers 3` + 10 self-terminating burners (`uptime` 4.65/3.44/6.09 before):
  **60 passed (36.4s)**, 0 failures.
- `--repeat-each 25 --workers 3` + 14 burners (`uptime` 15.76/6.47/7.05 before, climbing to 18.94
  mid-run -- this machine's own ambient load, unrelated to this session, step 1's own note): **100
  passed (1.0m)**, 0 failures.

160/160 total on the exact configurations that previously reproduced the stall 2/15 and 1/25.

### Step 3, fix round 3: the same class of defect in the M03/M04 harness

The coordinator's own quiet loop caught a second, independent occurrence while gating fix round 2:
`gc-loop neg object main`, `` park('sim'): timed out after 10000 ms workers=[{"name":"sim",
"Req":3500,"Ack":3500,"State":1,"Yield":1,"armed":true}] `` -- `src/test/harness.ts`/`harness-
worker.ts`'s own M03/M04 protocol (`gc-loop`'s own page uses `createHarness`, not a real
`createClient()`), out of this brief's original Files list until this round widened it to include
both files.

**Trace, checked against the code.** `harness.ts`'s `parkOne`: `Atomics.store(h.sab, Yield, 1)` then
`Atomics.notify(h.sab, Req)` -- its own doc comment: "Wakes a worker blocked in `Atomics.wait`
*without touching `Req`/`Ack`*... keeps `Req === Ack` true across a park." `harness-worker.ts`'s
`armedLoop`:
```
let last = Atomics.load(block, Req)
Atomics.store(block, State, Armed)
post(ARMED)
for (;;) {
  Atomics.wait(block, Req, last)                    // <- first/every wait: no yield check before
  if (Atomics.load(block, Yield)) break              //    checked only after
  ...
}
```
Confirmed, unambiguously: no check before any wait, first or later. `WorkerState.Armed` is `1`
(`step-block.ts`), matching the captured `"State":1`. **This is a stricter defect than
`runBlockingLoop`'s own** (fix round 2): `sab/control.ts`'s `wake()` always bumps the word it waits
on, so even a yield-check that races is self-healing (the subsequent `Atomics.wait` sees a value
mismatch and returns without blocking, M17c fix round 2's own analysis). `parkOne`'s own notify does
*not* change `Req`, so a worker that reaches `Atomics.wait(block, Req, last)` *after* `parkOne`'s one
notify already fired sees `Req` still equal to `last` and genuinely, permanently blocks (no timeout
argument on this call at all) -- there is no self-healing case here, only "was a waiter already
registered at the exact instant of the one notify."

**Fix.** `armedLoop` (`src/test/harness-worker.ts`) now checks `Yield` at the top of the loop, before
every `Atomics.wait` call including the first, mirroring `runBlockingLoop`'s own fix. The *existing*
post-wait check is kept, not removed, unlike `runBlockingLoop`'s: `runOp` is not idempotent (it
always calls `sim_tick()`/`sim_admit()` unconditionally), so a `parkOne` notify that lands while this
thread is already a registered waiter still wakes it (`Atomics.wait` returns "ok" on any notify
regardless of whether the value moved) -- without the second check this loop would treat that wake as
a fresh step and re-run the same, unchanged `Req`, a real double-tick. Exported (`export function
armedLoop`) for the new test below.

**Test, built directly against `armedLoop` (the "smallest browser test" fallback: a plain Node unit
test cannot drive it -- `self`/`postMessage` do not exist under Vitest's `node` environment for the
`unit` project, and a still-broken, timeout-less `Atomics.wait` cannot be safely bounded from the
same thread it blocks).** New files: `tests/browser/pages/src/armed-loop-race-worker.ts` (a minimal
worker that calls the exported `armedLoop` directly against a caller-supplied step block, posting a
plain `'returned'` string when it returns -- distinct from `armedLoop`'s own `{type:'armed'}`/
`{type:'parked'}` protocol messages, which fire well before any wait and are not the completion
signal), `tests/browser/pages/src/armed-loop-race.ts` (`armed-loop-race.html`'s script: stores
`Yield = 1` on a fresh step block *before* ever starting the worker -- constructing the race
directly rather than timing a real `parkOne` round trip -- then races the worker's own `'returned'`
message against an external `setTimeout` + `worker.terminate()`, since a hung `Atomics.wait` blocks
its own thread with nothing to bound it from inside), `tests/browser/armed-loop-race.spec.ts`
(`harness-worker.armed_loop_checks_yield_before_its_first_wait`).

Checked red first with a real bug in the test itself, worth recording: the first version's
`worker.onmessage` treated *any* message as completion, so it resolved `'returned'` immediately on
`armedLoop`'s own `post(ARMED)` (sent before the loop even starts) without ever actually waiting for
the real result -- passing on both the buggy and fixed protocol, a false green. Fixed by filtering
for the literal `'returned'` string. With that fixed, checked red on the base protocol (`export`
added but the loop body left unfixed):
```
FAIL browser [chromium] harness-worker.armed_loop_checks_yield_before_its_first_wait
  Error: expect(received).toBe(expected) // Object.is equality
  Expected: "returned"
  Received: "timed-out"
```
The worker genuinely hung for the full 3,000 ms bound, never returning. With the real fix restored:
`browser pass 1 tests 1.9s/25s`; reliability `--repeat-each 10` -- **10 passed (3.0s)**.

**`gc-loop`'s own negative controls, budgets unchanged:** `pnpm gc -t "gc-loop"` -- **7 passed
(3.0s)**: `clean`, every `object`/`burst` negative control, the `post-message` control, and `gc:
flat transport parity` all still pass; no `budgets.json` number touched.

**Searched for every other `Atomics.wait` loop in `src/`/`tests/`** (`grep -rn "Atomics\.wait\("`,
excluding comments and `dist/`):
1. `src/sab/control.ts`'s `waitForWake`, called from `worker/shell.ts`'s `runBlockingLoop` --
   **already fixed, fix round 2.**
2. `src/test/harness-worker.ts`'s `armedLoop` -- **fixed this round.**
3. `tests/browser/wiring.spec.ts`'s `` Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,
   50) `` -- a one-shot smoke probe ("wiring: crossOriginIsolated and Atomics.wait in the worker"),
   not a loop, no yield/stop flag, asserting only that the primitive itself works and times out with
   no waiter. **Not the same shape; no fix needed.**

No fourth site exists to check by hand: `src/sab/no-alloc-syntax.test.ts`'s own `sab.
atomics_wait_confined` (already in the suite, unmodified, reconfirmed green) walks every non-test
file under `src/` and fails if `Atomics.wait(` appears anywhere but `sab/control.ts` or `src/test/**`
-- an existing, automated guarantee that (1) and (2) above are the *only* two production/harness call
sites in `src/`, not just the only two this session happened to find by hand.

### Not run

Per the delegation prompt's own binding rules, `pnpm test`/`pnpm lint` were not run by this session
(the orchestrator gates); `pnpm typecheck` (part of `pnpm lint`) was run directly and is clean.

### Exit criterion: `node scripts/repeat.mjs browser 15` / `... 15 --load 10`

**Fix round 1 measurement (superseded by fix round 2's own re-measurement, below), kept for the
record:** run once each, foreground, per-run kill timeout, after fix round 1 (commit `4a0dc7d`) --
`browser x15 load=0: pass=15 fail=0 hang=0 slowestSuiteSeconds=23`; `browser x15 load=10: pass=14
fail=1 hang=0 slowestSuiteSeconds=31`, the one failure being `src/test/harness.ts`'s own unrelated
`park('sim')` wait (a different file, a different message shape, not this brief's Files list; see
the note below).

**Fix round 2 re-measurement**, after reverting `rewakeUnparked` and landing the real
`runBlockingLoop` fix -- run in the foreground, in batches of 7-8 to fit comfortably inside a single
10-minute call rather than one long 15-run call (no loop backgrounded this round):
- `node scripts/repeat.mjs browser 8` then `... 7`: **`pass=8 fail=0 hang=0 slowestSuiteSeconds=22`**
  then **`pass=7 fail=0 hang=0 slowestSuiteSeconds=23`** -- 15/15 total, 0 failures.
- `node scripts/repeat.mjs browser 8 --load 10` then `... 7 --load 10` (`uptime` 12.17/10.52/9.84,
  then 22.47/20.58/15.86 before the second batch -- this machine's own ambient load climbing
  independently, per step 1's own note): **`pass=8 fail=0 hang=0 slowestSuiteSeconds=28`** then
  **`pass=7 fail=0 hang=0 slowestSuiteSeconds=28`** -- 15/15 total, 0 failures, including 0
  recurrences of fix round 1's own `harness.ts` `park('sim')` failure this time.

### Notes for later briefs

- **Resolved by fix round 2:** the root mechanism behind the missed park signal is named and fixed
  (`runBlockingLoop` now checks `W_YIELD` before every wait, including its own first one). The
  remaining open question is narrower: this session could not place the *live* trigger (a concurrent
  `parkWorkers` call) inside gc-slice.ts's own strictly-sequential per-pass `resume()` gap by static
  reading alone (Step 3, fix round 2, "Where this session's own live occurrence sits, honestly") --
  the deterministic unit test proves the mechanism without needing to. If a `parkWorkers`-shaped
  stall is ever seen again with the *exact same* captured shape, the fix here should already prevent
  it; a *different* shape would be a materially different finding worth its own brief.
- **Latent production risk, not yet reachable (fix round 2, "Production paths, checked"):** a
  production `createClient()` result never calls `Shell.resume()`/`runAsync` again after a worker's
  first entry today, so this race is unreachable in production as shipped. Whichever future
  milestone wires real backgrounding pause/resume for a production client worker should re-read that
  section before assuming `resume()`/`runAsync` re-entry is safe to drive from a second, independent
  signal source the way `parkWorkers` is here.
- `worker/gen.ts`'s own yield-free drain loop (flagged, not fixed, M16e) remains open and unrelated
  to this occurrence.
- **Resolved by fix round 3:** `src/test/harness.ts`/`harness-worker.ts` (M03/M04 harness,
  `gc-loop`'s own page) had the same class of defect as fix round 2's own `runBlockingLoop`, and a
  stricter one: `armedLoop` now checks `Yield` before every wait including its first, and the
  existing post-wait check is kept alongside it because `runOp` is not idempotent (a coincidental
  wake-plus-park would otherwise double-tick the sim). Confirmed by `sab.atomics_wait_confined`
  (`src/sab/no-alloc-syntax.test.ts`) that these two files' own `Atomics.wait(` call sites --
  `sab/control.ts`'s `waitForWake` and `harness-worker.ts`'s `armedLoop` -- are the *only* two in all
  of `src/`, so no third site of this shape exists there to find later.
