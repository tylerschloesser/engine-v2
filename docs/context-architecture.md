# Context architecture

How this repo's documentation is split so that Claude sessions and sub-agents load only what they need. Applies during the bootstrap and afterwards.

## Principles

1. **Always-loaded context is the scarcest resource.** Root `CLAUDE.md` is loaded at launch into every session and every sub-agent (except the built-in Explore and Plan agents, which load no `CLAUDE.md`), so it is a map plus a handful of invariants. Content lives elsewhere and is read on demand.
2. **One file = one brief.** Split by *who needs it for which task*, not by document type. A research or implementation sub-agent should need `docs/spec/overview.md` + one domain file, not the whole spec.
3. **Separate by volatility and ownership.**
   - Intent (`docs/spec/`): what Tyler wants. Stable, Tyler-owned.
   - Evidence (`docs/research/`): what we found. Disposable once distilled.
   - Decisions (`docs/decisions/`): what we chose and why. Durable, append-only (supersede, don't rewrite).
   - Plan (`PRE-PLAN.md`, `PLAN.md`): what happens next. Disposable once executed.
   - Status (`PROMPT.md`): where we are right now. The most volatile file in the repo.
4. **Single source of truth.** Each fact lives in one file; everything else links to it. Duplicated facts drift, and a drifted fact in context is worse than a missing one.
5. **Docs describe the present.** History lives in git and in ADRs. Don't leave "previously we…" narration in living docs.
6. **Knowledge lives next to the code it describes.** Conventions that are true only inside one package or crate go in a nested `CLAUDE.md` there, not in the root file. A nested `CLAUDE.md` loads when Claude reads a file in that directory, not at launch.
7. **Cross-cutting invariants are path-scoped rules.** An invariant that spans directories (no allocation in hot paths, determinism in sim code) is one file in `.claude/rules/` with `paths:` globs, loaded when Claude reads a matching file. Root `CLAUDE.md` names each invariant in one line and links to the rule, because on-demand loading does not fire for new files, after compaction, or in Explore/Plan sub-agents.
8. **Link, don't import.** `@path` imports load eagerly at launch, so they cost the same as pasting the file. Root `CLAUDE.md` refers to files as backticked paths that sessions read on demand.
9. **Procedures are not prose.** Repeatable how-tos become project skills in `.claude/skills/`, each wrapping a script or package command where possible. A skill is written in the milestone that first makes its procedure real, never speculatively.
10. **Brief sub-agents with files.** Sub-agents inherit the `CLAUDE.md` hierarchy and rules but no conversation history and no auto memory, so a brief names the files to read, the file to write, and the summary to return.
11. **Project state lives in git.** The `PROMPT.md` status block says where we are; `PLAN.md` says what is done. Nothing about project state is kept in auto memory or a resumable session.

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
  archive/                    Tyler's original brain dump; superseded by spec/, not a source
  decisions/NNNN-<slug>.md    ADRs
spikes/<name>/                throwaway feasibility code + RESULT.md (Phase 1 only)
.claude/                      created in Phase 3's first milestone, grows by milestone
  settings.json               permission allowlist + the commit format/lint hook
  hooks/pre-commit-check.sh   the hook's script
  rules/<invariant>.md        path-scoped invariants, each added with the first code it governs
  skills/<procedure>/SKILL.md procedures, each added when it becomes real
packages/engine/CLAUDE.md, packages/engine/crates/*/CLAUDE.md, games/*/CLAUDE.md
                              per-package conventions, each added in the milestone that
                              creates the package (layout: decisions/0017-packaging-and-build.md)
```

If `PLAN.md` outgrows one comfortable read, Phase 2 splits it into `PLAN.md` (index + ordering + progress) and `docs/plan/<milestone>.md` (one brief per session, carrying that milestone's exit-criteria checkboxes and deviations). The `PROMPT.md` status block holds only the current milestone, state, exact next step, and blockers, and is overwritten rather than appended to.

## Target layout after bootstrap (Phase 4)

```
CLAUDE.md                          map, commands, one line per global invariant (determinism, zero-GC, test budget)
packages/engine/CLAUDE.md                 JS-side conventions          ┐ loaded on demand when
packages/engine/crates/<crate>/CLAUDE.md  Rust-side conventions        │ Claude reads a file
games/reference/CLAUDE.md                 how the game uses the engine ┘ in that directory
docs/
  context-architecture.md          this file, updated
  architecture/<subsystem>.md      how each subsystem works *now*
  decisions/NNNN-<slug>.md         unchanged
.claude/
  settings.json                    permission allowlist + hooks
  hooks/                           hook scripts
  rules/<invariant>.md             path-scoped cross-cutting invariants
  skills/<procedure>/SKILL.md      repeatable procedures
```

Deleted in Phase 4: `PROMPT.md`, `PRE-PLAN.md`, `PLAN.md` (and `docs/plan/`), `docs/process.md`, `docs/research/`, `spikes/`. `docs/spec/` is folded into `docs/architecture/` (requirements that became behavior) and the reference game's own docs. Anything in the deleted files that can't be inferred from code must first be captured in an ADR.

## Decisions

[`decisions/0021-context-architecture.md`](decisions/0021-context-architecture.md) holds the specifics and the reasoning: which rule files and skills are expected and the milestone that creates each, the sub-agent briefing format, why there are no custom sub-agent definitions and what would justify one, the single commit-time hook and the triggers for extending or removing it, the permission allowlist, and Phase 3 progress tracking.
