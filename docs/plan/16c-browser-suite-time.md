# M16c: Bring the `browser` suite back inside its budget

Status: not started · After: 16 · Tyler-dependent: no

## Goal

`pnpm test browser` runs in under 25 s quiet on Tyler's Mac, and in under 37.5 s (0020 §2's
failure line) in 15 of 15 runs under `node scripts/repeat.mjs browser 15 --load 10`. It gets there
without widening any budget, loosening any assertion, or demoting a test that does not meet 0020
§4's criterion. Each change is backed by a measurement of where the time went, taken before the
change.

## The problem, measured by the orchestrator at M16's gate

`test-results/browser/report.json` from a quiet `pnpm test browser` on `9d9706b`:

```
n 116   summed test work 72.9 s   workers 3   wall 26.7 s   p95 2.09 s
by project: gc 45.1 s, chromium 27.7 s
5704 ms  vertical_slice                    chromium   <- the only test over §4's 3 s
2147 ms  echo clean                        gc
2128 ms  echo neg object main / client / gen0 / sim   gc  (each ~2.1 s)
1821 ms  poll_skips_a_spurious_tick_on_a_ring_wake   chromium
1763 ms  workers.park_resume               chromium
```

Wall time is roughly summed work divided by `workers: 3` (`packages/engine/playwright.config.ts`).
Under `--load 10`, 9 of 15 runs failed on the suite budget alone (38-45 s) and no assertion
failed. **The demotion ladder is exhausted** (0020 §4: nothing but `vertical_slice` exceeds the
3 s p95), so the time has to come from making tests cheaper or from parallelism.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` (§2 thresholds, §3 budgets, §4 demotion rule)
3. `docs/decisions/0016-zero-gc-definition.md` (§3, the measurement procedure) and
   `0028-zero-gc-two-measured-windows.md`; the `gc-test` skill
4. `docs/plan/16-action-round-trip.md` Deviations: "gate round: vertical_slice pixel flake" and
   "Orchestrator's gate (M16 done)"

## Scope

1. **Attribute before changing.** For `vertical_slice` and for one `echo` zero-GC test, record
   where the wall time goes (page load and build, worker boot, `client.ready`, each phase or each
   window, park/resume, teardown), using `performance.now()` marks in the spec or Playwright's
   trace. Write the table into Deviations. Fix nothing until it exists.
2. **Shrink `vertical_slice` under 3 s.** It is the only test covering the vertical slice, so §4
   forbids demoting it: shrink its scenario instead. **Every phase's assertion stays**, including
   the pre-paint `GRASS` read, `TOL`, the atomic `__probeTile` and the `__sliceSettle` waits (M16
   proved they are load-bearing). Real-time waits that attribution shows to be idle are the
   target: for example, waiting on a condition that a cheaper event already implies.
3. **Make the zero-GC tests cheaper, shared across pages.** If the ~2.1 s is per-test fixed cost
   in `zeroGcSuite` (`tests/browser/gc/suite.ts`), such as boot, warm-up or park/resume, change
   that once for every page. **Never shorten the measured windows**: 600 frames and the lower-of-two
   rule are ADR 0016/0028's, so changing them is a new ADR and out of scope here. Negative controls
   must still trip on every page (`pnpm gc` output as evidence).
4. **Measure `workers: 3` against 4 and 5.** This is a planning decision (the config comment says
   one browser per Playwright worker), so a change needs a new ADR amending 0020 (`write-adr`
   skill). Evidence for any change: suite wall time quiet and under `--load 10`, every zero-GC
   control still tripping, and the `parkWorkers: timed out` watch item (`deferred-ledger.md`) no
   more frequent than at 3 workers. If more workers only trade suite time for flakiness, keep 3
   and say so in Deviations.

## Non-scope

Demoting any test other than by §4's criterion; changing any `budgets.json` number; changing the
600-frame windows; the `parkWorkers` timeout value (the ledger says not to lengthen it); the
`--load` burner count; anything in `src/` beyond test-only entry points (`src/test/`).

## Files, packages and crates touched
`packages/engine/tests/browser/**` (specs, pages, `gc/`), `packages/engine/playwright.config.ts`,
`packages/engine/src/test/` if a test helper is the cost, a new ADR in `docs/decisions/` only if
the worker count changes.

## Seams
**Provides:** none new. **Consumes:** M04 `zeroGcSuite`, M16 `vertical_slice`, `__sliceSettle`,
`__probeTile`.

## Order of work
Scope 1, then 2, then 3, then 4, each committed as `M16c step k: …`. Step 4 last, because the
suite it measures should already be as cheap as steps 2-3 can make it.

## Tests added
None. Existing tests get cheaper and keep every assertion.

## Exit criteria
- [ ] Deviations hold the before-and-after wall-time attribution for `vertical_slice` and one
      `echo` zero-GC test.
- [ ] `vertical_slice` takes under 3 s in `report.json` and keeps every phase's assertion.
- [ ] Every zero-GC page's negative controls still trip (`pnpm gc` output pasted).
- [ ] Quiet `pnpm test browser` is under 25 s (three consecutive runs pasted).
- [ ] `node scripts/repeat.mjs browser 15 --load 10` is 15/15 under 37.5 s, 0 hangs (run by the
      orchestrator at the gate).
- [ ] If `workers` changed, a new ADR amends 0020 with the measurements.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser` (read `test-results/browser/report.json` for per-test durations) ·
`pnpm test browser -t vertical_slice` · `pnpm gc` · `node scripts/repeat.mjs browser <n> [--load 10]`
(in the foreground, bounded, with a per-run kill timeout; no background load generators).

## Budgets
0020 §3 `browser` 25 s; §2 failure line 37.5 s; §4 browser p95 ≤ 3 s.

## Context artifacts
If the worker count or a shared `zeroGcSuite` cost changes, update the `run-tests` or `gc-test`
skill line that states it.

## Manual device checks
none

## Deviations

### Step 1: attribution before changing (base `4ab945e`)

Instrumented with temporary Node-side `performance.now()` marks (in the spec / in `measure()`
itself, never committed) around each awaited phase, run against the base commit before any fix.

**`vertical_slice`** (`pnpm test browser -t vertical_slice`, quiet, was 5704-5732 ms in
`report.json`; consistent across 4 quiet + 3 loaded (`--load 10`) attributed runs):

| phase | wall time | what it's waiting on |
|---|---|---|
| 1: page load | ~150-200 ms | navigation, WASM/device/worker boot |
| 2: pristine probe (setCamera/settle/probe) | ~40-50 ms | one `__sliceSettle` round trip |
| 3a: `dragPan` itself | ~110-120 ms | 6 real rAF-paced pointer moves |
| **3b: poll for `chunkEntersPristine`** | **~0.4-2.9 s, bimodal** | a real sim tick to run at all (see below) |
| **4a: poll for `tick >= 50`** | **~2.0-3.1 s** | the same stall, then a resync burst straight past 50 |
| 4b: checkpoint + native hash re-check | ~25-45 ms | one park/resume + a native WASM replay |
| 5: paint round trip (setCamera..postProbe) | ~150-200 ms | two `__sliceSettle` round trips |
| 6: reject round trip | ~110 ms | one more `__sliceSettle`-shaped poll |
| 7: HUD/errors | ~4-5 ms | synchronous reads |

Phases 3b and 4a are **~85-90 % of the test's own 5.6-5.7 s**, and both are the *same* root cause:
`worker/sim.ts`'s `wokenBy === lastWokenBy` guard (ADR 0030) starves `atomicsTimer.poll()` while
`slice.html`'s real render loop calls `client.writeCameraAndWake()` unconditionally every rAF (M16
Deviations, "A previously unexercised interaction," `docs/plan/16-action-round-trip.md`). Attributed
`tick` value at the moment each poll resolves: stuck at exactly `1` for the whole of phase 3
(never `0`, never `2+`) across every run measured, then jumping straight to `60`-`66` in one
resync-catch-up burst the instant phase 4's poll resolves. `worker/sim.ts` is outside this
milestone's Files touched (owned by M13/M15b/ADR 0030) -- Scope 2 below is bounded by that.

**`echo clean`** (`pnpm gc -t "echo clean"`, one isolated run then confirmed over `--repeat-each 3`;
`measure()`'s own internal marks, `pageId: 'echo'`, isolates `main`/`client`/`sim`/`gen0`):

| phase | wall time | notes |
|---|---|---|
| attach + name sessions | ~2-9 ms | CDP session setup |
| **warm-up (`WARMUP=8000`, 8 passes)** | **~1454-1500 ms** | `window.__gc.run(n, false)` x8 |
| `memoryBytes()` before + `collectGarbage` | ~11-12 ms | |
| mark isolates + `Tracing.start` | ~25-35 ms | includes the 0016 caveat (a) stall check |
| measured window 1 (600 frames, sample+run+stop) | ~110-115 ms | 0028's first of two windows |
| measured window 2 (600 frames, run+stop) | ~110-115 ms | 0028's second window |
| trace end + `memoryBytes()` after + detach | ~13-14 ms | |
| **`measure()` total** | **~1.72-1.79 s** | |
| page open (before `measure()` starts) | ~300-450 ms | `openPage`, not instrumented in this pass |
| **test total (`report.json`)** | **2069-2208 ms** | matches the gate's own 2147-2208 ms |

Warm-up is **~83 %** of `measure()`'s own time and dwarfs the two 600-frame measured windows 0028
protects (~110 ms each, ~13 % combined) -- the per-test fixed cost Scope 3 targets.

### Step 2: shrink `vertical_slice` -- attempted, reverted, escalated

**Attempted**: changed the phase-4 threshold from `expect.poll(tick).toBeGreaterThanOrEqual(50)` to
`toBeGreaterThanOrEqual(1)`. Justification, measured: because the tick count does not climb
gradually while starved (it holds at exactly `1`, then jumps straight past 50 in one burst -- Step
1's own table), every threshold between 2 and the burst's landing value resolves at the *identical*
wall-clock moment; the real, cheaper event is phase 3's own `chunkEntersPristine` condition, which --
across 30 sequential runs measured (quiet and `--load 10`, `--repeat-each`, `--workers 1`) -- never
resolved with `tick` below 1, and all 30 passed. Every phase's own assertion was unchanged;
`__sliceSettle`/`__probeTile` untouched. Result on those 30 runs: `vertical_slice` fell from
5704-5732 ms to 3687-3752 ms (35 % cut) -- still not under the 3 s budget (see below), but a real
improvement with no failure in 30 sequential tries.

**Reverted.** `node scripts/repeat.mjs browser 8 --load 10` (the brief's own verification command,
run by this session, not sequential single-test repeats) found **2/8 full-suite runs failing** with
`vertical_slice`'s own pre-existing pixel race: `expectPixel(8, 8) channel r: got 34, want 30` --
exactly the Phase-5 post-paint flake `docs/plan/16-action-round-trip.md`'s own gate-round fix
(`__sliceSettle`/atomic `__probeTile`) was built to close. **Isolated to this change**: the identical
command, same machine, immediately before/after (stash/pop, no other code difference) --
`WARMUP=4000` alone (this milestone's own Step 3, present in both legs) -- read `pass=6 fail=2
hang=0` with the threshold-1 change and **`pass=8 fail=0 hang=0` on the unmodified base** (`4ab945e`)
under the same `--load 10` invocation run back to back. The change is reverted;
`vertical-slice.spec.ts` is byte-identical to base.

**Why**: the old `>= 50` wait was never just "waiting for a number" -- it also spent ~2-3 s of real
wall-clock time letting Phase 3's own chunk-generation/upload backlog (created by the real drag pan)
fully drain before Phase 5 probes a *different* tile. `__sliceSettle`'s own `untilQuiescent` is
supposed to make that draining deterministic regardless of elapsed real time, but resolving Phase 4
near-instantly moves Phase 5's own probe much closer, in wall-clock terms, to Phase 3's burst of
activity -- and under `--load 10` specifically, `__sliceSettle`'s own ring-drain check is
apparently satisfiable at a moment when a *subsequent* production frame can still race the very next
probe, reproducing the exact class of race M16's own Deviations ("A rare, unreproduced-on-demand
race was observed once") already flagged as not fully understood. This is a **real, load-dependent
regression this change would have introduced**, not a flake in the test itself -- caught only
because this milestone's own verification command (`repeat.mjs ... --load 10`) is exactly the tool
built to catch it, and not by the 30 sequential single-test runs above (which never reproduced it).

**Left in place, not attempted further**: the underlying cost (Phase 3's own poll, gated by the same
`worker/sim.ts` `wokenBy === lastWokenBy` stall Step 1 attributes it to) remains ~0.4-2.9 s of
genuinely idle real time on every run, `worker/sim.ts` is outside this milestone's Files touched
(owned by M13/M15b/ADR 0030), and `slice.ts`'s own render-loop cadence is the same script Tyler's
device check opens (`docs/plan/device-checks.md`, "M16: Vertical slice on the phone") -- changing it
to make the test faster would change the real page's own behaviour under Tyler's hands, not shrink a
test-only cost. **`vertical_slice` stays at its base 5704-5732 ms and above the 3 s line.** This
exit criterion is unmet; **decision needed from the orchestrator** (see report). The suite-level
Goal (quiet `pnpm test browser` under 25 s) is still met regardless, on Step 3 alone (below) --
`vertical_slice`'s own individual budget and the suite's own wall-clock budget turned out to be
separable.

### Step 3: zero-GC warm-up halved (`WARMUP` 8000 -> 4000)

Step 1's own table found warm-up, not the two 600-frame measured windows 0028 protects, as the
dominant per-test fixed cost in every `zeroGcSuite`-generated test. Measured `input`'s own `main`
isolate (the page 0028's own history shows is warm-up-sensitive) at every value from 2000 to 8000,
`--repeat-each` batches, quiet and under `--load 10`:

| `WARMUP` | `input clean` `main` B/frame | vs. 190 budget |
|---|---|---|
| 2000 | 196.2-196.7 | **over budget** (a real, recurring cost in both 0028 windows, not a one-off JIT burst) |
| 3000 | 186.1-187.0 | under, but only ~3-4 B of margin left |
| **4000** | **181.6-181.7** | matches the pre-0028 historical 181.673-181.913 baseline exactly (fully JIT-settled); same under `--load 10` |
| 6000 | 181.7 | no further improvement over 4000 |
| 8000 (was) | 181.9 (0028's own table) | unchanged from 4000's own reading |

4000 is the floor with headroom preserved; chosen over 3000 for margin. No `budgets.json` number
changed. Verified: the whole `gc` project (77 tests: every page, `object` and `@slow` `burst`
negatives included) at `WARMUP=4000`, 3/3 full runs, 77/77 passing each time, quiet; fast tier alone
(48 tests, `--grep-invert @slow`) fell from **17.4 s to 12.3 s** wall. `input`/`terrain`/
`zero_gc_action`/`echo`/`topology`/`gc-loop` `clean` re-checked at `--repeat-each 10` (70/70 pass)
and again under `--load 10` (35/35 pass).

**Result** (`echo clean`): warm-up fell from ~1454-1500 ms to measured ~727-750 ms (proportional to
the frame-count halving); `measure()` total ~1.05 s; test total in `report.json` fell to
**1354-1458 ms** (was 2069-2208 ms), a 34-37 % cut, matching every other `${page} neg object ...`
test's own fixed cost the same way (`echo neg object main/client/sim/gen0` all fell from ~2.05-2.1 s
to ~1.35-1.4 s in the same full-suite run).

### Suite-level result (Step 3 alone -- Step 2 reverted -- base `4ab945e` vs. this commit range)

`pnpm test browser`, quiet, three consecutive runs (this session, load average re-checked before
each: 1-min under 6 throughout): **22 s / 22 s / 22 s** (`user+sys` 40.1 s / 40.3 s / 40.6 s total,
each printed plain `pass 116 tests 22s/25s` with no over-budget warning), against the base's own
26.0-26.7 s -- **Step 3 alone already meets the suite's own 25 s budget with room to spare**, even
with `vertical_slice` back at its base ~5.7 s (Step 2 reverted, above). `report.json`'s summed test
work fell from 69.5 s to **57.1 s** (n=116 in both). Slowest tests after: `vertical_slice` 5694 ms
(unchanged, Step 2's own line, above), `poll_skips_a_spurious_tick_on_a_ring_wake` 1773 ms,
`workers.park_resume` 1766 ms (both chromium-project, untouched by this milestone -- Non-scope),
`gc-loop neg burst sim` 1543 ms (`@slow`, not in the fast tier), then every `zeroGcSuite`
`clean`/`neg object` test in the ~1.0-1.5 s band Step 3 left them in (was ~1.3-2.2 s).

`node scripts/repeat.mjs browser <n> --load 10` (15/15, 0 hangs) is the orchestrator's own gate
check per the brief; this session ran it in two batches of 8 (the brief's own "~8 per call" bound)
against the exact code in this commit range (Step 3's `WARMUP=4000`, Step 2 reverted): **16/16 pass,
0 fail, 0 hang** (`slowestSuiteSeconds` 29 and 30, i.e. still over the *quiet* 25 s budget under
real load, as 0020's own "wall clock recorded, never gating under load" already expects, and under
the §2 37.5 s failure line both times). Load average during these two batches ranged 7.4-15.4
(1-min) -- a shared machine, not a clean lab bench, but every run passed regardless.

### Step 4: `workers` measured at 3, 4 and 5 -- changed to 5, new ADR

Measured quiet (three consecutive `pnpm test browser` runs each) and loaded (`node scripts/
repeat.mjs browser 8 --load 10`, two batches of 8, the brief's own "~8 per call" bound), all on top
of Step 3's `WARMUP=4000` (Step 2 reverted):

| `workers` | quiet (3 runs) | `report.json` summed | loaded (16 runs, 2 batches) |
|---|---|---|---|
| 3 (was) | 22 / 22 / 22 s | 57.1 s | 16/16 pass, `slowestSuiteSeconds` 29, 30 |
| 4 | 20 / 20 / 20 s | not re-measured | not run under load (see below) |
| **5** | **21 / 19 / 18 s** | not re-measured | **16/16 pass, `slowestSuiteSeconds` 24, 24** |

5 is not a speed/flakiness trade: it is faster quiet *and* faster loaded than 3, with zero new
failures or hangs across 32 total runs (16 quiet-adjacent iterations across the workers values +
16 loaded) and zero `parkWorkers: timed out` occurrences (the `deferred-ledger.md` watch item) at
any worker count tried. One `pnpm test:slow browser` run at `workers: 5` (38 tests, the `webkit`/
`firefox` `@engines` legs share the same global config setting) also passed at 18 s -- the slow tier
is not destabilised by the shared setting. 4 was measured only quietly (it sits between 3 and 5 on
every quiet run) and was dropped once 5's own loaded numbers came back clean, since Scope 4's own
fallback ("if more workers only trade suite time for flakiness, keep 3") never triggered.

**Changed `workers: 3` -> `5`** in `playwright.config.ts`, with a new ADR:
[0031](../decisions/0031-browser-suite-five-workers.md) amends
[0020](../decisions/0020-testing-strategy.md) §3. `0020`'s own `Status:` line now points to it (the
one-line "Amended by" append the `write-adr` skill's own mechanism calls for); the skill's remaining
bookkeeping steps (`PRE-PLAN.md` §1's ADR index, `PLAN.md`'s "Plan-level decisions", the root
`CLAUDE.md` context-map's own ADR range) are **left for the orchestrator**: all three are outside
this agent's permitted edit scope (`PLAN.md` is explicitly off-limits; `PRE-PLAN.md` and root
`CLAUDE.md` are not in the "what you may edit" list), and the root `CLAUDE.md`'s own "ADRs
0001-0028" line was already stale before this milestone (0029 and 0030 predate it too) -- consistent
with that bookkeeping being batched by the orchestrator rather than done per-milestone.

### Final suite-level numbers (Steps 3+4 together)

Quiet `pnpm test browser` at `workers: 5` (this commit range's own final state): **21 s / 19 s /
18 s**, well under the 25 s budget. Loaded: 16/16 pass at `--load 10`, `slowestSuiteSeconds` 24 both
times -- better than the base's own 9/15 loaded failures at `workers: 3` before this milestone.
`vertical_slice` remains at its base ~5.7 s (Step 2 reverted, unmet exit criterion, escalated above)
but no longer drives the suite over its own wall-clock budget either quiet or loaded.
