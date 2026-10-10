# engine-v2

Multiplayer web game engine (Rust→WASM + TypeScript, custom WebGPU renderer) for top-down, tile-based, tick-simulated automation games, plus one reference game. Start at `docs/architecture/README.md` (goal, engine/game split, glossary, index of the subsystem docs).

**Phase 4 (clean-up) is still in progress: the main session starts at `PROMPT.md`.** (This line goes with it.)

**Commands:** `pnpm setup:tools` (once per machine) · `pnpm test [suite] [-t pattern]` · `pnpm test:slow` · `pnpm lint` · `pnpm format` · `pnpm golden [fixture]` (the only writer of golden hashes) · `pnpm device:serve` (pages for a phone). Both checks are quiet: one line per suite or check, details only on failure, logs under `test-results/`. How to run and read them: the `run-tests` skill.

## Context map

Read only what the task needs. A sub-agent is briefed with files: its goal, one or two docs below, the file to write, the size of its report (ADR 0021 §3).

| Path | What it holds |
|---|---|
| `docs/architecture/<subsystem>.md` | How each subsystem works now: world and worldgen, simulation, sync and netcode, persistence, threads and the JS/WASM boundary, renderer, camera/input/overlay, client API, runtime and hosting, testing and tooling |
| `docs/decisions/NNNN-<slug>.md` | ADRs 0001–0070 (index: `docs/decisions/README.md`): what was chosen and the *why* that can't be read from code. Supersede, don't rewrite |
| `packages/engine/` | The engine package: TypeScript in `src/`, the Rust crate in `crates/engine/`, fixture games in `fixtures/`, suites in `tests/`; nested `CLAUDE.md` files hold commands, layout and test placement |
| `games/reference/`, `games/reference-server/` | The reference game (its rules: `games/reference/README.md`) and its dedicated server; each has a `CLAUDE.md` |
| `scripts/` | `pnpm test` / `lint` / `setup:tools` runners (plain Node `.mjs`); `scripts/suites.mjs` registers suites and build steps |
| `.claude/` | `settings.json` (allowlist; commit gate `hooks/pre-commit-check.sh`: Biome + rustfmt), `rules/` (the invariants below), `skills/` (`run-tests`, `add-action-type`, `write-adr`, `gc-test`, `profile-frame`, `device-check`) |
| `docs/context-architecture.md` | How context is split (root and nested `CLAUDE.md`, rules, skills, sub-agent briefs) and why |

Comments cite Phase 3 milestones as `M13`, `M24b steps 4-6`, ...: those briefs are under `docs/plan/` at tag `phase-3-complete` (`git show phase-3-complete:docs/plan/...`). ADR Sources links into deleted paths resolve the same way.

## Invariants

Each has a path-scoped rule file that loads when you read a matching file; read it yourself before creating a new file in its area.

- **Determinism:** sim, worldgen and `apply` code must produce the same bits natively and as `.wasm` in every runtime: `.claude/rules/determinism.md`.
- **Hot paths:** no allocation per frame or per tick in the JS around a WASM instance: `.claude/rules/hot-paths.md`.
- **Prediction:** validate first and write after, `?` on every read, a provisional id is never encoded, and a predicted status is a hint until the host acks it: `.claude/rules/prediction.md`.
- **Test budget:** each fast-tier suite has a time budget in `scripts/suites.mjs` (warn over it, fail at 1.5×); a new test fits inside it, or the commit says why the budget moves (`docs/architecture/testing-and-tooling.md`).

## Rules

- Tyler owns the requirements: the fixed decisions in `docs/architecture/README.md` and the game rules in `games/reference/README.md`, with his dated answers. Change them only to record what Tyler said. Scope, taste and cost are his to decide (ask, batched); technical questions are yours, recorded with the `write-adr` skill.
- Every fact lives in exactly one file. Link, don't copy. A change that makes an architecture doc wrong fixes the doc in the same commit.
- This file is a map, not content. Keep it under 60 lines (a `unit` test enforces it) and never `@import` large files into it.
- Commit early and often, on `main`; no branches. The commit gate needs a formatted tree: run `pnpm format` first.
- On Tyler's machine `cp`, `mv` and `rm` are aliased to their `-i` forms and hang a Bash call: use `command cp -f`, `command mv -f`, `command rm -f`. Scripts use `node:fs`, never shell file operations.
