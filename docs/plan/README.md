# Milestone briefs

One file per milestone, `<NN>-<slug>.md`, indexed by `PLAN.md`. A brief is the whole instruction set for one milestone: the manager session of `PROMPT.md` reads it, and any sub-agent it delegates to reads the brief and the brief's reading list, and nothing else up front (ADR [0021](../decisions/0021-context-architecture.md) §3: briefed with files, not conversation).

Who writes what: the implementer (the manager itself, or the sub-agent it delegates to) fills **Deviations** and reports evidence for each exit criterion; the manager ticks the **Exit criteria** boxes and sets `Status:` after its gate (`PROMPT.md`, the loop). Where a brief says "this milestone" or "the implementer", read "whoever does the work".

## Rules for a brief

- **Self-sufficient, not self-contained.** Link to the ADR section that owns a fact (`0076 §3`); do not copy numbers or signatures out of ADRs. State only what no ADR states: the cut, the order of work, the names of seams, the tests, the commands.
- **Sizing.** One new subsystem or one vertical cut; at most three packages or crates touched; roughly 1,500 lines of new code and tests or fewer; verification that runs in minutes. The rule sizes one implementer's context. If it does not fit, split it (`PLAN.md`, "How this plan is revised").
- **Reading list:** `docs/architecture/README.md` plus at most three files (an ADR, an architecture doc, a prior-project doc), each with the sections that matter. `.claude/rules/` files that apply are listed separately and do not count. A brief that depends on a procedure names the skill's `SKILL.md`.
- **Seams are named.** Anything a later milestone will call (a Rust type or method, an ABI export, a wire section, a TS function, a test helper, a fixture action) is named under *Provides*; anything used from an earlier milestone is named under *Consumes* with its milestone number. Names follow the ADRs where the ADRs give one.
- **Exit criteria are checkable** by a command or by a named test passing. `pnpm test` and `pnpm lint` green is always the last criterion. Each new test or guarded branch has had its inject-fail-revert ([0069](../decisions/0069-working-rules-learned-in-phase-3.md) §1), recorded in Deviations.
- **Engine tests use fixture games** (`packages/engine/fixtures/<name>/`), never the reference game. Belt mechanics are tested natively first (`fx-belts`, counting-allocator `no_alloc_*`), then as `.wasm` goldens, then in the browser.
- **Budgets** are `packages/engine/budgets.json` rows or a named benchmark with a baseline under `packages/engine/baselines/`; a new budget's number must be able to trip ([0069](../decisions/0069-working-rules-learned-in-phase-3.md) §6).
- **Factorio fidelity is not a goal.** Where a brief drops or simplifies a Factorio rule, it says which and why, and the game-rule line lives in `games/reference/README.md` "Belts" (Tyler's file: his dated answers only).
- Length: aim for 80-150 lines for a full brief; a later-phase brief (goal, exit criteria, open questions) may be 30-60 lines until the plan revision that fills it in.

## Template

```markdown
# M<NN>: <title>

Status: not started · After: <milestones> · Tyler-dependent: <no | question + default assumed>

## Goal
Two or three sentences: what exists and is verifiable when this is done.

## Read first
1. `docs/architecture/README.md`
2-4. <file> (<sections>)
Rules that apply: <.claude/rules/*.md>. Skills: <.claude/skills/*/SKILL.md>.

## Scope
## Non-scope
## Files, packages and crates touched
## Seams
**Provides:** … **Consumes:** …
## Planning decisions
Deferred or unstated items settled here, each with a one-paragraph rationale (or a link to the new ADR).
## Order of work
## Tests added
## Exit criteria
- [ ] …
- [ ] `pnpm test` and `pnpm lint` are green.
## Verification commands
## Budgets
Which `budgets.json` rows or named benchmarks this milestone must meet, and the test that measures each.
## Context artifacts
Skills, `.claude/rules/` files, nested `CLAUDE.md` files and architecture docs created or updated (ADR 0021; root `CLAUDE.md` "Every fact lives in exactly one file").
## Manual device checks
Rows added to `.claude/skills/device-check/SKILL.md`, or "none".
## Deviations
(filled in during execution)
```
