# Context architecture

How this repo's documentation is split so that Claude sessions and sub-agents load only what they need.

## Principles

1. **Always-loaded context is the scarcest resource.** Root `CLAUDE.md` is loaded at launch into every session and every sub-agent (except the built-in Explore and Plan agents, which load no `CLAUDE.md`), so it is a map plus a handful of invariants. Content lives elsewhere and is read on demand.
2. **One file = one brief.** Split by *who needs it for which task*, not by document type. A sub-agent changing the renderer should need `docs/architecture/renderer.md` and the ADRs it links, not every doc.
3. **Separate by volatility and ownership.**
   - Requirements: what Tyler wants. The fixed decisions in `docs/architecture/README.md` and the game rules in `games/reference/README.md`, Tyler-owned, with his dated answers.
   - Descriptions (`docs/architecture/`, nested `CLAUDE.md`): how the code works now. Updated in the same commit as the code they describe.
   - Decisions (`docs/decisions/`): what we chose and why. Durable, append-only (supersede, don't rewrite).
4. **Single source of truth.** Each fact lives in one file; everything else links to it. Duplicated facts drift, and a drifted fact in context is worse than a missing one.
5. **Docs describe the present.** History lives in git and in ADRs. Don't leave "previously we…" narration in living docs.
6. **Knowledge lives next to the code it describes.** Conventions that are true only inside one package or crate go in a nested `CLAUDE.md` there, not in the root file. A nested `CLAUDE.md` loads when Claude reads a file in that directory, not at launch.
7. **Cross-cutting invariants are path-scoped rules.** An invariant that spans directories (no allocation in hot paths, determinism in sim code, prediction) is one file in `.claude/rules/` with `paths:` globs, loaded when Claude reads a matching file. Root `CLAUDE.md` names each invariant in one line and links to the rule, because on-demand loading does not fire for new files, after compaction, or in Explore/Plan sub-agents.
8. **Link, don't import.** `@path` imports load eagerly at launch, so they cost the same as pasting the file. Root `CLAUDE.md` refers to files as backticked paths that sessions read on demand.
9. **Procedures are not prose.** Repeatable how-tos become project skills in `.claude/skills/`, each wrapping a script or package command where possible. A skill is written when its procedure first becomes real, never speculatively.
10. **Brief sub-agents with files.** Sub-agents inherit the `CLAUDE.md` hierarchy and rules but no conversation history and no auto memory, so a brief names the files to read, the file to write, and the summary to return.
11. **Project state lives in git.** Nothing about project state is kept in auto memory or a resumable session.

## Layout

```
CLAUDE.md                                 map, commands, one line per global invariant (always loaded)
packages/engine/CLAUDE.md                 JS-side conventions            ┐
packages/engine/src/**/CLAUDE.md          per-area TypeScript notes      │ loaded on demand when
packages/engine/crates/engine/**/CLAUDE.md  Rust-side conventions        │ Claude reads a file
packages/engine/fixtures/**/CLAUDE.md     fixture games                  │ in that directory
packages/engine/tests/netcode/CLAUDE.md   the netcode harness            │
games/reference/CLAUDE.md                 how the game uses the engine   │
games/reference-server/CLAUDE.md          the dedicated server           ┘
games/reference/README.md                 the game's rules (Tyler's requirements)
docs/
  context-architecture.md                 this file
  architecture/README.md                  goal, engine/game split, fixed decisions, glossary, index
  architecture/<subsystem>.md             how each subsystem works now
  decisions/NNNN-<slug>.md                ADRs; index in decisions/README.md
.claude/
  settings.json                           permission allowlist + the commit format/lint hook
  hooks/pre-commit-check.sh               the hook's script
  rules/<invariant>.md                    path-scoped cross-cutting invariants
  skills/<procedure>/SKILL.md             repeatable procedures
```

The repo was bootstrapped in four phases (pre-plan, plan, build, clean-up) from planning files that the clean-up deleted; they are at tag `phase-3-complete`. Code comments cite the build milestones as `M13` and ADR Sources sections link into the deleted paths; both resolve at that tag.

## Decisions

[`decisions/0021-context-architecture.md`](decisions/0021-context-architecture.md) holds the specifics and the reasoning: nested `CLAUDE.md` versus rules, no imports, the sub-agent briefing format, skills, why there are no custom sub-agent definitions and what would justify one, the single commit-time hook and the triggers for extending or removing it, and the permission allowlist. [`decisions/0070-phase-3-tooling-retired.md`](decisions/0070-phase-3-tooling-retired.md) retired the build-phase orchestration ([0025](decisions/0025-phase-3-orchestration.md)) and its tooling.
