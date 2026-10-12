# PROMPT: Build belts

## Your job

You are the manager session for the belts effort: one long-running Opus or Fable session that reads briefs, delegates or does the work, reviews, gates, commits and pushes, and revises the plan from measurements. The plan is `PLAN.md`; one brief per milestone is in `docs/plan/`; the decisions are ADRs [0076](docs/decisions/0076-transport-lines-engine-game-split.md) (the engine/game split), [0077](docs/decisions/0077-transport-item-representation.md) (item representation, Accepted in M40: B1 runs) and [0078](docs/decisions/0078-transport-forecast-replication.md) (forecasts, Accepted in M41 as revised by its Amendment); the requirements are Tyler's in `games/reference/README.md` "Belts" and `docs/architecture/README.md`. Nothing that exists only in this conversation is relied on: it is written to a brief, a Deviations section, an ADR or a doc first. A fresh session on any machine continues from this file alone.

## Read first, in this order

1. `CLAUDE.md` (the map, the commands, the invariants and their rule files, the machine notes).
2. `docs/architecture/README.md`, then `simulation.md`, `sync-and-netcode.md`, `renderer.md` (the subsystems belts touch).
3. `docs/decisions/0069-working-rules-learned-in-phase-3.md` (every section applies to every milestone), `0021` §3 (how to brief a sub-agent), `0076`, `0077`, `0078`.
4. `PLAN.md` (the table, the sizing rule, how the plan is revised), `docs/plan/README.md` (the brief format), then the current milestone's brief and its reading list.
5. The status block below.

## The loop, per milestone

1. **Pick** the first unticked row of `PLAN.md` whose `After` rows are ticked. Skip a row that waits on Tyler while another is ready.
2. **Fill the brief** if it is a later-phase sketch: at the start of each phase, rewrite that phase's briefs to the full template from the earlier phases' Deviations and ADR amendments; commit the plan revision before starting the first milestone of the phase.
3. **Read** the brief and its reading list yourself, even when delegating.
4. **Do or delegate** (rules below). A delegated implementer reads the brief, writes code and tests, fills Deviations with evidence per exit criterion, and reports in the size the brief asks.
5. **Gate.** Run every verification command in the brief; `pnpm test` and `pnpm lint` green (lint alone when test is red for another reason: 0069 §13); each new test has its inject-fail-revert recorded (0069 §1); grep the diff for timeouts, retries, widened budgets, reduced workloads (0069 §8); a budget the milestone cannot meet is a question to Tyler, never a quiet raise (0069 §7).
6. **Review.** Adversarial review of the milestone's diff: the `code-review` skill at `high`, or a reviewer sub-agent (`general-purpose`, `model: opus`) briefed with the brief, ADR 0069 and the diff range; every finding is fixed or recorded in Deviations before the next milestone starts.
7. **Record.** Tick the exit criteria in the brief and the row in `PLAN.md`; a decision that moved goes to an ADR the same day (`write-adr`); a doc a commit made wrong is fixed in that commit; a measurement that changes a later brief edits it now (`PLAN.md`, "How this plan is revised").
8. **Commit and push.** Early and often, on `main`, no branches; `pnpm format` before the commit gate; push every green commit yourself and never ask. At a phase end: `pnpm test:slow` green, the annotated tag from `PLAN.md`, pushed.
9. **CI.** Do not block on it; between milestones run `gh run list --branch main --limit 1` and read a red run (`gh run download`) before starting the next row; a CI-only red gets its base rate before it is charged to a change (0069 §10).
10. **Update the status block** below (overwrite, never append), then commit it with the milestone.

## Delegation and review rules

- The manager keeps design decisions, plan edits, ADRs, gates, reviews, commits and anything touching `games/reference/README.md`.
- Complex implementation (a milestone's Rust core, a wire section, a replica path, a renderer path) goes to `general-purpose` sub-agents with `model: opus`; mechanical work (tables, generated constants, asset scripts, doc edits, test scaffolds, a text-map builder) to `sonnet` or `haiku`. Research-only work (reading code to answer a question, a profile read, a base-rate measurement) goes to `Explore` or `Plan` agents, which have no write tools (0069 §16); they load no `CLAUDE.md`, so their brief restates the invariants they need.
- A brief to a sub-agent is files, not conversation (0021 §3): the goal, the milestone brief path, the exact files to read (at most the brief's reading list plus the rule files that apply), the file to write to, the size of the report. Expect the report, not file dumps.
- One sub-agent per milestone by default; parallel sub-agents only for independent files, never two writers in one crate at once.
- Every sub-agent report's "green" is a claim: rerun the brief's verification commands yourself before the gate.

## Tyler

- Trivial decisions are yours. Non-trivial ones (scope, taste, cost, a rule line marked **(assumed)** in `games/reference/README.md` "Belts", a changed default quoted in `docs/architecture/README.md`, a budget you cannot meet) are batched, asked early with a recommended default, and the work proceeds on the default meanwhile (the row is marked **T** in `PLAN.md`). Record each answer as a dated line in the README section and clear the mark.
- Never hand him an untested step: run every URL, command, page and phone round end to end first. His machine's aliases (`command cp -f`, `command mv -f`, `command rm -f`), the Pixel's PIN (never put it to sleep), the iPhone's Low Power rule, and "not during his live round" apply (memory notes in `CLAUDE.md`'s machine line and `.claude/skills/device-check/SKILL.md`).
- Scope, taste and cost are his; technical questions are yours, decided and recorded with `write-adr`.

## Status

- **Current milestone:** M48 done (`docs/plan/48-transport-prediction-join-and-edits.md`, the engine half); M48b (`48b-replication-scenarios-and-join.md`, the netcode half, tag `belts-replicated`) is next.
- **State:** M40-M48 done (2026-10-12). Core complete and benchmarked (tag `belts-core-complete`); structures and forecasts replicate (sections 12 and 13; 0078 A8-A9, 0079 §17-§19), measured live (3,958 B/s on the gated saturated cell); the engine half of robustness is in (0079 §20): a restored host re-declares its spawners through `Game::declare_spawners`, a chunk's version moves only for what a replica can see (the `O = 200` workaround is gone), a lost frame re-snapshots the held chunks it changed (0 desyncs over lossy windows), `take_bundle` never panics, the frame hold is sized from `Tx`. `ABI_VERSION` 43. `belts-tick` baseline 1.2638 ms, gate green (M48's tree and the pre-M48 commit read 1.27-1.28 under the same conditions).
- **Exact next step:** delegate M48b to one `general-purpose` sub-agent (`model: opus`) briefed from `48b-replication-scenarios-and-join.md` (its Read-first list; M47b's `arbitrate()`/`measure()` and M48's Deviations; `scratchpad/m48-research.md` §8 for the harness knobs); adversarial review, gate (three `slow_tick_belts_large` runs at quiet load, `pnpm test:slow netcode`), commit, push, tag `belts-replicated`; then M49.
- **Blockers:** none. Open with Tyler (batched in the session messages of 2026-10-11, defaults proceeding): the six **(assumed)** rule lines plus the client-side spawner replay (`games/reference/README.md` "Belts"); told: old saves refuse to load (0079 §6); belts are opt-in (0079 §5); a host reserves 21.2 MB and a replica 17.5 MB at the recommended caps, and the phone pair is 12,288 lines / 98,304 items under 8 MiB (0078 A8); a loop with a splitter still spreads at its cut until M56 (0079 §11). Technical, open: 0079 §16's per-merge cursor (M56); mixed-speed junctions cost a list a tick (0078 A8); an entity moving twice in a tick over-stamps its chunk on the host (0079 §20 (b), M51 checks the reference entities); the reference game's spawners must not write an entity per insert (0079 §19 (e), M53); sections 12 and 13 under production pacing and the late-join cost (M48b). Machine: gate full runs only when the 1-min load is under 4 and the 5-min under 5 (the run-tests skill); other sessions drove it to 16-27 on 2026-10-12.

## Exit criteria of the whole effort

- [ ] Every row of `PLAN.md` is ticked; every brief's exit criteria are ticked with evidence in Deviations.
- [ ] 0077 and 0078 are Accepted with their measured amendments; a belts decisions ADR holds every decision the Deviations made that no ADR holds; no **(assumed)** line is left unasked in `games/reference/README.md` "Belts".
- [ ] The budgets of 0076 Consequences are rows or baselines that can trip and are green: the tick at 50,000 tiles and 250,000 items at most 5 ms on the baseline machine; `transport.downBytesPerSec` at most 16,384 with a saturated viewport; the dense viewport under the frame proxies; zero allocation per tick and per frame on the belt pages.
- [ ] The belts goldens hold natively, under Node and Bun, and in Chromium, WebKit and Firefox; the iPhone 12 run is recorded by ADR.
- [ ] `docs/architecture/transport.md` exists and every architecture doc, nested `CLAUDE.md` and rule is current; `PLAN.md`, `docs/plan/` and this file are deleted in the last commit; tag `belts-complete` is on a pushed, CI-green commit.
