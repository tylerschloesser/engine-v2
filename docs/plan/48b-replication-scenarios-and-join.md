# M48b: Replication scenarios, late join and the phase tag

Status: not started · After: 48 · Tyler-dependent: no (a changed default view would be his: asked only if the join measurement needs it)

Split from `48-transport-prediction-join-and-edits.md` on 2026-10-12 (sizing rule, as M42-M44 and M47): the netcode half. Phase end: tag `belts-replicated`.

## Goal
Replication is proved through real frames on the cases production meets: a predicted placement never touches a line, edits during flow arrive with their forecasts, a degraded client follows exactly from bundled frames, a reconnect re-holds its view, the late-join cost at scale is measured, and the bytes row's cell is measured under production chunk pacing.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (A8, A9, §6, Consequences: the late-join cost) and `docs/decisions/0079-transport-core-decisions.md` (§17 (f): `Predicting` reads are `Unknown`; §19)
3. `docs/plan/48-transport-prediction-join-and-edits.md` Deviations (what the engine half built) and `docs/plan/47b-forecast-scenarios-and-budget.md` Deviations (the arbiter, `measure()`, the pins rule)
4. `docs/architecture/sync-and-netcode.md` ("Prediction and reconciliation", "Sessions", "Rates"), `packages/engine/tests/netcode/CLAUDE.md`
Rules that apply: `.claude/rules/prediction.md`, `.claude/rules/hot-paths.md`. Skills: `run-tests`.

## Scope
- **Prediction.** `Predicting` already answers `Unknown` to every `TransportRead` method and `transport_mut` (0079 §17 (f), `transport_predicting_is_unknown`); what is missing is a game action that reads a line in `apply` and a scenario through the harness. `fx-belts` gains `Action::Probe { tile }` whose `apply` reads `lines_at` (so it is `NotPredictable`) and spawns a `Request` the host executes; `belts/predicted_request_is_not_predictable` (netcode, `HeadlessClient.dispatch` and the action result): the prediction status is `NotPredictable`, the host applies it, the line appears with its list, no desync. No fixture page: `fx-belts` draws nothing (M49 adds `extract`).
- **Edits during flow.** `belts/edit_during_flow_converges`: cut, join, extend, shrink, rescale, destroy and speed change on a saturated 1/64 `SaturatedView` world through `dispatch({ Request })`, hash-all, the arbiter of M47b comparing items every tick (reuse `arbitrate()`; move it to `tests/netcode/support.ts` or `src/test/`), every count pinned; the brief's Rust pins `build_frame_orders_structures_before_forecasts` and `surgery_marks_forecast_dirty` only if no M47 test already pins them (check `tests/main/forecasts.rs` first and say which).
- **Degrade through the harness.** `belts/degraded_client_follows`: a soft cap (`bandwidth.softCapBytesPerS`) or a `link(0).stall` forces level 2 and 4 on a 1/64 world; frames are held whole and bundled (M48 `host_degraded_bundles_carry_forecasts` is the Rust twin), so the scenario asserts items exact on every held line at every delivered frame, `degradeLevel` reaching 2 and 4 and recovering, `forecastSeenLate` recorded.
- **Reconnect.** The engine re-puts every structure on a reconnect (the client clears structures at every `Welcome`; `LineRoute` is per connection), and the hint keeps chunks only. `belts/reconnect_reputs_structures`: `link(0).disconnect(); reconnect(); settle()` on a held 1/64 world: `ChunkKeeps` present, every held line put again with its list within k frames (pin k), items exact once re-held, `forecastSeenLate` 0 after; record the reconnect's section 12 + 13 bytes in Deviations.
- **Late join at scale.** `belts/join_at_scale @slow` on M45's full `Mixed` world (`beltsBenchWorld('Mixed', 1, caps)`, default pacing): a client joins with the 256 x 144 view at the densest spot; bytes and virtual seconds until every structure and list of the view is held through the 48 KB/s chunk bucket; recorded in Deviations and 0078's Consequences. Over 10 s: a compact structure encoding is built here; a smaller default view is Tyler's.
- **Paced bytes.** `belts/saturated_view_paced_bytes @slow`: the (20 %, 100) cell of M47b's `measure()` with the default caps (0079 §19 (e)): what degrade and chunk collapses add to sections 12 and 13, whether a collapse re-puts lists; recorded in the row's `source`, pinned.
- Tag `belts-replicated` on the pushed commit; `docs/architecture/sync-and-netcode.md` sentences (prediction: transport reads; sessions: reconnect re-puts; rates: degrade bundles).

## Non-scope
- Engine changes beyond what a scenario proves missing (then a finding to the manager, not a fix here). Drawing (M49), the reference game (M51), phones (M57).

## Files, packages and crates touched
- `packages/engine/tests/netcode/` (`belts-*.test.ts`, `support.ts`, `CLAUDE.md`), `packages/engine/src/test/` (helpers), `packages/engine/fixtures/belts/src/lib.rs` (`Action::Probe`, appended last: no encoded action moves), `fixtures/belts/CLAUDE.md`, `budgets.json` (the row's `source`), `docs/architecture/sync-and-netcode.md`, `docs/decisions/0078-*.md` Consequences (the join figure; manager).

## Seams
**Provides:** the scenarios (M56 reuses `edit_during_flow_converges`), the join and reconnect figures, the tag. **Consumes:** M48's hooks and rules, M47b's `arbitrate()`, `measure()`, `beltsBenchWorld`, `forecastCounters`, `lineItems`, `hostLineItems`; the harness's `link(i).stall/set/disconnect/reconnect`, `counters(i).degradeLevel|sections`.

## Planning decisions
- **Reconnect re-puts structures; the hint keeps chunks, not lines.** A kept chunk saves its snapshot; its lines are put again with their lists, budgeted over frames. Keeping structures across a `Welcome` would need per-line versions in the hint; not built unless the measured reconnect cost says so (then a decision for M57's phone measurement).
- **The harness cannot lose a frame** (the conditioner turns loss into a stall), so overflow stays a Rust `Loopback` matter (M47, M48); no frame-drop knob is added unless a scenario here needs one.
- **Every measured count is pinned exactly** (M47b's rule); a moved pin is a finding.
- **The join cost is measured before any encoding work** (expected under 10 s: a few hundred kilobytes through 48 KB/s).

## Order of work
1. `arbitrate()` shared; `belts/edit_during_flow_converges`.
2. `Action::Probe`; `belts/predicted_request_is_not_predictable`.
3. `belts/degraded_client_follows`; `belts/reconnect_reputs_structures`.
4. `belts/join_at_scale @slow`; the decision if over 10 s. `belts/saturated_view_paced_bytes @slow`.
5. Deviations, docs, `pnpm test`, `pnpm lint`, `pnpm test:slow netcode`; the manager tags `belts-replicated`.

## Tests added
Netcode: `belts/predicted_request_is_not_predictable`, `belts/edit_during_flow_converges`, `belts/degraded_client_follows`, `belts/reconnect_reputs_structures`, `belts/join_at_scale @slow`, `belts/saturated_view_paced_bytes @slow`. Rust: the two ordering pins only if absent.

## Exit criteria
- [ ] Every scenario passes with an inject-fail-revert recorded (a `Predicting` read answering `Ok` reddens the prediction test; section 13 written before 12 reddens edit consistency; the follower's catch-up skipped reddens the degrade test).
- [ ] `belts/join_at_scale` numbers (bytes, virtual seconds to a held view) are in Deviations and 0078's Consequences; a decision is recorded if over 10 s.
- [ ] The reconnect and paced-bytes figures are recorded (Deviations; the row's `source`).
- [ ] `pnpm test`, `pnpm lint` and `pnpm test:slow netcode` are green; tag `belts-replicated` on the pushed commit.

## Verification commands
`pnpm test netcode -t belts` · `pnpm test:slow netcode -t join_at_scale` · `pnpm test:slow netcode -t saturated_view_paced` · `pnpm test:slow rust -t slow_tick_belts_large` (three runs) · `pnpm test && pnpm lint && pnpm test:slow netcode`

## Budgets
- The 48 KB/s chunk bucket and the 10 s join criterion (0078 Consequences); `transport.downBytesPerSec` unchanged (the M47b row holds); the netcode suite 10 s (3.4 s alone after M47b; `@slow` for anything over a second).

## Context artifacts
`docs/architecture/sync-and-netcode.md` (three sentences above), `packages/engine/tests/netcode/CLAUDE.md`, `packages/engine/fixtures/belts/CLAUDE.md` (`Action::Probe`).

## Manual device checks
none (M57).

## Deviations
(filled in during execution)
