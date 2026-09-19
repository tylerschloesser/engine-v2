# Milestone briefs

One file per milestone, `<NN>-<slug>.md`, indexed by `PLAN.md`. A brief is the whole instruction set for one implementer sub-agent (`.claude/agents/milestone-implementer.md`, `docs/decisions/0025-phase-3-orchestration.md`): it reads the brief and the brief's reading list, and nothing else up front. The orchestrating session of `PROMPT.md` reads only the brief.

Who writes what in a brief during Phase 3: the implementer fills **Deviations** and reports evidence for each exit criterion; the orchestrator ticks the **Exit criteria** boxes and sets `Status:` after its gate. Where a brief says "this session" or "the session", read "the implementer".

## Rules for a brief

- **Self-sufficient, not self-contained.** Link to the ADR section that owns a fact (`0014 §3`); do not copy numbers or signatures out of ADRs. State only what no ADR states: the cut, the order of work, the names of seams, the tests, the commands.
- **Sizing.** One new subsystem or one vertical cut; at most three packages or crates touched; roughly 1,500 lines of new code and tests or fewer; verification that runs in minutes. The rule sizes one implementer's context. If it does not fit, split it.
- **Reading list:** `docs/spec/overview.md` plus at most three files (ADR or spec domain file), each with the sections that matter. Spike files to mine for snippets and `.claude/rules/` files that apply are listed separately and do not count.
- **Seams are named.** Anything another milestone will call (an ABI export, a ring, a TS function, a Rust trait or type, a test helper) is named under *Provides*; anything used from an earlier milestone is named under *Consumes* with its milestone number. Names follow the ADRs where the ADRs give one.
- **Exit criteria are checkable** by a command or by a named test passing. `pnpm test` and `pnpm lint` green is always the last criterion.
- **Engine tests use fixture games** (`packages/engine/fixtures/<name>/`), never the reference game.
- Length: aim for 80–150 lines; milestones 01–04 may be longer.

## Template

```markdown
# M<NN>: <title>

Status: not started · After: <milestones> · Tyler-dependent: <no | question id + default assumed>

## Goal
Two or three sentences: what exists and is verifiable when this is done.

## Read first
1. `docs/spec/overview.md`
2–4. <file> (<sections>)
Mine from spikes: <paths, what to take>. Rules that apply: <.claude/rules/*.md>.

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
Which rows of `PRE-PLAN.md` §7 this milestone must meet, and the test or counter that measures each.
## Context artifacts
Skills, `.claude/rules/` files, nested `CLAUDE.md` files created or updated (ADR 0021).
## Manual device checks
Link into `docs/plan/device-checks.md`, or "none".
## Deviations
(filled in during Phase 3)
```
