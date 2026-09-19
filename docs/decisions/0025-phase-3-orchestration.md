# 0025: Phase 3 runs as one orchestrating session with Sonnet implementers, on `main`

Status: Accepted (2026-09-19). Amends [0021](0021-context-architecture.md): the "one session per milestone" premise of its Context, §3 (what a Phase 3 sub-agent is briefed for), §5 (adds the first custom sub-agent) and §7 (one allowlist entry). Implemented before M02b, outside the milestone table.

## Context

Phase 2 planned Phase 3 as one milestone per session and, in `PROMPT.md`, one branch per milestone, merged by Tyler. After M01 and M02 that had produced two unmerged branches and a fresh top-model session for each of roughly 55 remaining milestones. Tyler wants the opposite: one Fable or Opus session that lands several milestones in serial while Sonnet sub-agents do as much of the work as possible, and no pile of branches: work on `main`, commit often, tag the big milestones.

Forces:
- A milestone brief is already a self-contained instruction set with a fixed reading list ([0021](0021-context-architecture.md) §3, `docs/plan/README.md`), so it can brief a sub-agent as well as a session. The sizing rule of `PLAN.md` bounds one context either way.
- The delegation prompt would be the same text for every milestone, and the implementer must run on a different model from the session. That is the trigger 0021 §5 names for a custom sub-agent, and it demands this ADR.
- An implementer's report is a claim. Whoever ticks a box has to look at the repo, cheaply, without reading the milestone's code.

Checked against the Claude Code docs on 2026-09-19 (see Sources): a file in `.claude/agents/` with `name`, `description`, `model` (the alias `sonnet` is valid) and `permissionMode` frontmatter defines a sub-agent type; tools are inherited when `tools` is omitted; hooks in `.claude/settings.json` (the commit gate) fire for tool calls made inside sub-agents; sub-agents compact their own context. The docs do not say that an agent file created mid-session is picked up without a restart, nor how a background sub-agent's permission prompt reaches the user.

## Decision

**1. One orchestrator, one implementer per milestone.** The main session (Fable or Opus) lands milestones one after another in `PLAN.md` order. Per milestone it reads only the brief, never the brief's reading list; delegates the build; runs the acceptance gate (§3); records the result; goes on. Its context is spent on judgement across milestones: accepting work, ADR or Deviations note, keeping seams consistent. Implementation, research, review legwork, ADR drafting, fixes to later briefs and doc sweeps go to Sonnet sub-agents. The loop is owned by `PROMPT.md`.
- The cut is **one implementer per milestone**. The reading list is a fixed cost per implementer and a brief's steps share unwritten seams, so a cut per step would pay more and know less. A milestone is split across implementers only where its brief names a cut line or an implementer reports that it stopped for size; per-step commits make that resumable from the repo.
- Implementers run in the foreground, one at a time: there is one working tree, one cargo target directory and one set of test ports.
- "One session" in `PRE-PLAN.md` §8 and in any brief's self-split clause now reads "one implementer". `PRE-PLAN.md` stays as written (it is history); the sizing rule itself is unchanged.

**2. One custom sub-agent: `.claude/agents/milestone-implementer.md`, `model: sonnet`.** It owns the standing rules of an implementer (what to read, commit subjects, what it may edit, when to stop, the report format), so a delegation prompt is the brief path, an optional step range, and notes from earlier Deviations. Its entry point is that prompt, not `PROMPT.md`. If the type is not registered in a session, the orchestrator uses `general-purpose` with `model: sonnet` and tells it to read the agent file first. Every other delegation is `general-purpose` with `model: sonnet`; a second custom agent needs the 0021 §5 trigger and a new ADR. `scripts/lib/context-artifacts.test.mjs` checks each agent file's frontmatter.

**3. Single writers, and a gate between them.**
- Golden hashes: `pnpm golden`, and an implementer runs it only for fixtures its milestone creates. A changed existing golden or a weakened, skipped or deleted test is the orchestrator's decision.
- Exit-criteria checkboxes, a brief's `Status:` line, `PLAN.md` and `PROMPT.md`: the orchestrator, after the gate. The implementer reports evidence per criterion and writes only the Deviations section of its own brief.
- The gate is `pnpm gate <base>` (`scripts/gate.mjs`: git only, no build; tree clean, files changed, existing goldens changed, test-disabling markers added, diff size) followed by `pnpm test && pnpm lint` run by the orchestrator, then name checks with `grep` against the brief's Files touched, Tests added and Provides. A criterion that says "by hand" or "in this session" needs automated evidence or stays unticked on Tyler's list.

**4. Trunk only.** All work is committed on `main`; no branches. Implementers commit after each step (`M<NN> step k: …`), so `main` may be red between step commits. It is green at every `M<NN> done: …` commit, which the orchestrator makes after the gate; the last green commit is `git log --grep ' done:' -1`. The `PROMPT.md` status block is committed before delegating (`M<NN> start`, naming the base sha) and after accepting, so an interrupted milestone is resumable from `git log <base>..HEAD` and the brief's Deviations. Annotated tags mark phase ends and the `PLAN.md` marker rows, which own the tag names. Tags and pushes happen only at `done` commits, because CI (M10) runs on every push.

**5. The allowlist gains `Bash(git tag -a *)`.** Not `git tag *`, which would also allow `-d` and `-f`. `git push` stays outside the allowlist (0021 §7), so every push prompts Tyler.

## Alternatives rejected

- **A session per milestone (the Phase 2 plan).** Pays a top-model session and its start-up reading for every milestone, and nobody holds the thread across milestones; Tyler asked for the opposite.
- **Per-call `model: sonnet` on `general-purpose`, no agent file.** The standing rules would be retyped, and drift, in every delegation; this is the case 0021 §5 describes. Kept as the fallback only.
- **One implementer per step.** Each pays the reading list again and none sees the seams between steps.
- **Parallel implementers in worktrees.** Milestones are a dependency chain with few independent pairs; parallel cargo targets and browser suites would fight for the machine, and merges would cost the orchestrator the context the design is meant to save.
- **A branch per milestone.** Branches accumulate waiting for a merge that adds no review (the gate is the review), and every session first has to work out which branch contains which.
- **A tag per milestone.** About sixty tags carry no more than `git log --grep ' done:'`; tags are kept for the states worth returning to.

## Consequences

- An orchestrator that reads a reading-list file or writes milestone code is spending the context the design protects; `PROMPT.md` carries that rule. Its own fixes stay under about twenty lines in one file.
- An implementer's claim is never evidence. The cost is one `pnpm test && pnpm lint` per milestone in the orchestrator's session, which the quiet output contract of [0020](0020-testing-strategy.md) §2 keeps to a few lines.
- `main` can be red at a step commit. Anyone bisecting or branching starts from a `done` commit.
- Revisit §1's serial rule if two ready milestones ever share no crate, package or test port and wall-clock time matters more than orchestrator context. Revisit §2 if Sonnet implementers need a second fix round on more than about one milestone in three: raise the agent's model before adding process.
- `.claude/agents/` and `scripts/gate.mjs` are Phase 3 scaffolding; Phase 4 decides whether either stays.

## Sources

- Sub-agent files, frontmatter fields, model aliases, `permissionMode`, tool inheritance, hooks inside sub-agents, auto-compaction: https://code.claude.com/docs/en/sub-agents.md (checked 2026-09-19).
- Hook scope and `PreToolUse` behaviour: https://code.claude.com/docs/en/hooks-guide.md (checked 2026-09-19).
- Permission rule syntax (`Bash(git tag -a *)` has the same form as the entries of 0021 §7): https://code.claude.com/docs/en/permissions (checked 2026-09-19 for 0021).
- [0021](0021-context-architecture.md) §3, §5, §7, §8; `PRE-PLAN.md` §8 item 10; Tyler's instruction of 2026-09-19.
