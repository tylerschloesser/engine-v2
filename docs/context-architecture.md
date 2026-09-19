# Context architecture

How this repo's documentation is split so that Claude sessions and sub-agents load only what they need. Applies during the bootstrap and afterwards.

## Principles

1. **Always-loaded context is the scarcest resource.** Root `CLAUDE.md` is loaded into every session and every sub-agent, so it is a map plus a handful of invariants. Content lives elsewhere and is read on demand.
2. **One file = one brief.** Split by *who needs it for which task*, not by document type. A research or implementation sub-agent should need `docs/spec/overview.md` + one domain file, not the whole spec.
3. **Separate by volatility and ownership.**
   - Intent (`docs/spec/`): what Tyler wants. Stable, Tyler-owned.
   - Evidence (`docs/research/`): what we found. Disposable once distilled.
   - Decisions (`docs/decisions/`): what we chose and why. Durable, append-only (supersede, don't rewrite).
   - Plan (`PRE-PLAN.md`, `PLAN.md`): what happens next. Disposable once executed.
   - Status (`PROMPT.md`): where we are right now. The most volatile file in the repo.
4. **Single source of truth.** Each fact lives in one file; everything else links to it. Duplicated facts drift, and a drifted fact in context is worse than a missing one.
5. **Docs describe the present.** History lives in git and in ADRs. Don't leave "previously we…" narration in living docs.
6. **Knowledge lives next to the code it describes.** Once code exists, subsystem-specific guidance goes in a nested `CLAUDE.md` in that package/crate (loaded only when Claude works there), not in the root file.
7. **Procedures are not prose.** Repeatable how-tos (run the suites, run the GC test, add an action type, profile a frame) become skills or scripts, not paragraphs in `CLAUDE.md`.

## Layout during bootstrap (Phases 1–3)

```
CLAUDE.md                     map + rules (always loaded)
PROMPT.md                     current phase entrypoint + status block
PRE-PLAN.md                   Phase 1 output: architecture + index of decisions
PLAN.md                       Phase 2 output: milestones, each sized to one session
docs/
  process.md                  phases, shared session rules
  context-architecture.md     this file
  spec/
    overview.md               read by everyone
    world.md                  ┐
    simulation.md             │ each: Requirements (Tyler's) + Open questions
    sync.md                   │ = one research brief in Phase 1,
    runtime-and-packaging.md  │   one implementation brief in Phase 3
    client.md                 │
    testing.md                │
    reference-game.md         ┘
  research/<topic>.md         Phase 1 sub-agent output
  decisions/NNNN-<slug>.md    ADRs
spikes/<name>/                throwaway feasibility code (Phase 1 only)
```

If `PLAN.md` outgrows one comfortable read, Phase 2 should split it into `PLAN.md` (index + ordering + progress) and `docs/plan/<milestone>.md` (one brief per session).

## Target layout after bootstrap (Phase 4)

```
CLAUDE.md                          map, commands, global invariants (determinism, zero-GC, test budget)
packages/engine/CLAUDE.md          JS-side conventions      ┐ loaded on demand when
crates/<engine-crate>/CLAUDE.md    Rust-side conventions    │ Claude touches files
packages/reference-game/CLAUDE.md  how the game uses the engine ┘ in that directory
docs/
  context-architecture.md          this file, updated
  architecture/<subsystem>.md      how each subsystem works *now*
  decisions/NNNN-<slug>.md         unchanged
.claude/skills/<procedure>/        repeatable procedures
```

Deleted in Phase 4: `PROMPT.md`, `PRE-PLAN.md`, `PLAN.md`, `docs/process.md`, `docs/research/`, `spikes/`. `docs/spec/` is folded into `docs/architecture/` (requirements that became behavior) and the reference game's own docs. Anything in the deleted files that can't be inferred from code must first be captured in an ADR.

## Open questions (Phase 1 resolves)

Verify against current Claude Code documentation (use the `claude-code-guide` agent; don't rely on memory, these features move fast):

- Exact loading behavior of nested `CLAUDE.md` files and of `@path` imports (eager vs on demand), and what sub-agents inherit.
- Whether path-scoped rules (`.claude/rules/` with path globs) are a better fit than nested `CLAUDE.md` for cross-cutting invariants, e.g. "no allocation in hot paths" scoped to the renderer and sim directories.
- Which procedures deserve a project skill, and whether any custom sub-agent definitions (`.claude/agents/`) are worth it, e.g. a "determinism reviewer" or "GC-regression checker".
- Whether hooks should enforce anything mechanically (e.g. run the fast suite before a commit) instead of relying on instructions.
- How Phase 3 progress is tracked across many sessions without `PROMPT.md` growing: status block only, details in `PLAN.md`.
