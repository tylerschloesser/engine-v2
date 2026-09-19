# M25: Prediction core

Status: not started · After: 21b, 16b · Tyler-dependent: no

## Goal
The client role predicts the local player's own actions by running the game's `apply` on a `Predicting` overlay over the replica, keeps a pending queue, and resets and replays on every received frame. `Unknown` reads, RNG use and `predict() == false` decline to predict and still send. The taint rule is chosen by the tests written here. Verified natively with a fixture game, including a zero-allocation replay test.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0012-prediction-and-reconciliation.md` (Decision through "Frozen predicted tick"; Consequences)
3. `docs/decisions/0003-game-facing-api.md` (the trait block; "Contexts"; the last Consequences bullet, items 1, 2, 6, 8)
4. `docs/decisions/0022-entity-ids-and-provisional-ids.md` (decisions 5–7)
Mine from spikes: `spikes/prediction-api/engine/src/lib.rs` (`Overlay`, `read_*` helpers, `Predicting`, `Pending`, `Client::predict/submit/on_frame`), `engine/src/harness.rs`, `game/src/lib.rs`, `game/tests/prediction.rs`, `game/tests/alloc.rs`. Rules that apply: `.claude/rules/hot-paths.md`, `.claude/rules/determinism.md`.

## Scope
- `Overlay<G>`: the three preallocated vectors of 0012 plus one `Option<G::Global>` slot; mark/rollback; `saw_unknown`.
- `Predicting<'_, G>` implementing `WorldRead`/`WorldWrite`; `rng()` returns `Err(Unknown)` and sets `saw_unknown`; blind writes outside the subscription set it too.
- `View<'_, G>` reads overlay-then-replica (it read the replica only until now).
- `PendingQueue<G>`: M16's fixed outbox turned into the pending queue (same capacity, same "queue full" behaviour), frozen `predicted_tick` per entry, prediction inside `on_action`, the four reconcile steps inside `ClientCore::on_frame`.
- Provisional ids and the `EntityId` `Deserialize` guard (0022 5).
- The taint rule, the overlay merge of `WorldRead::entities_in` (M21 built the `Authority`/`Store` side), and `entity(id)` semantics (0022 7).
- Fixture game `predict`.

## Non-scope
- Lead estimation and the clocks published to TypeScript: this milestone takes lead from `ClientCore::set_lead(Ticks)` (default 1; tests set it exactly as the spike did). M26 owns the estimator, the renderer hand-off, the `predicted` queries and the no-flicker test.
- Resending pending actions after reconnect (M28b uses the seam below). Host-side undo journal (still asserted, 0004). The state-budget check is not run under prediction (0004).

## Files, packages and crates touched
- `packages/engine/crates/engine/`: new module `predict` (`overlay.rs`, `predicting.rs`, `pending.rs`); edits to the client `on_action` and `on_frame` paths, `View`, and `EntityId`'s serde impls.
- `packages/engine/fixtures/predict/` (new).
- `packages/engine/src/`: the UI-ring result record (kind 2, M16) gains the result value `"NotPredictable"` and `onActionResult` surfaces it.

## Seams
**Provides:**
- `Predicting<'_, G>`, `Overlay<G>` (`mark`, `rollback`, `clear`, `is_empty`, read-only iterators `tiles()`, `entities()`, `players()` for M26), `PendingQueue<G>`, `Pending { seq, action, predicted_tick, status }`, `Prediction::{Applied, NotPredictable, Rejected(G::Reject)}`.
- `EntityId::provisional(seq, index) -> Option<EntityId>`, `EntityId::is_provisional()`.
- The overlay merge of `WorldRead::entities_in` on `Predicting` and `View` (signature and `Authority` side: M21).
- `ClientCore::set_lead(Ticks)`, `ClientCore::predicted_tick()`; `PendingQueue::unacked_after(seq)` iterator of `(seq, &G::Action)`, which M28b's resend uses once this milestone is ticked.
- Per-ack sample hook for M26: `on_ack_sample(auth_tick_at_dispatch, ack_tick)`; each `Pending` records `auth_tick_at_dispatch`.
- `testkit::Loopback` (M15) gains `dispatch(client, action) -> (seq, Prediction)`, `pending(client)`, `overlay_len(client)` and a `visible(client, rect)` equality helper (the spike's `visible()`).

**Consumes:** `Store::apply`, `Delta`, ids (M12); `WorldRead`/`WorldWrite`, `Authority`, `View`, `Outcome` (M12b). `ClientCore`, `Replica` with its held-chunk set, atomic `on_frame`, `FrameSummary.ack_seq`, `testkit::Loopback` with per-client delay (M15). `on_action` with its outbox, the result record and `onActionResult` (M16); the `ui` re-run and `FrameView` minimal (M16b). `Registry` footprints via `G::prototype`, `ChunkIndex` occupancy in `Store`, `WorldRead::entities_in` on `Authority`/`Store` (M21); `TileRect` (M07). `Codec` (M05).

## Planning decisions
- **Provisional ids** follow 0022 5. Private layout: bit 31, then the low 22 bits of `seq`, then a 9-bit spawn index. Unique among 32 pending entries because `seq` is monotonic. A 513th spawn in one action makes `provisional` return `None`, which sets `saw_unknown` (the action is `NotPredictable`).
- **Taint rule: candidates and the test that picks.**
  - R0 none: every pending action is predicted on its own merits.
  - R1 taint-all-later: while any pending action is `NotPredictable`, every later pending action is `NotPredictable`; the taint ends when the tainting action is popped.
  - R2 taint-on-overlap: a later action is tainted only if it reads a key the declined action touched before it was rolled back.
  Implement the rule as a small strategy so all three run against the same scenarios. `taint_dependency` (A is placed across the subscription edge and declines; B deposits into A's furnace by tile; the host accepts both) counts *contradicted verdicts*: a local `Rejected` or `Applied` whose host verdict differs. `taint_rollback_visibility` repeats it with A failing through `rng()` after a read. `taint_independence` (A declines; C is unrelated) counts *lost predictions*. Selection, fixed in advance: a rule is admissible only with zero contradicted verdicts in both dependency scenarios; among admissible rules take the fewest lost predictions; on a tie take the simpler. Expected: R0 fails; R2 is unsound, since a declined action's write set is unknowable once it stops at the first `Unknown`; R1 ships. Record the counts in Deviations, delete the losing strategies, keep the scenarios.
- **Statuses are re-evaluated on every replay** (a declined action becomes predictable once its chunk arrives). TypeScript is told once: `NotPredictable` at dispatch (0003). A local `Rejected` is not surfaced at all, because it is a hint (0012); the UI simply sees no ghost until the host's verdict. `predict() == false` is `NotPredictable` without running `apply`, and taints like any other.
- **Queue full** stays M16's behaviour (the outbox already fails dispatch locally); prediction adds no second limit.
- **Iterating reads.** `entities_in` visits each entity whose footprint intersects `rect` once, in ascending `EntityId` (ids are layout-free and monotonic, so the order is identical on host, replay and client; provisional ids sort last, in spawn order). It returns `Err(Unknown)` before any callback if `rect` touches an unsubscribed chunk. `Predicting` and `View` merge: overlay entries override by id, tombstones are skipped. Ids are collected into a reused scratch vector and sorted; no allocation after warm-up. The `Authority`/`Store`/replica side, the order and the `Unknown` rule are M21's; this milestone adds only the merge.
- **`entity(id)` gone vs unsubscribed:** 0022 7; no signature change. The fixture UI holds a tile and asks `entity_at`.
- **`ui` trigger:** `ui` re-runs after every dispatch and every `on_frame`; the `PartialEq` filter of 0003 already suppresses unchanged JSON, so no overlay diff is needed for it.
- **Cut line.** This milestone sits at the sizing limit. If it overruns, `entities_in` moves to `25b-prediction-range-reads.md` (new `PLAN.md` row, after 25; nothing else waits on it, since M26 merges the overlay into `FrameView::entities()` itself).

## Order of work
1. Fixture `predict`: 2x2 `Place { origin }`, `Deposit { at }`, timed `Collect { tile }`, `Roll` (uses `rng()`), `Cascade` (`predict() == false`), a `put_global` action; shared `can_place(&dyn WorldRead, ..)`.
2. `Overlay`, `Predicting`, `View` layering; port the spike's read helpers onto the real `Store` and `ChunkIndex`.
3. `PendingQueue` from the outbox, prediction in `on_action`, reconcile steps in `on_frame`; `Loopback` helpers.
4. Port the spike scenarios; zero-allocation test.
5. Provisional ids and the `Deserialize` guard.
6. Taint strategies, scenarios, selection.
7. `NotPredictable` through the action-result ring to `onActionResult`.
8. `entities_in` (the cut line).

## Tests added
Rust suite (`predict_*`), ported from the spike unless marked new:
- `placement_is_immediate_and_converges`, `rival_takes_the_spot_never_torn`, `insufficient_inventory_with_pending_spend`, `edge_action_declines_but_resolves`, `dependent_actions_replay_across_ack`, `frozen_predicted_tick` (keep the spike's mutation check as a comment naming the line to break).
- New: `rng_declines`, `opt_out_declines`, `global_put_predicted`, `provisional_id_stable_across_replays`, `provisional_id_rejected_by_deserialize` (JSON and postcard), `entity_id_gone_vs_unsubscribed` (the four cases of 0022 7), `taint_dependency`, `taint_rollback_visibility`, `taint_independence`, `entities_in_merges_overlay` (override, tombstone, provisional-last order, `Unknown` at the edge), `entities_in_order_matches_authority`.
- `predict_alloc`: counting allocator, 0 allocations over 190 replay frames × 4 pending actions (the spike's figure, 0012).
WASM-under-Node suite: `predict_not_predictable_event`: dispatch at the subscription edge yields `NotPredictable` then `Confirmed` from `onActionResult`.

## Exit criteria
- [ ] Every test above passes; the chosen taint rule and the measured counts are written under Deviations.
- [ ] `predict_alloc` reports 0.
- [ ] No losing taint strategy remains in the tree.
- [ ] The browser zero-GC test passes with prediction on.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t predict` · `pnpm test wasm -t predict` · `pnpm test browser -t zero-gc` · `pnpm test && pnpm lint`

## Budgets
- Allocation per isolate, client worker (0016): `predict_alloc` natively, the zero-GC test in the browser.
- Frame time, client-worker `frame` share (0018 section 9): new deterministic counter `predict_replays_per_frame` with a `budgets.json` ceiling equal to the pending-queue capacity.

## Context artifacts
Add a one-line invariant linking the rule to root `CLAUDE.md` (0021 §1; M01's `context-artifacts` test requires it). New `.claude/rules/prediction.md` with `paths:` covering the `predict` module and `fixtures/predict/`: validate first and write after; `?` on every read; never encode a provisional id; statuses are hints. Update the `add-action-type` skill with the address-by-tile rule.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
