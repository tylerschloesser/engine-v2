# M30c: Three CI-only reds after M30

Status: not started · After: 30b · Tyler-dependent: no

Written by the orchestrator at M30b's CI read (2026-09-29). Same shape as M19c: CI-only, intermittent, so the job is to attribute from CI's own artifacts, fix the cause, and leave a failure-only diagnostic where the cause cannot be shown. Every red below passed on a same-commit rerun at least once, and every one is green locally.

## Goal
CI's fast tier passes on consecutive pushes again. Each of the three reds below has a named cause and a fix, or a committed failure-only diagnostic that will name the cause on its next occurrence. No test is weakened.

## The evidence (orchestrator, from CI runs)
Runs: 36636714669 (`M30 done`), 36639392014 (`5ad3301`), 36642513660 (`M30b done`). Suite wall times on CI are unchanged from the green M29 runs (browser 254-286 s, netcode 12-16 s), so M30 did not measurably add load.

- **A. The 900 B one-off, three binaries in one day.** It has appeared in `engine::no_alloc_ui ui_constant_value_does_not_grow_the_arena` (run 36639392014) and in `engine::no_alloc_drawlist drawlist_extract_and_sort_does_not_grow_the_arena` (run 36642513660), both as `900 B over 300 frames but 0 B over 1,200 frames`. Earlier, `host_admit_path_allocates_zero_bytes_per_action` read 900 B once (M19c, run 36087861610; 0 in 500 local runs). The same byte count in three unrelated code paths, always in the short window only, points at something the `no_alloc_*` binaries share: their counting `#[global_allocator]`, the test harness, or another thread in the process. That is a guess; the deferred-ledger row "`host_admit_path_allocates_zero_bytes_per_action` read 900 B" has the history.
- **B. `netcode ws/join-converges`** (M29 test, `packages/engine/tests/netcode/ws-transport.test.ts`). It first failed as `engine: dispatch before ready` after its fixed `advanceTicks(20)` (run 36636714669). The orchestrator's `5ad3301` replaced that with a bounded wait until every client is `Online`. Run 36642513660 then hit Vitest's 5 s test timeout inside that wait (`× ws/join-converges 5059ms`). So on CI, four real loopback handshakes can take more than 5 s of real time, and it isn't known whether the time goes to the socket, the handshake pump, `handshakesSettled`, or starvation by the parallel browser suite.
- **C. `[chromium] mp/version-mismatch-reloads-once`** (M29, browser): `waitForFunction: Test timeout of 45000ms exceeded` in run 36642513660.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/19c-ci-reds-frame-bench-and-admit-path.md` (the 900 B diagnostic already committed, and how it reads)
3. `docs/plan/29-net-worker-and-reference-server.md` (Deviations: the ws transport, `mp.html`, CI rounds 1-8)
4. `docs/decisions/0016-zero-gc-definition.md` (what the no-alloc instrument claims)

## Scope
- For each red, attribute from CI artifacts: `gh run download <id>` has `test-results/`, and `gh run view <id> --log-failed` has the rest. Where the cause isn't visible, commit a **failure-only** diagnostic, then stop so the orchestrator can push and rerun (below).
- For A: find out which thread and which call site own the 900 B. If they belong to the process rather than the measured path (for example a harness or runtime thread), fix the instrument so it counts only the measuring thread. Prove it: the instrument must still catch an allocation injected into the measured path. If they belong to the measured path, fix the path.
- For B and C: find where the real time goes and fix the cause. That can be production code, the harness, or a genuinely racy wait.

## Non-scope
Any other test. New features. Raising a zero-GC or byte budget, lengthening a timeout, adding retries, `@slow`-demoting or skipping any of these three tests. Each of those is a mask, and only the orchestrator could approve one, with an ADR.

## How CI rounds work here
The implementer never pushes. Commit diagnostics as `M30c: …` and stop. The orchestrator pushes, reruns the failing job as needed (`gh run rerun <id> --failed`, several times for a rate), and returns the run ids. One implementer is kept alive across rounds (M10's pattern).

## Files, packages and crates touched
`packages/engine/crates/engine/tests/` (no-alloc instrument and binaries), `packages/engine/tests/netcode/`, `packages/engine/src/test/`, `packages/engine/tests/browser/` (the `mp` spec and page), and production files only where attribution names them.

## Tests added
Each fix comes with a control that shows the test still fails on the defect it exists to catch. For A: an injected allocation in the measured path still fails the no-alloc test, run once and pasted.

## Exit criteria
- [ ] Deviations name each red's cause, or say what the diagnostic will print on its next occurrence.
- [ ] Two consecutive CI runs on `main` are green in the fast tier, with the orchestrator reading them.
- [ ] No budget, timeout or skip marker is changed (`pnpm gate` markers: none).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t no_alloc` · `pnpm test netcode -t ws/` · `pnpm test browser -t mp/` · `pnpm test && pnpm lint`

## Budgets
None changed.

## Context artifacts
If the no-alloc instrument changes: one line in `packages/engine/crates/engine/CLAUDE.md` saying what it counts.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
