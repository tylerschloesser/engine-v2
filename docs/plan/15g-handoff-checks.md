# M15g: mechanical checks on `PROMPT.md`'s status block

Status: not started · After: 15f · Tyler-dependent: no

## Goal

The staleness defects that reach `PROMPT.md`'s status block are caught by a command instead of by
Tyler asking "is the prompt ready?". Structural invariants that must hold at *all* times run in the
`unit` suite; the checks that are only meaningful at a `done` commit run from `pnpm handoff`.

## Why, with the actual defects to catch

`PROMPT.md` is the only entrypoint of the next orchestrating session, and it has gone out stale
twice. On 2026-09-22 a session-end block that had just been rewritten and reported ready still had
four defects, three of them introduced by the rewrite itself:

1. **Stale ground numbers.** State opened with `rust` 235, `unit` 154, `wasm` 41, `browser` 98 — the
   M14-era line — while the tree measured 275 / 157 / 43 / 110. A cold session runs `pnpm test` at
   loop step 2 and compares against whatever State claims.
2. **A standing instruction the same session's findings had invalidated.** State still read "the
   next milestone that adds browser tests — **M15b** on current order — must take 0020 §4's next
   rung", while the Milestone line said the ladder is exhausted. **M15b is ticked in `PLAN.md`**,
   which is the mechanical tell: a milestone named as upcoming that is already done.
3. **Unbalanced parentheses** from a string-replace edit that closed a clause early.
4. A pacing note describing the *previous* session as "this session". **Not mechanically
   detectable — do not try.** Three of four is the target.

## Scope

**Pure logic in `scripts/lib/handoff.mjs`**, following `scripts/lib/gate.mjs`'s shape (pure
functions over strings, no I/O), with co-located `scripts/lib/handoff.test.mjs`.

**In the `unit` suite** (`scripts/lib/handoff.test.mjs`, the way `context-artifacts.test.mjs`
already asserts repo-doc invariants) — these must hold at every commit, mid-milestone included:

- **No milestone named as upcoming is already ticked.** Parse `PLAN.md`'s table into
  `{id, ticked}`. Scan `PROMPT.md`'s status block for milestone ids in an upcoming/current context
  — `M<NN> next`, `M<NN> in flight`, `M<NN> is ready`, `M<NN> on current order` — and fail if any is
  ticked. This is defect 2, and the wording list is the load-bearing part: derive it from the real
  phrasings above, and say in a comment that the list is a heuristic to extend, not a spec.
- **Balanced `(`/`)` across `PROMPT.md`.** Defect 3. Count over the whole file.
- **Every brief `PLAN.md` references exists** on disk.
- **Every ticked `PLAN.md` row's brief has `Status: done`**, and no unticked row's brief does.

**In a new `pnpm handoff` command** (`scripts/handoff.mjs`, quiet on success like `pnpm gate`, one
line per check, details only on failure) — meaningful only at a `done` commit, so not in the suite:

- Run the structural checks above, then **the suite-count check**: find the numbers State claims as
  *current* ground and compare them against the most recent `test-results/` report. Defect 1.
  State deliberately also cites *historic* figures, so you need a way to tell current from historic
  that does not depend on prose parsing — **the current line is the one this milestone should make
  machine-readable.** Propose the shape (an HTML comment carrying the counts, a fenced block, a
  fixed sentence form), implement it, and update `PROMPT.md`'s State line to use it. Keep it to one
  small marker; do not restructure the block.

## Non-scope

- Judging prose. Defect 4 and "does this instruction contradict that one" are out of reach; do not
  attempt heuristics for them.
- Rewriting the status block's content, or the loop/Rules sections below it.
- Anything outside Phase 3's lifetime: this tooling is deleted with `PROMPT.md` in Phase 4, so keep
  it small and self-contained.

## Files touched

`scripts/lib/handoff.mjs`, `scripts/lib/handoff.test.mjs`, `scripts/handoff.mjs`, `package.json`
(the `handoff` script), `scripts/suites.mjs` only if the `unit` suite needs the new test registered,
and `PROMPT.md` for the machine-readable ground marker only.

## Seams

**Provides:** `pnpm handoff`; `scripts/lib/handoff.mjs`'s exported check functions.
**Consumes:** `PLAN.md`'s table format; `docs/plan/<NN>-*.md`'s `Status:` line; the `test-results/`
report shape (`scripts/lib/report.mjs`).

## Planning decisions

- **Split by when the invariant holds, not by convenience.** A check that fails mid-milestone would
  train everyone to ignore it, so only always-true invariants go in the suite. The suite-count check
  is legitimately stale between a milestone's start and its `done` commit, so it belongs to the
  command the orchestrator runs before that commit.
- **The orchestrator wires it into the loop, not you.** Do not edit `PROMPT.md`'s loop or Rules
  sections; the only `PROMPT.md` change in your scope is the ground marker.

## Order of work

1. `scripts/lib/handoff.mjs` + its tests, structural checks only, driven by fixtures.
2. Register in the `unit` suite; confirm it passes on the current tree **and** prove each check can
   fail, by fixture, one per check.
3. The ground marker and the suite-count check; `scripts/handoff.mjs`; `pnpm handoff`.
4. Re-verify against the four historical defects (below).

## Tests added

`scripts/lib/handoff.test.mjs`. **It must include a regression fixture reproducing each of defects
1, 2 and 3 as they actually appeared**, asserting the checks catch them — that is the milestone's
real exit criterion, not that the checks pass on today's clean tree. Defect 2's fixture should use
the real sentence: a reference to `M15b` while `M15b` is ticked.

## Exit criteria

- [ ] `scripts/lib/handoff.test.mjs` reproduces defects 1, 2 and 3 as fixtures and each check fails
      on its fixture and passes on the corrected version, with outputs pasted.
- [ ] Each check is proved failable independently (inject, observe, revert), one per check.
- [ ] `pnpm handoff` is quiet on success, one line per check, and exits non-zero on any failure.
- [ ] The structural checks run inside `pnpm test`'s `unit` suite and pass on the current tree.
- [ ] `PROMPT.md`'s current-ground figures are machine-readable, and the marker's shape is recorded
      in Deviations for the orchestrator to maintain.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands

`pnpm test unit -t handoff` · `pnpm handoff` · `pnpm test && pnpm lint` (the orchestrator gates).

## Budgets

None new. `unit` is at 1.6 s of a 3 s budget; these checks are string work over three files and must
not move it measurably. Report the `unit` line before and after.

## Context artifacts

None new.

## Manual device checks

none

## Deviations

(filled in during Phase 3)
