# PROMPT: Phase 1 (Pre-plan)

## Status

- **Phase:** 1 of 4, not started. (Updated 2026-09-19.)
- **State:** The repo holds only context files. No code, no research, no decisions yet.
- **Next step:** Begin at "What to do" below.

If you stop early (context budget, blocker), update this Status block with the current state and exact next steps, commit, and end. Leave the rest of this file intact.

## Your job

Turn Tyler's rough goals into a finished set of decisions. By the end of this session every big technical question is researched and decided, the repo contains all the context needed to write the final implementation plan, and `PROMPT.md` is rewritten so a fresh session can start Phase 2 with nothing else explained.

You are not writing engine code in this phase.

## Read first

1. `docs/process.md`: the phases and the rules every session follows (delegation, context budget, commits, who decides what).
2. `docs/spec/overview.md`: the goal, the engine/game split, and the decisions Tyler has already made.
3. The seven domain files in `docs/spec/`. They're short. Each has **Requirements** (Tyler's; treat as fixed) and **Open questions** (yours to resolve).
4. `docs/context-architecture.md`: how context is organized, and its own open questions.

`docs/archive/` holds Tyler's original brain dump. It's superseded by `docs/spec/`; don't use it as a source.

## What to do

1. **Challenge the spec.** Before researching, look for gaps, contradictions, and unstated assumptions across the spec files, beyond the open questions already listed. Add what you find to the relevant file's open questions.
2. **Research in parallel with sub-agents**, one per domain file, plus one for the context architecture. Brief each with `overview.md` + its domain file. Each writes `docs/research/<topic>.md` containing: findings with sources, prior art and what to take from it, a recommendation per open question with confidence, and anything that needs a spike to settle. Each returns only a short summary to you. Research must use current sources (docs, support tables, release notes), not memory.
3. **Spike only where a decision hinges on feasibility.** Throwaway code under `spikes/<name>/`, timeboxed, run by sub-agents. Likely candidates: asserting zero GC in headless Chrome with a real WebGPU device; a Vite app consuming a library that ships a worker and a game-built WASM module; SharedArrayBuffer under cross-origin isolation in dev and production. Record the result in the research file.
4. **Ask Tyler once, in a batch.** Collect everything that is scope, taste, or cost, including the proposed non-goals in `overview.md` and the small gaps in `reference-game.md`. Offer a recommended default for each. Record answers in the spec's Requirements sections.
5. **Decide.** The domains interact (cross-origin isolation ↔ hosting; renderer placement ↔ GC ↔ input latency; WASM vs. native server ↔ determinism ↔ host choice), so synthesize across research files before committing to anything. Write one ADR per decision in `docs/decisions/NNNN-<slug>.md`: context, decision, alternatives rejected and why, consequences. In each spec file, replace resolved open questions with a link to the ADR.
6. **Write `PRE-PLAN.md`.** It links to ADRs rather than restating them, and contains:
   - Architecture overview: processes, threads, memory ownership, and data flow for both single-player and multiplayer.
   - Package and crate layout, entrypoints, and the build pipeline.
   - Sketch of the game-facing API: the Rust traits a game implements and the TypeScript surface it uses.
   - Protocol sketch: action and delta flow, tick and send rates, subscription changes, reconnect.
   - Testing strategy: tools, suite structure, how GC and determinism are asserted, how the 1-minute budget is met.
   - Performance budgets as numbers: frame time, tick time, chunk generation latency, bandwidth per client, memory.
   - Risks, and the unknowns deliberately left for Phase 2.
7. **Finalize the context architecture.** Apply what the research found to `docs/context-architecture.md` and `CLAUDE.md`.
8. **Hand off.** Rewrite this file for Phase 2 per `docs/process.md`. Commit.

## Exit criteria

- [ ] Every open question in `docs/spec/*.md` and `docs/context-architecture.md` is either resolved with a linked ADR or explicitly deferred to Phase 2 with a reason, listed in `PRE-PLAN.md`.
- [ ] Every ADR names the alternatives it rejected. No technology is chosen without a checked, current source or a spike.
- [ ] Every feasibility risk that a decision depends on has a spike result or a stated reason it didn't need one.
- [ ] Tyler has answered the batched questions, and the answers are recorded in the spec.
- [ ] `PRE-PLAN.md` contains every section listed above and contradicts no spec Requirement.
- [ ] A fresh session given only `PROMPT.md` could write `PLAN.md` without doing new research. Check this by having a sub-agent read only `PROMPT.md` and what it links to, then list what it would still need to know. Fix what it finds.
- [ ] `PROMPT.md` is rewritten for Phase 2, `CLAUDE.md`'s map is accurate, and everything is committed.
