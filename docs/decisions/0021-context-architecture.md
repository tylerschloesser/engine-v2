# 0021: Context architecture for Claude Code sessions

Status: Accepted (2026-09-19)

## Context

Almost all code in this repo is written by Claude Code sessions and their sub-agents, one session per milestone. What each session loads, and when, decides both cost and whether invariants (determinism, zero allocation in hot paths, the test budget) are actually followed. `docs/context-architecture.md` left five questions open. The behavior below was checked against the Claude Code docs on 2026-09-19 (see Sources):

- Root `CLAUDE.md` loads at launch and is re-read from disk after compaction. A nested `CLAUDE.md` loads only when Claude **reads** a file in that directory, and after compaction only once Claude reads there again.
- `.claude/rules/*.md` without `paths:` frontmatter load at launch like root `CLAUDE.md`. With `paths:` globs they load when Claude reads a matching file. Writing a new file without reading anything nearby triggers neither mechanism.
- `@path` imports are expanded at launch, recursively up to four hops. They organize text; they do not defer or reduce context.
- Sub-agents get the same `CLAUDE.md` hierarchy and rules as the main session, plus the delegation prompt and a git status snapshot. They get no conversation history and no auto memory. The built-in Explore and Plan agents skip `CLAUDE.md` entirely.
- Auto memory is machine-local and is not loaded by sub-agents.
- A `PreToolUse` hook that exits 2 blocks the tool call and feeds stderr to Claude, in every permission mode. Command hooks default to a 10-minute timeout. A `Stop` hook is overridden after eight consecutive blocks.

## Decision

**1. Nested `CLAUDE.md` for local conventions; path-scoped rules for cross-cutting invariants.**
- Each package and crate gets a `CLAUDE.md` holding what is true only there: its commands, module layout, test patterns, local gotchas. It is created in the milestone that creates the package, and stays under ~60 lines.
- An invariant that spans directories gets one file in `.claude/rules/` with `paths:` globs. Expected: `hot-paths.md` (no allocation per frame or per tick; globs cover the renderer, the sim crates, and the JS frame loop) and `determinism.md` (no wall clock, no unordered iteration, no platform floats, seeded RNG only; globs cover sim and world-gen code). Each is created in the milestone that creates the first code it governs, with globs taken from the real layout.
- Root `CLAUDE.md` names each global invariant in one line and links to the rule file. This is the fallback for the cases where on-demand loading does not fire (new files, post-compaction, Explore/Plan agents).
- No rule file without `paths:`. Anything that must always load belongs in root `CLAUDE.md`, so there is one always-loaded file to keep small.

**2. No `@path` imports in root `CLAUDE.md`.** They load eagerly, so an import is the same cost as pasting the file. The root file links to paths in backticks (which also prevents accidental import) and sessions read them on demand. A nested `CLAUDE.md` may import only a short file in its own package, and should prefer a link.

**3. Sub-agents are briefed with files, not with conversation.** A brief is self-contained: the goal, the exact files to read (`docs/spec/overview.md` or, in Phase 3, the milestone brief; plus one or two domain files or ADRs), the file to write output to, and the size of summary to return. Anything that exists only in the main conversation must be written into the brief or into a file first. Explore and Plan briefs restate any invariant they need, since those agents load no `CLAUDE.md`. A brief that depends on a procedure names the skill's `SKILL.md` path.

**4. Procedures become project skills, written when the procedure becomes real.** A skill in `.claude/skills/<name>/SKILL.md` is written in the milestone that first makes its procedure executable, by the session that just performed it, and never speculatively. A skill wraps a script or package command wherever possible; the skill says when and how to interpret results, the script does the work. Expected skills and their trigger:

| Skill | Written in the milestone that lands |
|---|---|
| `run-tests` (fast and slow suites, filtering, reading failure artefacts) | the test harness |
| `gc-test` (run and interpret the GC/allocation check) | the GC/allocation check |
| `add-action-type` (files and patterns on both sides) | the first action round-trip |
| `profile-frame` (capture and read a frame profile against the budgets) | the first milestone with a frame-time exit criterion |
| `write-adr` (format, numbering, superseding) | Phase 3's first milestone; until then existing ADRs are the template |

`PLAN.md` assigns each skill to its milestone as an exit criterion.

**5. No custom sub-agent definitions (`.claude/agents/`) for now.** Determinism and GC regressions are caught by tests, which are cheaper and more reliable than a reviewer agent. One is justified when the same brief has been hand-written for three or more milestones **and** it needs something a skill cannot give: a restricted tool set, a different model, worktree isolation, or preloaded skills. Adding one takes a new ADR.

**6. One hook: a format-and-lint gate on `git commit`.** Created with `.claude/settings.json` in Phase 3's first milestone. A `PreToolUse` command hook, `matcher: "Bash"`, `if: "Bash(git commit *)"`, runs `.claude/hooks/pre-commit-check.sh`. The script reads the tool input from stdin, exits 0 immediately unless the command really is a `git commit`, then runs only checks that are deterministic and need no build: `cargo fmt --check` and the TypeScript formatter/linter in check mode. On failure it exits 2 and prints the one command that fixes it. `timeout: 30`.
- Tradeoff, stated plainly: every commit pays the check (target under 3 s; sessions commit often, so a slower gate would discourage commits), and an `if` pattern with arguments also fires on commands containing `$()` or `$VAR`, which is why the script re-checks. It gates Claude's commits only, not Tyler's.
- Tests, type-checking, and builds are **not** in the hook. They are slow when caches are cold, browser suites can flake, and work-in-progress commits at the 50% context stop must stay possible. They are enforced by milestone exit criteria and the `run-tests` skill.
- Trigger to extend: if a milestone is twice found committed as done with a failing fast suite, add the fast suite to the gate, provided it runs under ~10 s warm and has had no flaky failure. Trigger to remove: any false block that costs a session more than one retry.

**7. Permission allowlist in `.claude/settings.json`** (checked in; created in Phase 3's first milestone, when the commands exist). Allow: `Bash(pnpm *)`, `Bash(cargo *)`, no separate WASM build tool (the build is plain `cargo`, [0017](0017-packaging-and-build.md)), read-only git (`status`, `diff`, `log`, `show`), `Bash(git add *)`, `Bash(git commit *)`. Playwright runs through `pnpm` scripts, so it needs no separate entry. Deny: `Bash(pnpm publish *)`, `Bash(cargo publish *)`. Not allowlisted, so they still prompt: `git push`, `git reset`, `rm`, network tools. `pnpm *` and `cargo *` are broad (they run arbitrary repo scripts); accepted for a single-owner repo. File edits are left to the session's permission mode. Machine-specific entries go in `.claude/settings.local.json`.

**8. Phase 3 progress lives in the repo, in two places.** The `PROMPT.md` status block holds only: current milestone, state, exact next step, blockers. It is overwritten, never appended to. Per-milestone state (exit-criteria checkboxes, done/in progress, deviations) lives in `PLAN.md`, or in `docs/plan/<milestone>.md` if Phase 2 splits the plan. Nothing about project state is entrusted to auto memory, `--resume`, `/goal`, or scheduled tasks: a fresh session on any machine must be able to continue from `PROMPT.md` alone.

## Alternatives rejected

- **Nested `CLAUDE.md` only.** A cross-cutting invariant would be copied into every affected package and drift.
- **Rules only.** Package conventions would sit far from the code and need glob upkeep on every move; a nested file moves with its directory.
- **Invariants in full in root `CLAUDE.md`.** Every session and sub-agent pays for determinism detail while editing docs or UI.
- **`@path` imports to keep root short.** Shorter to the eye only; the context cost is identical.
- **Writing all skills now.** No commands exist; a skill describing an imagined procedure is a drifted fact on day one.
- **Reviewer sub-agents (determinism, GC).** A test gives the same answer deterministically and for free on every run.
- **`Stop` hook running tests.** Fires at the end of every turn, including questions and doc edits; slow; capped at eight blocks; false blocks on unrelated turns.
- **Fast test suite in the commit gate from the start.** Penalizes frequent commits and blocks WIP handoff commits; revisit per the trigger above.
- **`PostToolUse` auto-format on every edit.** Rewrites files behind Claude's back, producing stale-read retries; checking once at commit is cheaper.
- **`SessionStart` (`compact`) hook re-injecting status.** Root `CLAUDE.md` already survives compaction and points to `PROMPT.md`.
- **Git-native pre-commit hook.** Needs a per-clone install step that a fresh session or worktree can miss; `.claude/settings.json` applies on checkout.
- **Auto memory or session resume for progress.** Machine-local, invisible to sub-agents and to Tyler, not in git.

## Consequences

- Root `CLAUDE.md` stays a map plus one-line invariants; its ~60-line cap holds through Phase 4.
- Because nested files and path-scoped rules load on read, a session about to create files in an area should first read an existing file there (or the rule file directly). Milestone briefs list the rule files that apply.
- Rule globs are coupled to the directory layout. Moving a crate means updating `paths:` in the same commit.
- Phase 2 must schedule `.claude/settings.json`, the hook script, and `write-adr` in the first Phase 3 milestone, and attach each other skill and rule file to a milestone.
- The hook script is code: it is small, has no dependencies beyond the repo's toolchain, and is deleted if it ever false-blocks repeatedly.

## Sources

- Research: [`../research/context-architecture.md`](../research/context-architecture.md)
- CLAUDE.md loading, imports, `.claude/rules/`, compaction, auto memory: https://code.claude.com/docs/en/memory.md
- Sub-agent startup context, `omitClaudeMd`, `skills` preload: https://code.claude.com/docs/en/sub-agents.md
- Skills format and script bundling: https://code.claude.com/docs/en/skills.md
- Hooks (`if` field, exit 2, timeouts, Stop override): https://code.claude.com/docs/en/hooks-guide.md
- Nested `CLAUDE.md` vs rules in large repos: https://code.claude.com/docs/en/large-codebases.md
- Permission rule syntax: https://code.claude.com/docs/en/permissions
