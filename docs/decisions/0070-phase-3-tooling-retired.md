# 0070: Phase 3 orchestration tooling is retired

Status: Accepted (2026-10-10). Amends [0025](0025-phase-3-orchestration.md) §2 (the `milestone-implementer` sub-agent) and the orchestrator tooling it introduced; supersedes [0054](0054-tools-suite.md) (the `tools` suite); restores [0021](0021-context-architecture.md) §5 unamended. Implemented in Phase 4.

## Context

Phase 3 ran as one orchestrating session landing milestones through Sonnet implementer sub-agents (0025). It grew tools that existed only to run that loop: the `milestone-implementer` agent definition, `pnpm gate` (what a milestone changed), `pnpm handoff` (staleness checks on `PROMPT.md`'s status block), `pnpm acceptance:check` (device citations in the acceptance brief) and the phone-round tool `pnpm device:walk` with its `device-round` skill, which reads and writes the checklist in `docs/plan/device-checks.md`. Phase 4 deletes `docs/plan/`, `PLAN.md` and `PROMPT.md`, which every one of these reads.

## Decision

**1. The `milestone-implementer` agent definition is deleted.** `.claude/agents/` is empty, so 0021 §5 holds again as written: no custom sub-agent until the same brief has been hand-written three or more times and needs something a skill cannot give, and adding one takes a new ADR. Delegation is `general-purpose` with `model: sonnet`, briefed with files (0021 §3).

**2. `pnpm gate`, `pnpm handoff` and `pnpm acceptance:check` are deleted** with their tests, `package.json` scripts and suite entries. Each checked an artefact of the milestone loop that no longer exists.

**3. The phone-round tool is deleted** (`pnpm device:walk`, `scripts/device-walk.mjs`, `scripts/lib/device-walk/`, its tests, the `device-round` skill). The `tools` suite of 0054 held only those tests and is removed with them. Tyler chose this on 2026-10-10 over rewiring it to the `device-check` skill. The manual checklist lives on as the `device-check` skill, and `pnpm device:serve` (which serves the pages for it) stays.

## Alternatives rejected

- **Keep `milestone-implementer` for future feature work.** Its standing rules cite milestone briefs, `PLAN.md` checkboxes and the acceptance gate; rewritten without them it is a `general-purpose` brief, which 0021 §5 says needs no definition.
- **Rewire `device:walk` to read `.claude/skills/device-check/SKILL.md`.** Tyler's call (scope and upkeep: about 50 files of driver code for a manual checklist that is run rarely). Recoverable from git at the `phase-3-complete` tag if device rounds become frequent again.

## Consequences

- An on-device check is walked by hand from the `device-check` skill; there is no automated phone driver, judge log or QR runner.
- The fast tier loses the `tools` suite (about 9 s of its budget); the `unit` suite loses the gate, handoff and acceptance-check tests.
- Trigger to revisit: device checks needed on most changes (bring back an automated runner, from the tag), or a repeated delegation brief that meets 0021 §5.

## Sources

- Tyler's answer to the Phase 4 batched question (b), 2026-10-10.
- The deleted code, at tag `phase-3-complete`.
