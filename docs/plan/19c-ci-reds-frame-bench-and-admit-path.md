# M19c: two intermittent CI reds (frame-bench setup drain, admit-path allocation)

Status: pending · After: 19b · Tyler-dependent: no

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
- [ ] Frame-bench setup waits on a published slot with `record_count` 65,536 under an iteration
      cap, and the cap's failure message prints `frame_seq`, `record_count` and the client's
      downlink counters. `pnpm test:slow` (hardware) ends with a passing `frame-bench` line, pasted.
- [ ] B's cause is named and fixed with a test that fails without the fix (red output pasted), **or**
      step 4's bounded attempt is recorded in Deviations with its run counts and the committed
      failure message says where the bytes went.
- [ ] Neither test's assertion is weakened.
- [ ] `pnpm test` and `pnpm lint` are green.

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
