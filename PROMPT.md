# PROMPT: Phase 3 (Execute)

## Status

- **Phase:** 3 of 4. (Updated 2026-09-19.)
- **Current milestone:** M01, `docs/plan/01-scaffolding.md`. Not started.
- **State:** Phase 2 is complete: `PLAN.md` indexes 60 milestones in execution order, one brief each in `docs/plan/`. There is no engine code yet. Open questions for Tyler (none blocking; defaults stand): `docs/plan/questions-for-tyler.md`.
- **Exact next step:** Branch `m01-scaffolding` from the newest of `main` and `phase-2-plan` (the plan lives on `phase-2-plan` until Tyler merges it; `git merge-base --is-ancestor phase-2-plan main` succeeds once he has), then follow "The loop" below.
- **Blockers:** none.

Overwrite this block (never append to it) whenever you stop: current milestone, state, exact next step, blockers. Leave the rest of this file intact.

## Your job

Execute **one milestone** this session: the one named in the Status block. Implement it, verify it, tick it off, hand off. Then end the session; the next milestone gets a fresh one.

## The loop

1. **Read** `docs/process.md` ("Rules for every session"), the "How milestones work" section and table of `PLAN.md`, then the milestone brief named above, then the files in its **Read first** list, and nothing else up front. `PRE-PLAN.md` is the architecture overview with the ADR index and the budgets table: open it only when the brief sends you there. An ADR's Status line may say "Amended by 0024 §n": the brief already reflects the amendment, so open 0024 only if the brief cites it. Before creating files in a directory, read its `CLAUDE.md` and the `.claude/rules/` files the brief lists (they load on read, not on write).
2. **Branch** `m<NN>-<slug>` from whichever of `main` and the previous milestone's branch contains the other (Tyler merges when he chooses; the newest work may not be on `main` yet). Never commit to `main`.
3. **Check the ground.** Every milestone in the brief's **After** list is ticked in `PLAN.md`, and `pnpm test && pnpm lint` is green before you change anything (M01 excepted: the commands do not exist yet). If not, stop and fix that first, or record the blocker.
4. **Implement** in the brief's **Order of work**. Stay inside **Scope**; **Non-scope** belongs to another milestone even when it looks easy. Use sub-agents for research, exploration and verification, briefed with the milestone brief plus one or two files (ADR 0021 §3). Commit early and often.
5. **Write the context artifacts** the brief lists (skills, rule files, nested `CLAUDE.md`), now that the procedure is real (ADR 0021 §4). They are exit criteria too.
6. **Verify.** Run every command under **Verification commands** and tick each **Exit criteria** box in the brief only after seeing it pass. Exit criteria are binding: do not tick what you did not verify, and report honestly what is not met.
7. **Hand off.** Set the brief's `Status:` to done and tick the milestone in `PLAN.md`. If the brief has manual device checks, tell Tyler they are ready (they are listed in `docs/plan/device-checks.md`; they never block the next milestone). Overwrite the Status block above for the next unticked milestone whose **After** list is satisfied. Commit. End the session.

## Rules

- **Deviations are written down, not drifted into.** If the brief is wrong, too big, or contradicted by what you find: a small correction goes in the brief's **Deviations** section (and fix any later brief it affects); a changed decision gets a new ADR that supersedes the old one (`write-adr` skill, which M01 creates; until then the existing ADRs are the template; never rewrite an accepted ADR) plus a line under "Plan-level decisions" in `PLAN.md`; a milestone that does not fit one session is split (`<NN>b-<slug>.md`, new row in `PLAN.md`) rather than overrun.
- **Seams are contracts.** Names under a brief's **Provides** are consumed by later briefs. If you must rename one, grep `docs/plan/` and update every consumer in the same commit.
- **Context budget.** If context use passes roughly 50 %, stop: commit work in progress, overwrite the Status block with the state and the exact next step, end the session.
- **Questions for Tyler** are batched in `docs/plan/questions-for-tyler.md` with a recommended default; proceed on the default and mark what depends on it. Scope, taste, cost, and anything that changes a Requirements section in `docs/spec/` are Tyler's; technical choices are yours, recorded in an ADR or the brief.
- **Budgets** live in `PRE-PLAN.md` §7 (by ADR) and, once M04 lands, in `packages/engine/budgets.json` (what tests assert). A milestone that cannot meet a budget says so in Deviations and opens the question; it does not quietly raise the number.
- **Verify, don't recall.** Browser, tooling and Claude Code behaviour change quickly; check current docs before relying on an API or flag.

## When Phase 3 ends

`docs/plan/39-acceptance.md` checks the Phase 3 exit in `docs/process.md` (the reference game works in single-player and multiplayer; the full test suite passes within budget); the last milestone, `docs/plan/39b-phase-4-handoff.md`, rewrites this file for Phase 4.
