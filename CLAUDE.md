# engine-v2

Multiplayer web game engine (Rust→WASM + TypeScript, custom WebGPU renderer) for top-down, tile-based, tick-simulated automation games, plus one reference game. Nothing is built yet: the repo is in a phased bootstrap.

**Start every session at `PROMPT.md`.** It says which phase we're in, what to do, and when you're done.

## Context map

Read only what the task needs. A sub-agent should be briefable with `docs/spec/overview.md` plus one or two other files.

| Path | What it holds | Lifetime |
|---|---|---|
| `PROMPT.md` | Current phase: status, instructions, exit criteria | Rewritten each phase; deleted in Phase 4 |
| `docs/process.md` | The four phases; rules common to every session | Until Phase 4 |
| `docs/context-architecture.md` | How context is split and why; target layout after bootstrap | Permanent |
| `docs/spec/overview.md` | Goal, engine/game split, fixed decisions, scale, non-goals, glossary | Folded into architecture docs in Phase 4 |
| `docs/spec/<domain>.md` | Tyler's requirements + open questions for one domain: `world`, `simulation`, `sync`, `runtime-and-packaging`, `client`, `testing`, `reference-game` | Same |
| `docs/research/` | Phase 1 findings, one file per topic (evidence, not decisions) | Distilled into decisions, then deleted in Phase 4 |
| `docs/decisions/` | ADRs: the *why* that can't be inferred from code | Permanent |
| `PRE-PLAN.md`, `PLAN.md` | Phase 1 and Phase 2 outputs | Deleted in Phase 4 |

## Rules

- Tyler owns the **Requirements** sections in `docs/spec/`. Edit them only to record something Tyler said. Resolve **Open questions** by writing a decision in `docs/decisions/` and replacing the question with a link.
- Every fact lives in exactly one file. Link, don't copy.
- This file is a map, not content. Keep it under ~60 lines and never `@import` large files into it.
- Commit early and often.
