# M39: Acceptance audit (Phase 3 exit)

Status: not started · After: all other milestones, including any `NNb`/`NNc` rows added during Phase 3 · Tyler-dependent: yes. Tyler runs the complete device checklist and gives the play-test sign-off; Q5 in `docs/plan/questions-for-tyler.md` (default assumed: iPhone plus desktop Chrome only; Android-phone rows are marked "not run: no device", never ticked).

Split note: the hand-off to Phase 4 (capturing non-inferable facts in ADRs, rewriting `PROMPT.md`) is `39b-phase-4-handoff.md`. The audit below fills a session by itself and can block on Tyler; the hand-off cannot start until it is green.

## Goal
Phase 3's "done when" (`docs/process.md`) is demonstrated, not asserted: every spec Requirement, every ADR decision and every reference-game feature points at a passing named test or a ticked device check; every PRE-PLAN §7 budget has a measured value; `PLAN.md` is fully ticked or its deviations are recorded; Tyler has run the whole device checklist and signed off. This milestone writes audit tables and small gap-closing tests only. No features.

## Read first
1. `docs/spec/overview.md`
2. `docs/process.md` ("Rules for every session": exit criteria are binding, who decides; "Phase 3": done when)
3. `PRE-PLAN.md` (§7 the budget table: every row is audited; §11 items awaiting Tyler: each must be answered in a spec file or carried forward)
4. `docs/decisions/0020-testing-strategy.md` (§3 suite budgets, §9 budgets file and baseline, §10 CI and the device checklist)

Plan files (do not count): `PLAN.md`, `docs/plan/device-checks.md`, `docs/plan/deferred-ledger.md`, `docs/plan/questions-for-tyler.md`, and the Phase 2 coverage map if one exists under `docs/plan/`. Sub-agents get their own reading lists (below). Rules that apply: none. Skills: `run-tests`.

## Scope
- **Green baseline first.** `pnpm test`, `pnpm lint`, `pnpm test:slow` on Tyler's Mac, and the latest CI run on the branch. Nothing else starts until these pass; a failure is fixed if it is a small regression, otherwise it is a plan edit and this milestone stops.
- **Coverage audit, delegated.** One sub-agent per unit, each briefed per 0021 §3 with `docs/spec/overview.md`, its one source file, and the instruction to write one table and return a ten-line summary:
  - per spec domain file (`world`, `simulation`, `sync`, `runtime-and-packaging`, `client`, `testing`, `reference-game`) and `overview.md`'s "Fixed decisions" and "Non-goals": one row per Requirement bullet;
  - ADRs in groups of about five (0001–0021 plus every ADR written in Phases 2–3): one row per numbered or bold-headed decision;
  - the reference-game feature-coverage list in 0003 Consequences and the scripted full-game tests of M34.
  Row format: `item · evidence (suite: "test name", or device check id, or "by construction" + the mechanical guard) · status`. Output: `docs/plan/acceptance/<unit>.md`. Allowed statuses: `covered`, `device`, `gap`, `not applicable (reason)`. "By construction" is accepted only with a guard that would fail if it stopped being true (a lint, the import allowlist, the exports-map test, a type).
- **Evidence check, mechanical.** `scripts/acceptance-check.mjs` reads the tables and fails if a cited test name is not found in the test tree, if a cited device check id is not ticked in `docs/plan/device-checks.md`, or if any row is `gap`. It reuses the test-name lookup of M37's `engine event surface` test.
- **Gap closing.** A `gap` whose fix is one small test on existing behaviour is fixed here (budget: about ten such tests). A gap that needs engine work becomes a new brief and `PLAN.md` row, and this milestone stays unticked until it lands.
- **Budget ledger.** `docs/plan/acceptance/budgets.md`: one row per PRE-PLAN §7 row (and per number inside a row where it holds several): owner ADR, measured value, where it was measured (test or counter name, `budgets.json` key, `packages/engine/baselines/*.json` entry, the M35 / M36b ADRs, or device check id), date, verdict `met / missed / manual / computed`. Rows that can only be manual (phone frame time, whole-tab memory on the phone, chunk generation on a phone) cite the device check. "Hosting cost" cites M38's result or is marked `computed` with the arithmetic's ADR. A `missed` row needs a decision: fix, or an ADR changing the number, or (if the number is a Requirement) a question to Tyler.
- **Deferred ledger closed.** Every row of `docs/plan/deferred-ledger.md` names a decision (ADR or brief section) or a ticked milestone whose Deviations or ADR answers its question. Check each; list the ones that are owned but unanswered.
- **`PLAN.md` audit.** Every row ticked; every brief's exit-criteria boxes ticked or its Deviations explains the difference; every Deviation that changed a decision has an ADR (process.md: no silent drift).
- **Device checklist, complete run.** Present Tyler with the consolidated `docs/plan/device-checks.md`: every entry from every **D** milestone, run again end to end on the final build (not only the entries that were never ticked), on the iPhone and, if available, the Android phone. It includes the entry M07 handed here: the standard large save (`?bench=large-save`, M36) on the iPhone in single-player for ten minutes with `engine_mem_grows() == 0` and no tab reload; if it fails, the question to answer is which default drops first (0007 §8: entities are the memory problem), by ADR. The last entry is the play-test sign-off: the reference game played start to furnace output in single-player and with a second player. Failures become plan edits.
- **Items awaiting Tyler.** Every question in `docs/plan/questions-for-tyler.md` and PRE-PLAN §11 is either answered and recorded in a spec Requirements section (Tyler's words only) or listed in one final batch with the default the code was built on.

## Non-scope
New features, refactors, performance work beyond a one-line fix. Writing architecture docs, deleting bootstrap files, touching `PROMPT.md`'s instructions or `CLAUDE.md`'s map (M39b and Phase 4). Editing spec Requirements except to record an answer Tyler gave.

## Files, packages and crates touched
`docs/plan/acceptance/*.md` (new), `scripts/acceptance-check.mjs` (new), test files for gap-closing tests in whichever package owns the behaviour (at most three packages; more means the gaps are not small), `PLAN.md` ticks, `docs/plan/device-checks.md` ticks.

## Seams
**Provides:** `docs/plan/acceptance/<unit>.md` coverage tables; `docs/plan/acceptance/budgets.md` (M39b turns it into a permanent ADR); `pnpm acceptance:check`; the list of unanswered Tyler items for M39b's Phase 4 prompt.
**Consumes:** every suite and skill; `budgets.json` (M04 onward); `packages/engine/baselines/*.json` (M17b, M36); the measured-numbers ADRs of M35 and M36b; `pnpm test:timings` (M36b); M37's test-name lookup (`engine event surface`); M38's hosting results and its "open" list if Tyler declined spend; `?bench=large-save` (M36); `docs/plan/device-checks.md` and its per-milestone ticks.

## Planning decisions
- **The audit's unit of evidence is a test name, not a file or a milestone.** Phase 2's coverage check mapped Requirements to milestones; that proves intent. Here each row must cite something a command can find and run, so the tables stay useful to Phase 4 when it folds the spec into `docs/architecture/`.
- **Re-run, don't trust ticks.** Device entries ticked months earlier against an older build are re-run once on the final build, because risk 1 of PRE-PLAN §9 (real-iPhone behaviour) is the top-ranked risk and the final build is the only one that matters.
- **Where the results live.** Under `docs/plan/acceptance/`, which Phase 4 deletes with the rest of `docs/plan/`. That is deliberate: the coverage tables are evidence for a gate, not living documentation. The one part with lasting value, the measured budgets, is moved into an ADR by M39b.
- **Blocking on Tyler is expected.** If the automated parts are green and only the device run or sign-off is outstanding, write exactly that into the `PROMPT.md` status block, commit, and end the session (process.md). The next session resumes at "Device checklist".

## Order of work
1. Green baseline. 2. Launch the coverage sub-agents in parallel; meanwhile build `acceptance-check.mjs`. 3. Budget ledger. 4. Deferred ledger and `PLAN.md` audit. 5. Close small gaps; open briefs for large ones. 6. Hand Tyler the device checklist and the final question batch; stop if waiting. 7. On Tyler's results: tick or open plan edits; re-run `pnpm acceptance:check`; tick this milestone.

## Tests added
Only gap-closing tests, each named in the coverage table row it closes. `acceptance-check.mjs` has one unit test (a fixture table with a missing test name fails).

## Exit criteria
- [ ] `pnpm test`, `pnpm lint` and `pnpm test:slow` pass on Tyler's Mac; the fast tier is inside the Requirement's one minute (number recorded in the ledger); the branch's latest CI run is green.
- [ ] `pnpm acceptance:check` passes: no `gap` rows, every cited test found, every cited device check ticked.
- [ ] `docs/plan/acceptance/budgets.md` has a verdict for every PRE-PLAN §7 row; no `missed` row lacks a decision.
- [ ] Every row of `docs/plan/deferred-ledger.md` is closed; every `PLAN.md` row is ticked or has a recorded deviation with an ADR where a decision changed.
- [ ] `docs/plan/device-checks.md`: every entry re-run on the final build and ticked (or failed with a linked plan edit that has since landed), including Tyler's play-test sign-off, with device model, OS version and date.
- [ ] The final batch of open Tyler items (possibly empty) is written for M39b.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm lint` · `pnpm test:slow` · `pnpm acceptance:check` · `pnpm test:timings` (M36b) · `gh run list --branch <phase-3 branch> --limit 1`

## Budgets
All rows of PRE-PLAN §7. This milestone measures nothing new except by re-running existing commands; it records where each number came from in the budget ledger.

## Context artifacts
None created. The `run-tests` skill gains one line for `pnpm acceptance:check` only if Phase 4 will keep the script; otherwise nothing (M39b decides).

## Manual device checks
The whole of `docs/plan/device-checks.md`, re-run on the final build. [device-checks.md, M39: Acceptance](device-checks.md#m39-acceptance) holds the re-run item, M39-large-save, and the play-test sign-off (its last item, owned by this milestone).

## Deviations
(filled in during Phase 3)
