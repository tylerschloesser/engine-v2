# engine-v2

Multiplayer web game engine (Rust→WASM + TypeScript, custom WebGPU renderer) for top-down, tile-based, tick-simulated automation games, plus one reference game. The repo is in a phased bootstrap: in Phase 3 one orchestrating session lands milestones in serial on `main`, each built by a Sonnet sub-agent.

**The main session starts at `PROMPT.md`.** It names the current milestone, the loop to follow, and when you're done. A sub-agent's entry point is its delegation prompt, not `PROMPT.md`.

**Commands:** `pnpm setup:tools` (once per machine) · `pnpm test [suite] [-t pattern]` · `pnpm test:slow` · `pnpm lint` · `pnpm format` · `pnpm golden [fixture]` (the only writer of golden hashes) · `pnpm gate <base-sha>` (what a milestone changed, for the orchestrator). Both checks are quiet: one line per suite or check, details only on failure, logs under `test-results/`.

## Context map

Read only what the task needs. A sub-agent should be briefable with `docs/spec/overview.md` plus one or two other files.

| Path | What it holds | Lifetime |
|---|---|---|
| `PROMPT.md` | Current phase and milestone: status block, the orchestrator's loop, rules | Rewritten each phase; deleted in Phase 4 |
| `packages/engine/` | The engine package (TypeScript in `src/`) and, in `crates/engine/`, the Rust crate; each has a nested `CLAUDE.md` with its commands and test placement | Permanent |
| `scripts/` | `pnpm test` / `lint` / `setup:tools` runners (plain Node `.mjs`); `scripts/suites.mjs` is where suites and build steps are registered | Permanent |
| `.claude/` | `settings.json` (allowlist, commit gate running `hooks/pre-commit-check.sh`: Biome + rustfmt), `skills/` (`write-adr`), `rules/` (the invariants below), `agents/` (`milestone-implementer`, the Sonnet sub-agent that builds a milestone) | Permanent |
| `docs/process.md` | The four phases; rules common to every session | Until Phase 4 |
| `docs/context-architecture.md` | How context is split and why (nested `CLAUDE.md`, `.claude/rules/`, skills, sub-agent briefs); target layout after bootstrap | Permanent |
| `docs/spec/overview.md` | Goal, engine/game split, fixed decisions, scale, non-goals, glossary | Folded into architecture docs in Phase 4 |
| `docs/spec/<domain>.md` | Tyler's requirements + open questions for one domain: `world`, `simulation`, `sync`, `runtime-and-packaging`, `client`, `testing`, `reference-game` | Same |
| `docs/research/<topic>.md` | Phase 1 findings, one file per spec domain plus `context-architecture` (evidence, not decisions) | Deleted in Phase 4 |
| `spikes/<name>/RESULT.md` | Result of each Phase 1 feasibility spike; the code beside it is throwaway | Deleted in Phase 4 |
| `docs/decisions/NNNN-<slug>.md` | ADRs 0001–0025 (index in `PRE-PLAN.md` §1): what was chosen and the *why* that can't be inferred from code | Permanent; supersede, don't rewrite |
| `docs/archive/` | Tyler's original brain dump, superseded by `docs/spec/`; not a source | Deleted in Phase 4 |
| `PRE-PLAN.md` | Phase 1 output: architecture, budgets, index of ADRs | Deleted in Phase 4 |
| `PLAN.md` | Phase 2 output: milestone index in execution order, dependencies, progress checkboxes | Deleted in Phase 4 |
| `docs/plan/<NN>-<slug>.md` | One brief per milestone: the whole instruction set for one implementer sub-agent (format: `docs/plan/README.md`) | Deleted in Phase 4 |
| `docs/plan/*.md` (unnumbered) | `questions-for-tyler`, `device-checks` (Tyler-run), `deferred-ledger`, `coverage`, `coverage-adrs`, `reference-coverage` | Deleted in Phase 4 |

## Invariants

Each has a path-scoped rule file that loads when you read a matching file; read it yourself before creating a new file in its area.

- **Determinism:** sim, worldgen and `apply` code must produce the same bits natively and as `.wasm` in every runtime: `.claude/rules/determinism.md`.
- **Hot paths:** no allocation per frame or per tick in the JS around a WASM instance: `.claude/rules/hot-paths.md`.

## Rules

- Tyler owns the **Requirements** sections in `docs/spec/`. Edit them only to record something Tyler said. Resolve **Open questions** by writing a decision in `docs/decisions/` and replacing the question with a link.
- Every fact lives in exactly one file. Link, don't copy.
- This file is a map, not content. Keep it under ~60 lines and never `@import` large files into it.
- Commit early and often, on `main`; no branches (tags: ADR 0025 §4). The commit gate needs a formatted tree: run `pnpm format` first.
- On Tyler's machine `cp`, `mv` and `rm` are aliased to their `-i` forms and hang a Bash call: use `command cp -f`, `command mv -f`, `command rm -f`. Scripts use `node:fs`, never shell file operations.
