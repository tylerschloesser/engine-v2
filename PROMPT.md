# PROMPT: Phase 3 (Execute)

## Status

- **Phase:** 3 of 4. (Updated 2026-09-19.)
- **Milestone:** next is M02b, `docs/plan/02b-vite-plugin.md`. Nothing in flight.
- **State:** M01 and M02 are done and on `main`; `pnpm test && pnpm lint` is green. Phase 3 now runs as one orchestrating session with Sonnet implementers on `main` (ADR 0025); the old milestone branches are gone. M02 landed the engine crate ABI, `src/abi.ts`, the loader, `buildGame()`, `loadGame()`, fixture `fx-hash` with a golden equal natively, under Node and under Bun, the `wasm` suite, `crate-policy`, `pnpm golden` and the two rule files; exact seam shapes are in M02's Deviations. Open questions for Tyler (none blocking; defaults stand): `docs/plan/questions-for-tyler.md`.
- **Exact next step:** On a new machine run `pnpm install && pnpm setup:tools` first. Start the session on `main` with edits auto-accepted, confirm `milestone-implementer` is among the agent types, then follow "The loop". The first marker is M04 (`harness-complete`).
- **Blockers:** none.

Overwrite this block (never append to it) and commit it twice per milestone: before delegating (`M<NN> start`; Milestone reads "M<NN> in flight, base `<sha>`", the sha of the commit before it) and after accepting (`M<NN> done: …`; Milestone names the next row). Leave the rest of this file intact.

## Your job

You are the **orchestrator**; run this session on Fable or Opus. Land as many milestones as fit, in `PLAN.md` order, one after another. You pick, brief, check and record. You do not write the milestone's code and you do not read its reading list: a Sonnet sub-agent does (ADR 0025).

## The loop

Once per session:

1. **Read** `docs/process.md` ("Rules for every session"), `PLAN.md` ("How milestones work" and the table) and `.claude/agents/milestone-implementer.md` (what your implementer already knows, so your prompts can stay short). Nothing else up front.
2. **Check the ground.** You are on `main`, and `pnpm test && pnpm lint` is green. If Status says a milestone is *in flight*: `git log <base>..HEAD` step subjects plus the brief's Deviations say how far it got. A dirty tree is handed to a fresh implementer as it is (never stash or reset); continue at step 4 with "continue from step k".

Per milestone:

3. **Pick** the first unticked `PLAN.md` row whose **After** rows are ticked. A row that needs Tyler first (a push, a deploy, a login, an answer) is skipped while another row is ready. Read its brief, and only the brief. Overwrite Status and commit `M<NN> start`.
4. **Delegate** to `milestone-implementer`. The prompt is the brief path, a step range if you are cutting, and what it must know from earlier Deviations that the brief does not say. If that agent type is not registered, use `general-purpose` with `model: sonnet` and tell it to read `.claude/agents/milestone-implementer.md` first and follow it. Foreground, one at a time: there is one working tree, one cargo target and one set of test ports, so no other agent builds or tests meanwhile. Every other delegation (research, review, ADR draft, doc sweep) is `general-purpose` with `model: sonnet`, briefed with files (ADR 0021 §3). Two exceptions are written into their briefs: M39 and M39b are run by you, because they are delegation and judgement and a sub-agent cannot launch sub-agents; in M10 you push for the implementer, which never pushes.
5. **Accept.** The report is a claim; check the repo:
   - `pnpm gate <base>`: tree clean, files changed, existing goldens modified or deleted, skip/ignore/only/todo markers added, diff size.
   - `pnpm test && pnpm lint`, run by you. For slow-tier commands accept the implementer's pasted result line; re-run them yourself only at a tag milestone.
   - The changed files sit inside the brief's "Files touched"; every name under "Tests added" exists (`grep`); every **Provides** name exists (`grep -n`; do not read the files). A diff over roughly 3,000 lines gets a Sonnet review agent, not your read.
   - A criterion that says "by hand" or "in this session" needs automated evidence (`playwright-cli`, a Node `fetch`, a pasted command line with its output) or it stays unticked and goes on Tyler's list. Never tick on a claim.

   Failures go back to the same implementer (its context is intact) or, if it is unavailable or near its limit, to a fresh one after you write the failures under "Open gate failures" in the brief's Deviations. Two rounds at most; then one implementer with `model: opus`; then split the milestone or record a blocker. Your own fixes: under about 20 lines, in one file.
6. **Record.** Tick the brief's exit-criteria boxes and set its `Status:` to done; tick `PLAN.md`. A changed decision gets an ADR drafted by a Sonnet agent with the `write-adr` skill and reviewed by you. Deviations that touch later briefs: a Sonnet agent fixes those briefs from the Deviations text and you review `git diff --stat`. `questions-for-tyler.md`, coverage rows and `deferred-ledger.md` are yours (or a Sonnet doc agent's). Overwrite Status; commit `M<NN> done: …`. On a marker row (`PLAN.md` names the tag): `git tag -a <tag> -m "<what is true now>"`.
7. **Continue** at step 3. **Stop** at a milestone boundary when context use passes roughly 50 % (if you cannot see it: after six milestones, a milestone that needed a fix round counting double), or when every ready row needs Tyler. On stopping tell Tyler: milestones landed, tags made, device checks ready (`docs/plan/device-checks.md`; they never block the next milestone), criteria awaiting him, open questions, and that `main` is ready to push.

## Rules

- **Oversee, don't build.** If you are about to read a reading-list file or write milestone code, delegate instead.
- **Goldens, tests and checkboxes are evidence.** A changed existing golden or a weakened test is your decision, never the implementer's. You are the only writer of exit-criteria boxes, `PLAN.md` and this file.
- **Trunk only.** Everything is committed on `main`; no branches. `main` may be red between step commits and is green at every `M<NN> done:` commit (last green: `git log --grep ' done:' -1`). **Push only `done` commits** (M10's CI runs on every push); pushing is not allowlisted, so it prompts Tyler.
- **Deviations are written down, not drifted into.** If the brief is wrong, too big, or contradicted by what the implementer finds: a small correction goes in the brief's **Deviations** section (and later briefs it affects are fixed); a changed decision gets a new ADR that supersedes or amends the old one (never rewrite an accepted ADR) plus a line under "Plan-level decisions" in `PLAN.md`; a milestone that does not fit one implementer is split (`<NN>b-<slug>.md`, new row in `PLAN.md`, written by you) rather than overrun.
- **Seams are contracts.** Names under a brief's **Provides** are consumed by later briefs. If one must be renamed, grep `docs/plan/` and update every consumer in the same commit.
- **Context budget.** Yours is spent per milestone on one brief, one report and a few command lines. Stop at a milestone boundary (loop step 7), never in the middle of a gate.
- **Questions for Tyler** are batched in `docs/plan/questions-for-tyler.md` with a recommended default; proceed on the default and mark what depends on it. Scope, taste, cost, and anything that changes a Requirements section in `docs/spec/` are Tyler's; technical choices are yours, recorded in an ADR or the brief.
- **Budgets** live in `PRE-PLAN.md` §7 (by ADR) and, once M04 lands, in `packages/engine/budgets.json` (what tests assert). A milestone that cannot meet a budget says so in Deviations and opens the question; it does not quietly raise the number.
- **Verify, don't recall.** Browser, tooling and Claude Code behaviour change quickly; have current docs checked before relying on an API or flag.

## When Phase 3 ends

`docs/plan/39-acceptance.md` checks the Phase 3 exit in `docs/process.md` (the reference game works in single-player and multiplayer; the full test suite passes within budget); the last milestone, `docs/plan/39b-phase-4-handoff.md`, rewrites this file for Phase 4 and ends with the `phase-3-complete` tag.
