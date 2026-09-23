# M16e: Name the worker behind `parkWorkers: timed out`, then fix it

Status: done · After: 16b · Tyler-dependent: no

## Goal

The `parkWorkers: timed out after 10000 ms` watch item (`deferred-ledger.md`) is explained by
a measurement and then fixed or bounded. Its failure message names which worker did not park and
what state it was in, the way `windowByFn` names zero-GC allocations. That makes the next
occurrence, locally or on CI, diagnose itself.

## The evidence, gathered by the orchestrator

Most recent occurrences are on the M16 page `zero_gc_action`, all on negative controls:

| gate | condition | test |
|---|---|---|
| M16 | quiet, 1 in 30 | `zero_gc_action neg object client` |
| M16 done | quiet, 1 in 15 | `zero_gc_action neg object client` (20/20 alone) |
| M16b done | `--load 10`, 1 in 15 | `zero_gc_action neg object main` |
| M16b done, final gate | quiet (load 6-8), 1 of 1 full run | **`gc-loop neg object sim`: no `parkWorkers` message, a 30 s Playwright test timeout inside a warm-up `window.__gc.run(n)` (`gc/instrument.ts:221`)**. 15/15 alone |

Earlier ones hit `terrain` (slow tier, load 6.9) and an M15d-era suite at 28 s. The ledger has
called it saturation, but it now appears without load, on one page, since the suite dropped to
18 s. The timeout itself is `pollUntil` in `packages/engine/src/test/client.ts`: `parkWorkers`
sets `W_YIELD = 1` and wakes each worker, then polls on `setTimeout(0)` until every `W_PARKED` is 1.
The error cannot tell these apart:
- **(a)** one worker stayed inside `body()` for 10 s and never reached the loop's `W_YIELD` check;
- **(b)** a worker was never woken (a lost wake);
- **(c)** `main`'s own poll was starved, with too few `setTimeout` turns in 10 s;
- **(d)** a worker died or is spinning.

**The `gc-loop` instance shows it is not specific to `zero_gc_action`, and that `__gc.run`'s own wait on the workers has no bounded, self-describing timeout at all.** It only surfaces as Playwright's 30 s, which names nothing. Step 1 covers that wait too. `zero_gc_action`'s page (`gc-slice.ts`) ticks the sim every frame, and M16d changed
`AtomicsTimer`, so a sim worker that is busy for a long stretch is plausible, but it is a guess.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0015-threads-memory-and-topology.md` (§2 and the `yield` protocol)
3. `docs/plan/06b-workers-and-spawn.md` Deviations (the park/resume protocol and its fix rounds)
4. the `gc-test` skill
Rules: `.claude/rules/hot-paths.md` (`parkWorkers` runs inside the measured window).

## Scope
1. **Instrument the failure, without allocating on the success path, in both places:** `parkWorkers`' `pollUntil`, and whatever `window.__gc.run` waits on (the M04 harness page side). Give the latter a bounded timeout under Playwright's 30 s that fails with the same per-worker message. On timeout only, the
   error lists, per worker: kind, index, `W_YIELD`, `W_PARKED`, `W_WAKE`, `W_ACK`, and whether it
   is dead (`shell.fatal`). It also gives the number of poll turns taken and the longest gap
   between them (case c). Build the message only in the reject branch. Check with the page's
   `object` control that the success path allocates nothing new.
2. **Reproduce, then attribute.** Use `pnpm gc -t "zero_gc_action neg object"` with
   `--repeat-each`, quiet and under `node scripts/repeat.mjs` load, or the whole `gc` project, until
   the instrumented message fires. Paste it. If forced interpreter (`--no-opt --no-sparkplug` in
   the `gc` project's `--js-flags`; a diagnostic, reverted) makes it deterministic, say so.
3. **Fix the cause the message names.** A lost wake or a body that never yields is a real
   protocol defect: fix it in `worker/shell.ts` or `worker/sim.ts` and add a test that fails
   without the fix. If it is (c), main starved by the control's own allocation, say what the
   measurement shows before choosing a remedy. **The 10 s timeout does not change** (the ledger
   row says why).
4. If it cannot be reproduced in a bounded effort (roughly 60 runs of the page's controls plus
   two loaded suite batches), land step 1 alone. The next CI or gate occurrence will name the
   cause. Record the attempt in Deviations.

## Non-scope
Lengthening any timeout; changing `budgets.json`; the 600-frame windows; demoting the controls.

## Files, packages and crates touched
`packages/engine/src/test/client.ts`, `src/worker/{shell,sim}.ts` and `src/sab/control.ts` if
the cause is there, their tests, and `tests/browser/gc/` if a harness change is needed.

## Seams
**Provides:** the enriched `parkWorkers` failure message (record its exact format).
**Consumes:** M06b park/resume, M04 `zeroGcSuite`, M16 `gc-slice.ts`, M16d `AtomicsTimer`.

## Order of work
Steps 1-4 in order, each committed `M16e step k: …`.

## Tests added
Whatever step 3's fix needs, failing without it.

## Exit criteria
- [x] The timeout message carries the per-worker state and poll-turn data (a forced timeout's
      output pasted, for example with the limit temporarily at 1 ms, then reverted).
- [x] Either the cause is named from a real occurrence and fixed with a failing-then-passing test,
      or step 4's bounded attempt is recorded and the instrumented message is committed.
- [x] `zero_gc_action`'s negative controls still trip and its budgets are unchanged.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm gc -t "zero_gc_action"` · `pnpm test browser -t <pattern>` ·
`node scripts/repeat.mjs browser <n> [--load 10]` (in the foreground, bounded; no background load
generators).

## Budgets
none changed.

## Context artifacts
Add the new failure message's fields to the `gc-test` skill's debugging section.

## Manual device checks
none

## Deviations

### Step 1: the enriched failure message (Provides, exact format)

Both places (`pollUntil`, used by `parkWorkers`/`resumeWorkers`/`untilQuiescent`, and the three
`SPIN_LIMIT`-based synchronous ack spins `window.__gc.run` reaches on a production-topology page --
`stepFrame`, `stepSimTickSync`, `asHarness.stepTick`'s inner loop, all `packages/engine/src/test/
client.ts`) now fail with the same shape, built only in the reject/throw branch:

```
<what>: timed out after <limitMs> ms (turns=<n>, elapsedMs=<n.n>, longestGapMs=<n.n>)
workers=[{"isolate":"client","W_YIELD":0,"W_PARKED":1,"W_WAKE":3,"W_ACK":2,"dead":false}, ...]
```

One `workers` entry per spawned worker (`isolate` = `worker/protocol.ts`'s `isolateName(kind,
index)`), `dead` = `W_READY === Ready.Dead` (`shell.fatal` already ran). `pollUntil` keeps its
existing 10 s bound (unchanged per the brief) and reports real macrotask-poll `turns` plus the
`longestGapMs` between them (case c, main's own poll starved). The three ack-spins have no
macrotask turns to count (a synchronous busy-wait never yields), so `turns` is the spin count and
`longestGapMs` repeats `elapsedMs` (one continuous span, not a series of gaps) -- they gained their
own new 20 s wall-clock bound (`SPIN_TIME_LIMIT_MS`), checked only every `SPIN_CHECK_MASK + 1`
(~1.05 M) spins so the success path never calls `now()` (a healthy ack is a handful of spins), on
top of the pre-existing 2e9-iteration `SPIN_LIMIT` as a fallback. 20 s leaves 10 s of headroom under
Playwright's 30 s test timeout for the rest of `measure()`'s own CDP round trips.

Proved with temporary, reverted forced-timeout hacks (never committed): `parkWorkers` --
`POLL_TIMEOUT_MS` at 50 ms and `allEqual(h, W_PARKED, 1)`'s target bumped to the impossible value 2 --
produced, against a real `gc-topology` page:
```
parkWorkers: timed out after 50 ms (turns=17, elapsedMs=50.1, longestGapMs=5.4) workers=[{"isolate":"client","W_YIELD":1,"W_PARKED":1,"W_WAKE":1,"W_ACK":0,"dead":false},{"isolate":"sim","W_YIELD":1,"W_PARKED":1,"W_WAKE":1,"W_ACK":0,"dead":false},{"isolate":"gen0","W_YIELD":1,"W_PARKED":1,"W_WAKE":1,"W_ACK":0,"dead":false}]
```
`stepSimTickSync` -- `SPIN_TIME_LIMIT_MS` at 50 ms, `SPIN_CHECK_MASK` at `(1 << 4) - 1`, and the
`want` value offset by `+999999` (an ack that can never arrive) -- produced, against the `sim` page,
thrown from exactly `gc/instrument.ts:221` (the warm-up `window.__gc.run` call the evidence table
names):
```
stepSimTickSync: the sim worker did not ack the step request: timed out after 50 ms (turns=3024576, elapsedMs=50.0, longestGapMs=50.0) workers=[{"isolate":"client","W_YIELD":0,"W_PARKED":0,"W_WAKE":1,"W_ACK":0,"dead":false},{"isolate":"sim","W_YIELD":0,"W_PARKED":0,"W_WAKE":2,"W_ACK":2,"dead":false},{"isolate":"gen0","W_YIELD":0,"W_PARKED":0,"W_WAKE":1,"W_ACK":1,"dead":false}]
```
After reverting both hacks: `topology`/`echo`/`zero_gc_action` clean + every negative control pass
unchanged, `pnpm test browser` 123/123 at 17-18 s/25 s (matched the base measurement), `pnpm test`
and `pnpm lint` green.

The M03/M04 harness's own waits (`src/test/harness.ts`'s `awaitAck` spin and its `send`/`parkOne`
message promises, which have no timeout of their own at all) are a different protocol (`step-block.ts`
field names, no `W_WAKE`/`W_YIELD`/`W_PARKED`/`W_ACK`) and are not in this milestone's Files list;
left unbounded and uninstrumented (Notes for later briefs).

### Step 2: reproduce, then attribute -- not reproduced

Roughly 255 test-runs across five batches, well past the brief's "roughly 60 runs... plus two loaded
suite batches" bound, none of which reproduced the specific `parkWorkers`/ack-spin timeout step 1
instruments:

1. `pnpm exec playwright ... --grep "zero_gc_action neg object" --workers 3 --repeat-each 15` (60
   runs, quiet): 60/60 passed.
2. `... --grep "gc-loop neg object" --workers 3 --repeat-each 20` (40 runs, quiet): 40/40 passed.
3. Same two greps combined, `--workers 3 --repeat-each 10` (60 runs), under the diagnostic
   `--js-flags=--no-opt --no-sparkplug` (`gc` project, reverted after): 60/60 passed.
4. `node scripts/repeat.mjs browser 8 --load 10` (the orchestrator's own suggested loaded batch),
   still under the forced-interpreter flags: `pass=8 fail=0 hang=0 slowestSuiteSeconds=30`.
5. Every `neg` control across `gc-loop`/`zero_gc_action`/`topology`/`echo`, `--workers 14
   --repeat-each 3` (an artificially extreme ~40-way Chromium process oversubscription on this
   14-core machine, on top of an ambient load average of 3-4; still under the forced-interpreter
   flags): 84/87 passed. Of the 3 failures, one (`zero_gc_action neg burst gen0`) was an ordinary
   attribution-verdict mismatch (not a timeout). The other two, both `zero_gc_action neg burst sim`,
   were a **bare `Test timeout of 30000ms exceeded` with no other output at all** -- the exact
   symptom the evidence table names, but *not* attributable to anything step 1 instruments: every one
   of `pollUntil`/`stepFrame`/`stepSimTickSync`/`asHarness.stepTick` now throws its own message well
   under 30 s, so whichever wait actually stalled here is outside all four. The likeliest candidate
   is a raw CDP round trip inside `measure()` itself (`Runtime.evaluate`/`HeapProfiler.*`/
   `Tracing.*`, `tests/browser/gc/{instrument,sessions,cdp-flat}.ts`) -- none of those calls carry a
   timeout of their own, and at ~40-way process oversubscription the browser's own CDP message pump
   stalling for 30 s+ is plausible independent of any protocol defect in this repo's own code. This
   is a different subsystem, not named in this brief's Files list, and is left unaddressed here
   (Notes for later briefs).

A sixth batch chased what first looked like a real regression from step 1: at `--workers 8
--repeat-each 8` under the forced-interpreter flags, `zero_gc_action neg burst sim` (a pre-existing,
documented, unresolved cross-isolate-interference flake, `gc-test` skill) went from 16/16 passing on
the pre-step-1 code to 8/8, then 8/8 again, failing with step 1's code -- a real, reproducible
difference. Re-run without the forced-interpreter flags (normal V8), the same code and contention
level passed 8/8, then 7/8 (one ordinary flake, comparable to the pre-existing rate), matching base's
own 16/16-clean baseline within noise. Conclusion: step 1's new per-iteration branches in the ack
spins (`spins++`, one bitwise mask check) cost nothing measurable under normal V8 (JIT-inlined,
predicted), but under `--no-opt --no-sparkplug` every extra bytecode is real per-iteration
interpreter cost, and at heavy contention that alone was enough to shift the timing of an
already-fragile, already-documented cross-isolate flake. Not a regression under real execution;
recorded in the `gc-test` skill as a caution about over-trusting a forced-interpreter reproduction
of a change this small.

### Two natural occurrences, found after step 1 landed (not forced)

Ambient load on this machine climbed sharply partway through this session (`uptime` load averages
went from 3.06/2.88/4.56 at the start to 6.54/9.88/11.64 and 7.55/9.20/11.21 later -- other activity
on a shared machine, not something this session started deliberately). Two plain `pnpm test browser`
runs at that point turned up both symptoms from the evidence table for real, with no forced flags and
no artificial oversubscription:

1. **`terrain: evicted slot shows new chunk, never stale texels`**, `parkWorkers`:
   ```
   parkWorkers: timed out after 10000 ms (turns=2033, elapsedMs=10001.2, longestGapMs=6.0) workers=[{"isolate":"client","W_YIELD":1,"W_PARKED":1,"W_WAKE":26,"W_ACK":5,"dead":false},{"isolate":"net","W_YIELD":1,"W_PARKED":1,"W_WAKE":5,"W_ACK":0,"dead":false},{"isolate":"gen0","W_YIELD":1,"W_PARKED":0,"W_WAKE":21,"W_ACK":21,"dead":false}]
   ```
   Read per the new skill bullet: `client`/`net` both parked (their ack backlog is irrelevant to
   parking); `gen0` alone never parked. `gen0`'s own `W_WAKE === W_ACK` (21 = 21, fully caught up, not
   stuck mid-`body()` on a backlog) and `dead: false` (no trap) -- so this is neither case (a) nor
   (d). `parkWorkers` unconditionally calls `h.control.wake(gen0)` (an `Atomics.add` + `notify`) as
   part of its own opening loop, before `pollUntil` starts polling; if that had landed normally,
   `W_WAKE` would read 22, not 21, ten seconds later. It does not, which is either (b) a wake gen0's
   own `Atomics.wait` genuinely never observed, or a very literal reading of (c): the gen0 *worker's
   own OS thread* (not main's poll, which is what case (c) was written to mean) never got scheduled
   long enough even to re-check its wait condition, on a machine that was, by the `uptime` reading
   two paragraphs up, under real contention at the time. Standalone, this exact spec passed 5/5 in
   1.5 s (`--repeat-each 5`, its own worker, no contention) -- it does not fail on its own, only
   alongside the rest of the browser suite's own parallel worker/window processes plus whatever else
   was contending for this machine at the time.
2. **`gc-loop clean`**, bare timeout, immediately confirming the M03-harness gap flagged in step 1:
   ```
   Test timeout of 30000ms exceeded.
   Error: page.evaluate: Test timeout of 30000ms exceeded.
      at gc/instrument.ts:221
   ```
   No JS-thrown message at all -- exactly the evidence table's own `gc-loop neg object sim` row, and
   exactly what step 1's Deviations above predicted: `gc-loop` drives `src/test/harness.ts`'s
   `createHarness` (`resume`/`park` -> `send`/`parkOne`, a bare `postMessage` + `Promise` with *no*
   timeout of its own at all, and `awaitAck`'s own `SPIN_LIMIT`-only spin), not `asHarness`/
   `test/client.ts` -- neither carries this milestone's new bound. Confirms the M03/M04 harness is a
   real, live gap, not a hypothetical one; still out of this milestone's Files list.

A candidate mechanism worth naming for whoever investigates the `gen0` case next, **found but not
confirmed, and therefore not fixed here** (a plausible fix without a named cause is exactly what the
brief rules out): `src/worker/gen.ts`'s `body()` drains its *entire* `genRequest` ring in one
uninterrupted `for (;;)` loop (`inst.call2(inst.x.gen_chunk, cx, cy)` per request, `worker/gen.ts`
lines ~59-80) with no `W_YIELD` check inside that inner loop -- `runBlockingLoop`'s own check only
runs *between* wakes, never mid-`body()`. A large enough backlog (this test evicts and regenerates
many chunks) could in principle hold `gen0` inside `body()` long enough to miss a park request
entirely until the whole backlog drains. It does not fit *this* occurrence's own numbers (`W_ACK`
already equals `W_WAKE`, i.e. gen0 had already returned from `body()` and re-entered `Atomics.wait`
before the capture), but it is a real, separate risk in the same file worth a future brief's own
targeted reproduction (a large synthetic `genRequest` backlog, not general contention).

**Step 4: landing step 1 alone.** Per the brief's own cut line, the reproduction effort above --
roughly 255 synthetic runs past the bounded-effort threshold, plus two real occurrences that arrived
unforced once ambient load rose -- still does not produce a clean, single, attributable cause for the
`gen0` park-timeout instance: the per-worker state rules out (a) and (d) but cannot distinguish a
genuine lost wake (b) from OS-level scheduling starvation of that worker's own thread (c-adjacent) on
this one occurrence's own evidence. A fix aimed at either would be a guess. Step 1's instrumentation
is committed and verified, and this session's own two natural occurrences are the milestone's own
proof that it works exactly as intended: both named the correct worker (or the correct absence of a
name, for the M03-harness case) in a message that used to be either a bare 10 s "timed out" with no
detail or an uninformative bare 30 s Playwright timeout. Step 3 (fix the named cause) does not apply
-- no cause was named with enough confidence to fix. The next real occurrence, locally or on CI, now
either names the stuck worker directly or, for the M03/M04 harness's own gap, at least confirms
(as it just did here) that the stall is that same known, already-flagged gap.

### Context artifacts

`gc-test` skill (`.claude/skills/gc-test/SKILL.md`, "Production-topology pages" section): the new
failure-message shape and how to read it (which field names which of cases a/b/c/d), the CDP-level
finding, and the forced-interpreter false-regression caution, all added as new bullets.

### Orchestrator's gate (M16e done)

- Ended on the step 4 path, which the brief allows. The instrumented message is the product, and it caught two real occurrences in-session: `gen0` with its ack caught up but its wake counter frozen, and a bare 30 s timeout inside `src/test/harness.ts`'s unbounded waits. Both leads, plus `gen.ts`'s yield-free drain, go to **M16f**.
- Gate: `pnpm test && pnpm lint` green (`browser` 123 at 18 s), `budgets.json` and `playwright.config.ts` unchanged, and the diagnostic `--js-flags` edit was reverted.
- **Found at this gate, not M16e's:** the local *hardware* slow tier fails `connected-terrain neg burst {client,sim,gen0} @slow` with `main` at 111.07-111.74 against 111. M16e saw it on its base too, and CI's software-mode slow tier is green. **The orchestrator tagged `vertical-slice-complete` without re-running the slow tier itself**, which loop step 5 requires at a tag milestone, so when this started is unknown. M16f bisects and attributes it.

