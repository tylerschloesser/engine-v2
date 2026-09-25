# M19c: two intermittent CI reds (frame-bench setup drain, admit-path allocation)

Status: done · After: 19b · Tyler-dependent: no

Written by the orchestrator at the start of the session after M19b, from two CI runs. Neither is
M20's, and M20 touches neither file, so they are fixed first.

## Goal

Make two intermittent CI failures either impossible or self-explaining. Each has one occurrence
(or one plus a predecessor), so the product of each half is a wait on the real condition or a
named cause, never a longer wait or a looser assertion.

## The evidence, gathered by the orchestrator

**A. `bench.frame_worstcase` setup drain (browser, slow tier).** M19b's `done` push (`c4b3225`, run
36014036176, attempt 1) failed CI's slow tier under `ENGINE_GPU=swiftshader`, smoke mode:
`published record_count after warm-up` read **65,408 against 65,536**, short by exactly one
`BATCH_COLS` (128) batch. Attempt 2 passed. This is M17b's CI-round-1 symptom. The fix then was a
second trailing `harness.stepFrame` in `packages/engine/tests/browser/pages/src/frame-bench.ts`
(its comment above the final four calls explains the reasoning), which makes the drain *likely*,
not guaranteed: the last batch's downlink frame has to arrive and be applied by the client, and
then the renderer has to publish a `DrawListSlot` built from it. M18 moved the renderer onto the
acquired `DrawListSlot`, so "applied" and "published" are two different moments now.

**B. `host_admit_path_allocates_zero_bytes_per_action` (rust, fast tier).** Run 36087861610 (a
doc-only commit, `9cee93f`) failed:
`the real admit path (...) allocated 900 B over 100 actions` at
`packages/engine/crates/engine/tests/no_alloc_connection.rs:713`. It is the first failure of this
test in the last 40 failed CI runs, and it passes locally. `live()` is
`engine::abi::arena::live_bytes()`, a process-wide allocated-minus-freed atomic, so a matched
alloc/free pair nets to zero; 900 B is **net growth** during the 100-action window of
`admit_run(100)`, after a 40-tick warm-up. The 1,600-action assertion never ran (it follows).
Something in native Rust is therefore not deterministic across runs. Orchestrator guesses, **to be
tested, not assumed**: a `std` `HashMap`/`HashSet` with `RandomState` on the host path, whose growth
or in-place rehash timing depends on the per-process seed (hashbrown's tombstone handling depends on
where keys land); or an allocation from another thread of the test process (libtest's own), which a
process-wide counter would also see.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/17b-sprites-and-frame-bench.md` Deviations, only the frame-bench parts (CI round 1) —
   find the file with `ls docs/plan/17b-*`
3. `docs/plan/18-picking-and-overlay.md` Deviations, only the parts on `DrawListSlot` and how the
   renderer acquires a published slot
4. `docs/plan/16-action-round-trip.md` Deviations, only the parts on `host_admit_path_...` and
   `abi::arena::live_bytes`

## Scope
1. **A.** Replace the setup's reliance on a fixed number of trailing `stepFrame`s with a bounded
   poll on the real condition: step frames/ticks until the published slot's `record_count` is
   65,536, with an iteration cap. When the cap is hit, fail with a message that prints the slot's
   `frame_seq`, its `record_count`, and the client's downlink counters (frames received/applied,
   `downlinkRetries`, `drops`), so the next occurrence names where the last batch stopped.
   Reproduce first if cheap: M17b found it locally under `CI=true ENGINE_GPU=swiftshader` in smoke
   mode; try that, bounded (10 runs).
2. **B.** Reproduce, bounded: run the one test in a foreground loop (for example 300 runs of
   `cargo nextest run --test no_alloc_connection host_admit_path` or the `pnpm test rust -t` form),
   plus the same under CPU load if quiet does not reproduce. Also grep the host path
   (`src/host/`, `src/store*`, `src/wire/`) for `HashMap`/`HashSet`/`RandomState`.
3. **B.** On a reproduction, attribute it: make the window print where the net bytes were allocated
   (for example a test-only allocator hook in this test binary that records a backtrace or caller
   size per allocation while a flag is set). Name the allocation site, then fix the cause in
   production if it is production (for example a fixed hasher or a pre-sized map), or in the test
   if it is the harness. A fix must come with a deterministic test that fails without it; if the
   cause is seed-dependent, the test should force the bad seed rather than wait for it.
4. **B.** If step 2 does not reproduce within its bound, commit a failure message that says where
   the bytes went (the attribution from step 3, armed only on failure, or at minimum the
   `high_water_bytes()` delta and a per-tick breakdown), and stop. The next occurrence names the
   cause (the M16e/M18c outcome).

## Non-scope
Any zero-GC or frame-time budget; `baselines/frame.json`; the 1,600-action assertion's value;
changing either test's assertion to a ceiling. More trailing `stepFrame`s or a longer fixed wait.

## Files, packages and crates touched
`packages/engine` (`tests/browser/pages/src/frame-bench.ts`, the frame-bench spec beside it, and
`src/test/*` only if a counter the message needs is not reachable); `packages/engine/crates/engine`
(`tests/no_alloc_connection.rs`, and production `src/host/` or wherever step 3 names).

## Seams
**Provides** nothing new.

## Order of work
1. A: bounded poll plus diagnostic message. 2. B: bounded reproduction and grep. 3. B: attribute
and fix with a failing-first test, or 4. commit the diagnostic and stop.

## Tests added
B's regression test, if the cause is found.

## Exit criteria
- [x] Frame-bench setup waits on a published slot with `record_count` 65,536 under an iteration
      cap, and the cap's failure message prints `frame_seq`, `record_count` and the client's
      downlink counters. `pnpm test:slow` (hardware) ends with a passing `frame-bench` line, pasted.
- [x] B's cause is named and fixed with a test that fails without the fix (red output pasted), **or**
      step 4's bounded attempt is recorded in Deviations with its run counts and the committed
      failure message says where the bytes went.
- [x] Neither test's assertion is weakened.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t host_admit_path` · `pnpm test:slow` · `CI=true ENGINE_GPU=swiftshader pnpm test:slow`
(foreground, bounded, per-run kill timeout, no background load generators).

## Budgets
none changed.

## Context artifacts
If B's cause is general (for example "no `RandomState` on the host path"), one line in
`packages/engine/crates/engine/CLAUDE.md` or `.claude/rules/hot-paths.md`, whichever owns it.

## Manual device checks
none

## Deviations

Base `9e85608` (start commit `3dd9669`), commits `20abc5c` (step A) and `24f79ee` (step B 2-4).

### A: frame-bench setup drain poll

`packages/engine/tests/browser/pages/src/frame-bench.ts`: the fixed trailing `harness.stepFrame` /
`stepSimTickSync` / `stepTick` sequence is replaced by a bounded poll (`DRAIN_POLL_CAP = 20`) that
each iteration runs one no-op `stepSimTickSync(client, 1)` (harmless once every batch is already
admitted -- ticking further with nothing new just re-sends the same, by-then-unchanging world
state) plus one `harness.stepFrame(1000 / 60)`, then `client.pick.acquire()` and checks
`clientTestHandle(client).drawListSlot.recordCount === GRID_SIDE * GRID_SIDE` (65,536), breaking as
soon as it's true. Why a fixed count could no longer be trusted: `worker/client.ts`'s `body()`
order runs `netPump.pump()` (which calls `on_frame`, *applying* a downlink frame) strictly *after*
that same wake's `frame()`/`drawlistPump.publish()` call -- so the wake that applies the last batch
never publishes it; publishing it takes one more wake after that. CI round 1's fixed "one more
`stepFrame`" (docs/plan/17b-sprites-and-frame-budget.md Deviations) assumed exactly one
apply-then-publish pair always lands it; M18 moving the renderer onto the acquired `DrawListSlot`
made that assumption's failure mode ("applied" and "published" are different moments) real, per
this brief's own evidence (M19b's `c4b3225`, attempt 1: `record_count` 65,408, short by exactly one
`BATCH_COLS` batch).

On the cap being exceeded, the thrown message reads (measured by temporarily setting
`DRAIN_POLL_CAP = 0`, then reverting -- `git diff` empty before the step's commit):
```
frame-bench setup: drain poll cap (0) exceeded before record_count reached 65536: frame_seq=0
record_count=0 downlink frames sent=423 downlink ring pushed=423 popped=423 drops=0
downlinkRetries=0
```
(`netCounters`, `engine/test`, read with the workers parked for that one diagnostic call and
resumed right after -- no real frame has run yet at that point in setup, so nothing races it.)

Verified: `pnpm bench:frame` (full hardware), 3 runs, `records=65536` every time; `CI=true
ENGINE_GPU=swiftshader pnpm bench:frame` (smoke), 3 runs, same. Reproduction of the original bug
attempted first (10 runs, `CI=true ENGINE_GPU=swiftshader`, before any code change): did not
reproduce on this Mac (0/10), consistent with the brief's own "this Mac's CPU is far faster than
the CI runner's" note from M17b.

`pnpm test:slow` (hardware), full run:
```
frame-bench pass 1 tests    5.2s
```
`CI=true ENGINE_GPU=swiftshader pnpm test:slow`:
```
frame-bench pass 1 tests    4.2s
```

### B: host_admit_path_allocates_zero_bytes_per_action

**Reproduction: not achieved.** 500 bounded local runs of `cargo nextest run --workspace
--no-tests=pass -E 'test(host_admit_path)'` in a foreground loop on this Mac: 300 quiet, then 200
more under a bounded 12-way CPU load (`yes > /dev/null &` x12, `pgrep -x yes` confirmed 0 after
`pkill -x yes`). 0/500 failures.

**Grep, per step 2**: `HashMap`/`HashSet`/`RandomState` over `src/host/`, `src/store.rs`,
`src/wire/` (no `src/store/` directory or `src/wire*` beyond the one module) found none; a
crate-wide grep found exactly one match, a code comment in `world/cache.rs` ("a fixed-hasher
open-addressing index -- never a `HashMap`") explicitly stating the opposite. The orchestrator's
first guess (a `HashMap`/`HashSet` with `RandomState` on the host path) is therefore ruled out; the
second guess (an allocation from another thread of the test process) was not tested directly (no
practical way found this session to attribute a specific thread without the allocator-hook
mechanism step 3 describes, which step 4's own bound was reached before building).

**Step 4's diagnostic, committed**: `no_alloc_connection.rs`'s `host_admit_path_...` test no longer
uses a bare `assert_eq!`; on either window's net bytes being non-zero it panics with the original
message plus `admit_diagnostic_tail(window)` -- a fresh re-run of the identical admit-only workload
(`admit_run_traced`, sharing `warmed_admit_host` with the measured `admit_run`) reporting
`high_water_bytes()` before/after and every tick's own `live_bytes()` delta, filtered to the
nonzero ones. Never collected on the passing path (an extra `Vec<i64>` allocation would otherwise
show up as noise in exactly the measurement it would be diagnosing).

Proven by injection (a temporary `std::mem::forget(Vec::<u8>::with_capacity(9))` every tick once
`*seq >= 100`, reverted -- `git diff` empty before the step's commit): first attempt showed a
phantom `(0, 800)` entry (the diagnostic's own `Vec::with_capacity(window)` -- 100 * `size_of::<i64>()`
= 800 B -- landing inside the very first measured delta because `prev` was captured before that
allocation); fixed by moving `prev`'s capture after it. Re-run then showed the high-water delta
still inflated by the same 800 B even with the per-tick list clean, because `hw_before` was still
read one line before that allocation; fixed the same way. Final, correct output:
```
the real admit path (on_uplink -> decode_canonical -> G::admit -> pending_records, then tick/
build_frame/seal) allocated 360 B over 100 actions; re-run: high_water 4301151 B -> 4301611 B
(+460 B), nonzero-delta ticks (index, bytes) = [(60, 9), (61, 9), ..., (99, 9)] (40 entries)
```
360 B = 40 leaking ticks * 9 B, matching the injected fault exactly. The high-water delta (460 B)
being larger than the net (360 B) is expected, not a bug: `high_water_bytes()` also catches the
transient peak of `on_uplink`'s own local scratch decode buffers (freed by the end of the same
call) whenever that peak lands above the running baseline -- the same "gross vs. net" distinction
the test's own doc comment already draws for the net figure.

No context-artifact line was added to `packages/engine/crates/engine/CLAUDE.md` or
`.claude/rules/hot-paths.md`: that line is conditioned on B's cause being found and general
("if B's cause is general"), and it was not found this session.

### Verification

`pnpm test rust -t host_admit_path`: `rust pass 1 tests`. `pnpm test`: `rust pass 366 tests / unit
pass 215 tests / wasm pass 55 tests / browser pass 170 tests`. `pnpm lint`: `biome pass / rustfmt
pass / clippy pass / tsc pass`.
