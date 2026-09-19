# engine-v2

Multiplayer web game engine (Rust→WASM + TypeScript, custom WebGPU renderer) for top-down, tile-based, tick-simulated automation games, plus one reference game. The repo is in a phased bootstrap: Phase 3 builds it one milestone per session.

**Start every session at `PROMPT.md`.** It names the current milestone, the loop to follow, and when you're done.

## Context map

Read only what the task needs. A sub-agent should be briefable with `docs/spec/overview.md` plus one or two other files.

| Path | What it holds | Lifetime |
|---|---|---|
| `PROMPT.md` | Current phase and milestone: status block, the session loop, rules | Rewritten each phase; deleted in Phase 4 |
| `docs/process.md` | The four phases; rules common to every session | Until Phase 4 |
| `docs/context-architecture.md` | How context is split and why (nested `CLAUDE.md`, `.claude/rules/`, skills, sub-agent briefs); target layout after bootstrap | Permanent |
| `docs/spec/overview.md` | Goal, engine/game split, fixed decisions, scale, non-goals, glossary | Folded into architecture docs in Phase 4 |
| `docs/spec/<domain>.md` | Tyler's requirements + open questions for one domain: `world`, `simulation`, `sync`, `runtime-and-packaging`, `client`, `testing`, `reference-game` | Same |
| `docs/research/<topic>.md` | Phase 1 findings, one file per spec domain plus `context-architecture` (evidence, not decisions) | Deleted in Phase 4 |
| `spikes/<name>/RESULT.md` | Result of each Phase 1 feasibility spike; the code beside it is throwaway | Deleted in Phase 4 |
| `docs/decisions/NNNN-<slug>.md` | ADRs 0001–0024 (index in `PRE-PLAN.md` §1): what was chosen and the *why* that can't be inferred from code | Permanent; supersede, don't rewrite |
| `docs/archive/` | Tyler's original brain dump, superseded by `docs/spec/`; not a source | Deleted in Phase 4 |
| `PRE-PLAN.md` | Phase 1 output: architecture, budgets, index of ADRs | Deleted in Phase 4 |
| `PLAN.md` | Phase 2 output: milestone index in execution order, dependencies, progress checkboxes | Deleted in Phase 4 |
| `docs/plan/<NN>-<slug>.md` | One brief per milestone: the whole instruction set for one session (format: `docs/plan/README.md`) | Deleted in Phase 4 |
| `docs/plan/*.md` (unnumbered) | `questions-for-tyler`, `device-checks` (Tyler-run), `deferred-ledger`, `coverage`, `coverage-adrs`, `reference-coverage` | Deleted in Phase 4 |

## Rules

- Tyler owns the **Requirements** sections in `docs/spec/`. Edit them only to record something Tyler said. Resolve **Open questions** by writing a decision in `docs/decisions/` and replacing the question with a link.
- Every fact lives in exactly one file. Link, don't copy.
- This file is a map, not content. Keep it under ~60 lines and never `@import` large files into it.
- Commit early and often.
