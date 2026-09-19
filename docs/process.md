# Process

The engine is built in four phases. Each phase has exit criteria and hands off through `PROMPT.md`.

## Rules for every session

- **`PROMPT.md` is the only entrypoint** of a main session (a sub-agent's entrypoint is its delegation prompt). A fresh session pointed at it must need nothing else explained. Every phase begins by reading it and ends by rewriting it for the next phase (except the last, which deletes it).
- **Delegate to sub-agents** wherever possible: research, exploration, spikes, verification, and in Phase 3 the implementation too, on Sonnet (`docs/decisions/0025-phase-3-orchestration.md`). Sub-agents write findings to files and return a short summary, so the main context holds conclusions, not raw material. Brief them with `docs/spec/overview.md` + the relevant domain file(s).
- **One session per phase** (Phase 3: one orchestrating session lands several milestones in serial, and a new one continues from `PROMPT.md`). If context use passes roughly 50%, stop (in Phase 3 at a milestone boundary): commit, update the status block at the top of `PROMPT.md` with current state and exact next steps, and end the session. Update the status block only; don't overwrite the phase instructions.
- **Commit early and often, on `main`.** Small commits with clear messages, at least one per completed step. No branches. Annotated tags mark phase ends (`phase-<n>-complete`) and the marker rows of `PLAN.md`.
- **Exit criteria are binding.** Don't declare a phase or milestone done until every criterion is met and verified; report honestly what isn't.
- **Who decides.** Claude decides technical questions and records the rationale in an ADR. Ask Tyler (batched, not one at a time) for anything that is scope, taste, or cost, or that would change a Requirements section in `docs/spec/`.
- **Verify, don't recall.** Browser, tooling, and Claude Code capabilities change quickly. Check current docs and support tables rather than relying on training data, and cite sources in research files.

## Phase 1: Pre-plan

Research and finalize the big decisions. Evaluate prior art and current best practice, pick technologies, settle the architecture, and leave the repo holding all the context needed to write the final plan.

Output: `PRE-PLAN.md`, `docs/research/`, `docs/decisions/`, updated spec open questions, `PROMPT.md` rewritten for Phase 2. Detailed instructions and exit criteria live in the Phase 1 `PROMPT.md`.

## Phase 2: Plan

Turn `PRE-PLAN.md` and the decisions into `PLAN.md`: exactly how to write, test, and verify the code.

- Milestones sized to fit one context each (in Phase 3 that context is one implementer sub-agent's), ordered so a thin vertical slice (chunked world on screen, camera input, sim in a worker, one action round-trip, tests green) lands as early as possible.
- Each milestone has: scope, files/packages touched, the spec/decision files to read, exit criteria, and the exact commands that verify them.
- The test harness (including the GC and determinism checks) is an early milestone, not a late one.

Output: `PLAN.md` (split per `docs/context-architecture.md` if large), `PROMPT.md` rewritten for Phase 3.

## Phase 3: Execute

Execute `PLAN.md` milestone by milestone, in serial, from one orchestrating session: per milestone it delegates the build to a Sonnet implementer sub-agent briefed with the milestone's brief, checks the result against the repo, records it, and goes on to the next. The `PROMPT.md` status block records the milestone in flight or next; `PLAN.md` records what's done. Deviations from the plan get an ADR or a plan edit, not silent drift.

Done when the reference game in `docs/spec/reference-game.md` works in single-player and multiplayer and the full test suite passes within budget.

## Phase 4: Clean up

Remove the bootstrap scaffolding and re-architect context around the final state of the code, for future iteration. Follow the target layout in `docs/context-architecture.md`. Keep decisions and details that can't be inferred from the code; delete most of the original prompting.
