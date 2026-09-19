# PROMPT: Phase 2 (Plan)

## Status

- **Phase:** 2 of 4, not started. (Updated 2026-09-19.)
- **State:** Phase 1 is complete. Every open question in `docs/spec/` is resolved by an ADR in `docs/decisions/` (0001–0021) or deferred with a reason in `PRE-PLAN.md`. Five feasibility spikes ran; results are in `spikes/<name>/RESULT.md`. There is no engine code yet.
- **Branch:** Phase 1 was done on `phase-1-pre-plan`. If Tyler has merged it, branch `phase-2-plan` from `main`; otherwise branch from `phase-1-pre-plan`. Never commit to `main` directly.
- **Next step:** Begin at "What to do" below.

If you stop early (context budget, blocker), update this Status block with the current state and exact next steps, commit, and end. Leave the rest of this file intact.

## Your job

Turn `PRE-PLAN.md` and the ADRs into `PLAN.md`: exactly how to write, test, and verify the engine and the reference game, as milestones that each fit in one Claude Code session. By the end of this session a fresh session pointed at `PROMPT.md` can start executing milestone 1 with nothing else explained.

You are not writing engine code in this phase, and you are not reopening decisions. If planning exposes a real flaw in an ADR, supersede it with a new ADR (don't rewrite the old one) and say so in `PLAN.md`.

## Read first

1. `docs/process.md`: the phases and the rules every session follows. Its Phase 2 section lists what each milestone must contain.
2. `docs/spec/overview.md`: the goal, the engine/game split, fixed decisions, non-goals.
3. `PRE-PLAN.md`, all of it: architecture, layout, API and protocol sketches, testing strategy, budgets, ordering constraints, risks, the deferred-unknowns table, and the items awaiting Tyler.
4. `docs/context-architecture.md` and `docs/decisions/0021-context-architecture.md`: how plan files, nested `CLAUDE.md`, `.claude/rules/`, skills, the commit hook, and the permission allowlist are laid out and when each gets created.

Read an ADR or spec domain file when you plan the milestone that touches it, not up front; delegate per-subsystem planning to sub-agents briefed with `docs/spec/overview.md`, the relevant section of `PRE-PLAN.md`, and the one to three ADRs involved. `docs/research/` is evidence behind the ADRs; consult it only when an ADR's reasoning is unclear. `spikes/` is throwaway code: mine it for working snippets (the GC assertion harness, the Vite plugin, the SAB ring, the `WorldRead`/`WorldWrite` overlay), don't build on it in place.

## What to do

1. **Settle the deferred unknowns.** Go through the "deferred to Phase 2" table in `PRE-PLAN.md`. For each item either decide it now (new ADR, or an amendment section in a plan file if it is too small for one), or assign it to a named milestone with the question it must answer. Nothing stays unowned.
2. **Check the items awaiting Tyler** in `PRE-PLAN.md`. Anything still unanswered goes into one batch of questions, with a recommended default each, together with any new scope, taste, or cost question planning raises. Ask once, then keep planning on the recommended defaults without waiting; mark every milestone that depends on an unanswered item. Record answers in the spec Requirements when they arrive.
3. **Cut milestones.** Each fits one session, leaves the repo green, and lands something verifiable. Sizing heuristic for "one session": one new subsystem or one vertical cut through existing ones; at most three packages or crates touched; a reading list of `overview.md` plus at most three files; roughly 1,500 lines of new code and tests or fewer; verification that runs in minutes. Split anything bigger. Order them so the thin vertical slice in `docs/process.md` (chunked world on screen, camera input, sim in a worker, one action round trip, tests green) lands as early as possible, and so the test harness, including the zero-allocation assertion (ADR 0016) and the cross-runtime determinism hash (ADRs 0002, 0020), is an early milestone. Respect the ordering constraints in `PRE-PLAN.md`.
4. **Write each milestone brief** with: scope and explicit non-scope; files, packages, and crates touched; the spec and ADR files to read (at most overview + three); exit criteria; the exact commands that verify them; which budgets from `PRE-PLAN.md` it must meet and how that is measured; which skills, rules files, or nested `CLAUDE.md` files it creates per ADR 0021.
5. **Plan the first two milestones in the most detail**, following the ordering constraints in `PRE-PLAN.md`: first the repo scaffolding (pnpm and cargo workspaces, the toolchain pins in ADR 0017, format and lint, the `.claude/settings.json` allowlist and commit hook per ADR 0021, and a skeleton `pnpm test` entrypoint with its quiet-on-success output contract), then the real test harness (the zero-allocation assertion and the cross-runtime determinism hash). CI arrives with the first GPU test.
6. **Schedule the manual device checks** (real iPhone: determinism hash, terrain fill-rate, memory ceiling, DOM anchoring) as Tyler-run checklists attached to the milestones that make them possible.
7. **Split the plan if it is long.** If `PLAN.md` outgrows one comfortable read, make it an index (ordering, dependencies, progress checkboxes) and put one brief per milestone in `docs/plan/<NN>-<slug>.md`, per `docs/context-architecture.md`.
8. **Draft the Phase 3 `PROMPT.md`** per `docs/process.md` (in a scratch file; don't overwrite this one yet): a status block naming the current milestone, the loop each session follows (read the milestone brief, implement, verify, tick it off in `PLAN.md`, update the status block, commit), and the rule that deviations get an ADR or a plan edit.
9. **Verify the plan.** Have a sub-agent read only the drafted Phase 3 prompt and what it links to for milestone 1, then list what it would still need to know to start coding. Fix what it finds. Have a second sub-agent check coverage: every Requirement in `docs/spec/`, every ADR decision, and every reference-game feature maps to at least one milestone's exit criteria.
10. **Hand off.** Replace this file with the Phase 3 prompt. Update `CLAUDE.md`'s map. Commit.

## Exit criteria

- [ ] Every item in `PRE-PLAN.md`'s deferred table is decided or owned by a named milestone.
- [ ] Every milestone has scope, files touched, reading list, exit criteria, and exact verification commands, and meets the sizing heuristic in step 3.
- [ ] The vertical slice and the test harness (zero-allocation and determinism assertions included) land within the first few milestones.
- [ ] The coverage check passes: every spec Requirement, ADR decision, and reference-game feature maps to a milestone.
- [ ] The fresh-session check passes for milestone 1.
- [ ] Tyler has been asked the batched questions once. Answers received are recorded in the spec; milestones that depend on unanswered items are marked and planned on the recommended default.
- [ ] `PROMPT.md` is rewritten for Phase 3, `CLAUDE.md`'s map is accurate, and everything is committed.
