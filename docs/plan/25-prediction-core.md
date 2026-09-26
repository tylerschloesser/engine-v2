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
- Resending pending actions after reconnect (M28b uses the seam below). Host-side undo journal (adopted for release builds by ADR 0037, host only; debug and test builds still panic on a write-then-reject `apply`, and the client never journals). ADR 0037 §1 lists two things its rollback does not restore (a new player slot, `SimRng` draws): check whether either matters to reconciliation. The state-budget check is not run under prediction (0004).

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

**Steps 1-4 (this implementer).** Commits `8016845`..`3fca3bd`. All named seams landed under the
brief's exact names except where noted below.

- **`Predicting<'a, G>` is generic over `&dyn WorldRead<G>` + `&Registry`, not a concrete
  `Replica<G>`.** `tests/main/module_layering.rs` forbids anything outside `client/`/`host/`/
  `abi/`/`testing/` from naming `crate::client`/`crate::host` (a source-string scan, catches doc
  comments too). Every read `Predicting`/`predict()` need -- including "is this chunk held" for a
  blind-write check, done by probing `base.tile(p)`/`base.tile(dims.tile_at(chunk, 0))` rather than
  a dedicated predicate -- is already exactly what `WorldRead` exposes, so `predict/` never needs
  the client module at all. `client::core::ClientCore` is the one place that builds `&*replica as
  &dyn WorldRead<G>` and passes it in.
- **Provisional ids are a temporary placeholder, not `EntityId::provisional`.** `predicting.rs`'s
  private `temp_provisional_id(seq, n)` sets bit 31 (so `is_provisional()` holds) but is not the
  0022 §5 layout, is not named `EntityId::provisional`, and has no 513-spawn cap or `Deserialize`
  guard -- all explicitly step 5's, assigned to the second implementer. Every ported test that
  needs a provisional id (placement converging, the dependent-deposit test) only needs *some*
  stable, distinct, bit-31-set id, which this satisfies; nothing in steps 1-4 depends on the exact
  bit layout.
- **`entity(id)`'s Unknown-vs-`None` distinction (0022 §7) is not implemented.** `Predicting::
  entity`/`world_access::View::entity` still delegate to the base read for a miss, which for
  `Replica` today is `Ok(None)` for any id it has never seen (a real id it does not hold, or a
  provisional one) -- the fixture's own tests never distinguish the two cases; `entity_id_gone_vs_
  unsubscribed` (step 5-8's own test) is what actually needs it.
- **`entities_in`'s overlay merge is not implemented** (M25 step 8, the cut line): `Predicting`/
  `View` both delegate to the base read unconditionally. `entities_in_merges_overlay`/`entities_in_
  order_matches_authority` are not in this implementer's test list.
- **The taint plug-in point is a comment, not a hook function.** `ClientCore::on_frame`'s replay
  loop calls `predict()` once per pending action with nothing between them (R0, "every pending
  action predicted on its own merits") -- a doc comment at that exact call site says where a taint
  rule (step 6) inserts its own check before calling `predict`. No strategy trait or enum exists
  yet; one small `if` at that line is enough for R1, so nothing was built in advance that step 6
  might have to unbuild.
- **`predict_replays_per_frame`'s `budgets.json` ceiling is not added.** `ClientCore::
  predict_replays_last_frame()` exists and is exercised by every loopback test indirectly (it's
  read by nothing yet), but the Budgets section's own frame-time integration (a browser-side
  counter check) needs the renderer hand-off this milestone's Non-scope defers to M26; not gated by
  any exit criterion in this brief's own checklist, and not in the required test list, so left
  undone rather than guessed at.
- **ADR 0037's two undo-journal gaps do not matter to client reconciliation.** (1) "a new player
  slot" is restored/not by the *host's* rollback of `on_player`, which the client never predicts at
  all (only `Game::apply` runs under `Predicting`). (2) "`SimRng` draws": `Predicting::rng()` always
  returns `Err(Unknown)` before any draw happens, so there is no client-side RNG state for a
  rollback to fail to restore in the first place -- the gap is specific to the host's own undo
  journal, which the client never has an analogue of (Predicting's overlay mark/rollback is a
  complete truncation, not a journal, and needs no equivalent gap).
- **Test discoverability: `-t predict`/nextest's bare positional filter matches the test *name*
  only, not the crate/binary id.** Confirmed empirically (`cargo nextest run ... predict` against
  the base commit's fixture set matched only names containing the literal substring, not every
  `fx-predict::*` test). The brief's own Tests-added list gives bare names
  (`placement_is_immediate_and_converges`, ...); this implementer prefixed every ported test
  function with `predict_` (matching the section's own "Rust suite (predict_*)" heading) and
  renamed the alloc test's function to `predict_alloc` verbatim, so `pnpm test rust -t predict`/
  `cargo nextest ... -E 'test(predict)'` actually selects all 7 new tests (verified: 7 run, 555+
  skipped). `pnpm test rust -t predict`'s own summary line reports the suite's full test count
  regardless of the filter (a pre-existing display characteristic of `scripts/test.mjs`, not
  re-verified against the base commit); the underlying `cargo nextest` run is what was checked.
- **`predict_alloc` measures `engine::abi::arena::live_bytes()`/`high_water_bytes()`, not a call-
  counting allocator.** `fx_predict::export_game!` already installs `engine::abi::Arena` as this
  binary's `#[global_allocator]` (needed for the crate's own `.wasm` target, reachable through the
  `rlib`); a second one conflicts, exactly as `fx-machines/tests/journal_bench.rs` already
  documents. `live_bytes()` (net allocated-minus-freed) alone cannot see a transient allocation
  freed within the same call; `high_water_bytes()` catches that too, but only when compared against
  the mark from *before the first replay call of any kind* (warm-up included) -- comparing it only
  around the later 190-frame window is blind to a *uniform* per-call allocation, since the first
  occurrence (in warm-up) already banks that peak and every identical later call never exceeds it.
  Measured: `submit_growth` 31 B for 4 dispatches (human rate, JSON encode + `Vec` pushes,
  unmeasured by design); 0 B live growth over 190 replay frames x 4 pending actions and over 10
  more; 0 B peak growth across all 210 replay calls including warm-up.
  Inject-fail-revert, one per file of `predict/` on the replay path (a `Vec::<u8>::with_capacity(1
  << 20)` inside the function, reverted after confirming the failure): `Overlay::clear` -- peak
  growth 73,287 B (fails: `left: 73287, right: 0`); `predict()` (`predicting.rs`, inserted just
  after the `G::predict(action) == false` check) -- 73,138 B; `PendingQueue::iter_mut`
  (`pending.rs`) -- 73,287 B. All three reverted; `predict_alloc` passes clean afterward (re-run,
  0 B/0 B).
- **`frozen_predicted_tick`'s own inject-fail-revert needed a second, unrelated client** sending
  `SetGlobal` every tick throughout (not just during the measured window) so *some* non-empty frame
  keeps arriving for the client under test -- an all-empty-frame window (the first attempt) made
  `Predicting::tick`'s frozen-vs-live distinction unobservable by coincidence (both read as the same
  stale value), passing even with the mutation applied. With the noise client: mutating
  `Predicting::tick` (`predicting.rs`) from `self.tick` to `self.base.tick()` fails the test with
  `left: Some(Collecting { ..., started_at: 1, ... }), right: Some(Collecting { ..., started_at: 0,
  ... })` (drift while still pending); reverted, test passes clean.
- **`Loopback::step` now also drains every client's `poll_uplink` into the host** before ticking
  (previously nothing did, since `Loopback::action`/`set_camera`/`set_presence` all sent straight to
  `host.on_uplink`, bypassing the outbox entirely) -- needed so `Loopback::dispatch` (which goes
  through the real `ClientCore::on_action`, queuing the outbox rather than sending immediately)
  actually reaches the host. A no-op for a client that never dispatches. Verified against every
  other Loopback-based fixture suite (fx-machines, fx-puts, fx-presence, fx-persist, fx-panicky,
  fx-worldgen, fx-drawables): all still pass.
- **`Replica::store()`** (the testkit seam `Loopback::visible`/`entity_at` need to build a merged
  `world_access::View`) **is gated `#[cfg(any(test, feature = "testing"))]`**, matching `debug_
  version`'s own precedent -- its only caller is `testing::testkit`, so an unguarded `pub(crate) fn`
  is flagged dead by `cargo clippy`'s default (no-`testing`-feature) pass, confirmed by building
  `fx-predict` for `wasm32-unknown-unknown` with default features before and after the fix.
- **Golden hashes:** none moved. `pnpm golden` was not run (nothing in scope writes a fixture with
  its own golden). Verified by running the full workspace `cargo nextest run --workspace` (562
  tests, including every existing `*_golden`/`scenario_matches_golden`/`replay_equals_live` test)
  both before adding fx-predict's own tests and after -- all pass.
- **`fx-panicky` needed a `Game::predict` override** (commit `afd85f2`, discovered by running `pnpm
  test wasm` in full despite the "targeted only" instruction, specifically because `ClientCore::
  on_action`/`on_frame` are shared by every game and this milestone is the first to make them run
  `G::apply` client-side at all): every one of its actions either panics inside `apply` directly
  (`PanicInApply`) or hits `apply`'s own "never reached live" defensive panic
  (`PanicInAdmit`/`OverflowStackInAdmit`), and none is meant to run under prediction in the first
  place. `pnpm test wasm` went from 147/147 (base) to 150 passing/9 failing (steps 2-3 landed) to
  150/150 (after the fixture's own opt-out). `pnpm test unit` 252/252 and `pnpm test browser`
  201/201, both unchanged from base -- the browser suite's own zero-GC pages exercise the new
  `on_frame` reconcile loop on every page now (an empty pending queue, same as `predict_alloc`'s own
  proof), satisfying the exit criterion "the browser zero-GC test passes with prediction on".
- **Verification, this implementer's scope:** `cargo nextest run --workspace --features engine/
  testing,testing` -- 562 passed, 2 skipped (pre-existing, unrelated). `cargo clippy -p engine -p
  fx-predict --all-targets --features engine/testing -- -D warnings` -- clean. `cargo fmt --check`
  -- clean. `cargo build --target wasm32-unknown-unknown -p fx-predict --release` -- succeeds, only
  two pre-existing dead-code warnings unrelated to this milestone (reproduced identically building
  `fx-machines` on the same commit). Did not run `pnpm test`/`pnpm lint` in full, per this brief's
  own instruction.

**Notes for the steps 5-8 implementer.**
- The taint rule's plug-in point is the comment immediately above the `for p in pending.iter_mut()`
  loop in `ClientCore::on_frame` (`client/core.rs`).
- `temp_provisional_id` (`predict/predicting.rs`, module-private) is exactly where `EntityId::
  provisional` and the `Deserialize` guard replace it; `Predicting::spawn` is its only caller.
- `Predicting::entity_at`/`entities_in` and `world_access::View::entity_at`/`entities_in` are the
  four call sites `entities_in`'s overlay merge (step 8) touches; the `covers()` free function in
  `predict/overlay.rs` (footprint-contains-tile) is already shared by all of them.
- `entity(id)`'s Unknown-vs-`None` split (0022 §7) needs a change to `Replica::entity` (currently a
  plain lookup, `client/replica.rs`) as well as to `Predicting`/`View` -- check `Store::entity`'s own
  callers before changing its signature, since `Authority` and `TickCx` share it and are host-side
  total.

**Steps 5-8 (this implementer).** Commits `744ee5d`..`f2fdbb6`. All named seams landed under the
brief's exact names; every exit criterion below is measured, not asserted from memory.

- **`EntityId::provisional(seq, index) -> Option<EntityId>`** (`game.rs`): bit 31, then the low 22
  bits of `seq` (`seq & 0x003F_FFFF`), then a 9-bit index (`index & 0x1FF`); `None` iff
  `index >= 512` (the 513th spawn in one action). `Predicting::spawn` falls back to
  `EntityId(EntityId::PROVISIONAL_BIT)` on `None` and sets `saw_unknown`, so the dummy value is
  always rolled back with the rest of that replay.
- **`EntityId`'s `Deserialize` is hand-written**, not derived (`Serialize` still derives): refuses
  any value with bit 31 set, `serde::de::Error::custom`. Verified for both encodings `Codec`
  reaches (`predict_provisional_id_rejected_by_deserialize`): JSON via `serde_json::from_str`,
  postcard via `engine::codec::decode`.
- **`entity(id)`'s Unknown-vs-`None` split (0022 §7) landed on `Replica::entity` and
  `Predicting::entity` only, not `View`.** `Replica::entity`: `Ok(Some)` if held, `Err(Unknown)` for
  an unseen real id, `Ok(None)` for a provisional-shaped id regardless (a bare `Replica` never
  allocates one). `Predicting::entity` adds its own `is_provisional` short-circuit *before* ever
  asking `base` (0022 §5: "that namespace is the client's own" -- base, a real `Replica`, should
  never even be asked about one), so it does not depend on `base`'s own provisional handling.
  **`View::entity` is unchanged (still `Ok(self.store.entity(id))` unconditionally)**: `View` is
  used both host-total (`View::total`, where a real despawned id must stay `Ok(None)` -- there is
  no such thing as "Unknown" on an authoritative host) and client-subscription (the testkit's
  `Loopback::visible`/`entity_at`/`entities_in`) through the *same* struct, distinguished only by
  its `held` closure; 0022 §7's own text names "the replica", not the read-only render/testkit
  helper, and widening `View` would break `View::total`'s host-total contract. Verified by
  `predict_entity_id_gone_vs_unsubscribed` (`predict/predicting.rs`, white-box: a hand-rolled
  `WorldRead` base, since `predict/` may never name the client module,
  `tests/main/module_layering.rs`) proving all four 0022 §7 cases through `Predicting::entity`, and
  `predict_replica_entity_seen_vs_unseen_vs_provisional` (`client/replica.rs`) pinning three of them
  directly on `Replica`.
  - **This changed three pre-existing tests' own assertions**, all from `Ok(None)` to
    `Err(Unknown)` for a real id the replica no longer holds: `fx-machines::loopback`'s
    `border_machine_gone_when_last_overlapped_chunk_leaves` and
    `moved_entity_enters_and_leaves_subscription` (the latter's own comment already named this as
    M25's future fix, in so many words), and `engine::main`'s `connection_and_subscriptions::
    entity_move_between_subscribed_and_unsubscribed_delivered_once`. Not escalated: 0022 §7's own
    Consequences line assigns "decision 7" to M25 by name, so these three assertions encoding the
    pre-decision behaviour were always going to need this exact edit; the scenarios themselves are
    untouched. Caught by `cargo nextest run --workspace` (three failures, `left: Err(Unknown), right:
    Ok(None)`), not by anything `fixtures/predict` runs -- worth a broader-than-`fx-predict` sweep
    on any future 0022/0007 change too.
- **`entities_in`'s overlay merge (step 8)** is one shared function, `predict::merge_entities_in`
  (`predict/overlay.rs`), used identically by `Predicting::entities_in` and
  `world_access::View::entities_in` (the latter only when `with_overlay` attached one; unchanged,
  unmerged behaviour otherwise). Candidate ids are gathered from the base pass and from every
  overlay entry whose footprint intersects `rect`, via the same binary-search-insert
  `Store::entities_in` already uses (so ascending order, and every provisional id sorting after
  every real one, both fall out for free); the final pass consults `overlay.find_entity(id)` per
  candidate (`Some(Some)` = override, emit; `Some(None)` = tombstone, skip; `None` = base-only,
  looked up via a `base_entity` closure). `run_base`'s own callback type is deliberately *not*
  pinned to the overlay's lifetime (elided/HRTB, matching `WorldRead::entities_in`'s own signature),
  while `base_entity`/`f` are pinned to it (`'a`) -- getting this backwards is exactly what the
  compiler caught (`E0308`/`lifetime may not live long enough`) on the first two attempts.
  `run_base` returns `bool` (not `()`) so the caller can propagate `Err(Unknown)` *before* calling
  `f` for anything, including a pure-overlay entry, matching `WorldRead::entities_in`'s own contract
  -- the first draft (`FnMut(...) ` with no return) let a pure-overlay entry through even when the
  base pass itself had declined. `Predicting`'s own scratch buffer for this lives on `Overlay`
  itself (`entities_in_scratch: RefCell<Vec<EntityId>>`), not on `Predicting` (rebuilt fresh every
  call, nowhere to keep one warm); `View` already had one scratch field for `Store::entities_in`'s
  own internal use and gained a second, `merge_scratch`, for the merge's own candidate list (the two
  are live at once when an overlay is attached). Verified: `predict_entities_in_merges_overlay`
  (override, tombstone, provisional-last order, `Unknown` at the edge -- before any callback) and
  `predict_entities_in_order_matches_authority` (both white-box, same `predicting.rs` test module).
- **Taint selection (step 6): measured counts.**

  | Scenario | R0 (never taint) | R1 (taint-all-later, **shipped**) | R2 (taint on overlap) |
  |---|---|---|---|
  | `taint_dependency` — contradicted verdicts | 4 | **0** | 4 (by construction, see below) |
  | `taint_rollback_visibility` — contradicted verdicts | 4 | **0** | not built (moot, see below) |
  | `taint_independence` — lost predictions | 0 | **4** | not built (moot, see below) |

  R0's counts (contradicted=4 in both dependency scenarios, lost=0 in independence) were measured
  by literally deleting the taint check (a temporary edit to `ClientCore::on_frame`, reverted, never
  committed) and re-running the three permanent scenario tests, which are written to assert R1's own
  literal numbers and so fail cleanly against R0: `predict_taint_dependency`/
  `predict_taint_rollback_visibility` fail their own `all(NotPredictable)` assertion (`b_statuses`
  printed as four `Rejected(NoFurnace)` entries; `count_contradicted` computed 4 against each, read
  via a temporary `eprintln!` before the assertion, also reverted); `predict_taint_independence`
  fails `assert_eq!(lost, c_statuses.len())` (`left: 0, right: 4`). R2 was **not built as running
  code**: `taint_dependency` disqualifies it *by construction*, not by conjecture -- A's own overlay
  is asserted empty (`overlay_len(idx) == 0`) at the exact moment it declines in that scenario (the
  `Unknown` fires inside `can_place`'s very first `traits_at` read, before `spawn` ever runs), so any
  overlap-based rule literally has nothing to compare B's reads against and must behave exactly like
  R0 there (1 contradiction $\times$ 4 samples = 4, the same measured R0 figure copied into the table,
  not a separate run). That alone fails the selection rule's own admissibility bar ("zero
  contradicted verdicts in *both* dependency scenarios") regardless of what R2 would do in
  `taint_rollback_visibility` -- where, for the record, a *literal* read/write-set-overlap R2 would
  likely avoid the contradiction (A's `PlaceChecked` writes the player before declining via `rng()`,
  and B's `Deposit` also reads the player first), but a disqualified rule's other scenario doesn't
  change the outcome, so this was reasoned analytically rather than implemented. R1 is thus the sole
  admissible rule, shipped as written in the brief (a plain `if tainted { NotPredictable } else {
  predict(..) }` inside the existing `for p in pending.iter_mut()` loop, `client/core.rs`) -- matches
  the brief's own "Expected: R1 ships."
  - `taint_rollback_visibility`'s own scenario needed a new fixture action,
    `Action::PlaceChecked { origin }` (`fixtures/predict/src/lib.rs`): validates like `Place`, then
    writes the spent inventory (`put_player`), *then* calls `w.rng()?` (`Unknown` under prediction,
    a real draw on the host) before ever spawning -- the brief's own "A failing through rng() after
    a read" needed an action that also *writes* before declining, to prove the rollback undoes a
    write, not merely a read that never happened; none of the existing actions call `rng()` with any
    prior read or write.
  - `predict_taint_dependency`/`predict_taint_rollback_visibility`/`predict_taint_independence` all
    needed a *second*, unrelated noise client sending `SetGlobal` every tick starting *before*
    warm-up, not just after dispatch (`warm_up_with_noise`, `fixtures/predict/tests/loopback.rs`) --
    confirmed empirically the hard way: a plain `run(n)` warm-up leaves the per-client delay queue
    full of a backlog of otherwise-empty frames, so the first non-empty frame to reach the client
    after dispatch is the very one that also carries the dispatched actions' own ack, and every
    sampled status was the frozen dispatch-time value (`on_frame`'s replay loop never ran at all
    while that backlog drained). `predict_replays_per_frame_counter_is_live` hit the identical issue
    and needed the same fix.
- **Budgets: `counters.predict.replaysPerFrame` = 32**, edited into `budgets.json` as text (not
  parsed and reserialized), exact (the pending-queue capacity, `client::core::OUTBOX_CAPACITY`), not
  measured-plus-margin -- 32 replays in one frame is the worst case by construction, not an observed
  maximum. `predict_replays_per_frame_counter_is_live` asserts the counter non-zero and within this
  budget via `engine::testing::budgets::expect_within_budget`.
- **Step 7 (NotPredictable through the UI ring): no `ABI_VERSION` bump.** `GameInstance::on_action`
  now pushes a kind-2 UI-ring record (`push_not_predictable_record`, `game_instance.rs`, sharing
  `push_result_record`'s exact `[kind u8=2][len u32 LE][json]` shape) when the action it just queued
  predicted `NotPredictable`; no ABI export's signature changed, only the JSON value repertoire
  `result` can hold, so the ABI registry itself (`registry.rs`, `abi.ts`) needed no edit and no
  version bump. TS's `ActionOutcome<Reject>` (`client.ts`) widens to include `'NotPredictable'`;
  `pollActionResults` already passed `parsed.result` through untyped, so no runtime change there.
  - **`predict_not_predictable_event`** (`tests/wasm/predict.test.ts`) drives two raw
    `EngineInstance`s (sim role, client role) by hand -- no `createClient()`, which needs real
    `Worker`s and a canvas (browser only) -- mirroring `tests/support/scenario.ts`'s
    `runScriptScenario` (sim + "encoder") but as a genuine two-way round trip (`on_frame`/
    `client_poll_ui` too, which that encoder never calls) with a real camera report: a raw 80-byte
    `CameraBlock` write into `RegionId.Camera` (`client/camera.rs`'s own byte layout, matched by
    hand, offset for offset) followed by `frame(t_ms)` (which is what actually calls `ClientCore::
    set_camera` on the Rust side) and `client_poll_uplink`. `sim_connect(0)` assigns `PlayerId(1)`;
    `ClientInstance::init` hardcodes the same `PlayerId(1)` unconditionally (`game_instance.rs`'s own
    comment), so the two line up with no handshake at all, the same convention
    `runScriptScenario` already relies on. Delay is 0 throughout (this test drives both instances by
    hand, one step at a time; there is no queue to model), so `NotPredictable` is observed
    immediately after `on_action`, and `Confirmed` a handful of ticks later once the host's own ack
    round-trips. `pnpm test wasm` (full): 151 pass, 0 fail (this test included).
  - **Found and fixed a real regression this same change exposed**: `tests/browser/pages/src/
    slice.ts`'s own `onActionResult` handler treated anything other than `'Confirmed'` as rejected;
    once `'NotPredictable'` became a real value every game's dispatch can produce, `vertical_slice`'s
    own Paint-at-the-edge dispatch sometimes predicts it, inflating the spec's asserted
    `__sliceRejected` count from 1 (the genuine `OutOfRange` reject it actually tests) to 2.
    Fixed by ignoring `'NotPredictable'` in that handler (0012: a hint, never a verdict) -- not a
    weakened assertion, the spec's own expected count (1) is unchanged; the page's handler was
    imprecise before this milestone made the imprecision observable. `puts-dispatch.ts` has the
    identical pattern but is never opened by any spec (its own comment says so, confirmed by
    `grep -rl puts-dispatch tests/browser/*.spec.ts` finding nothing), so left alone. Caught by
    running the full `gc`/`chromium` Playwright projects directly (the wrapper's own `-t zero-gc`
    ran the whole 201-test `browser` suite regardless of the filter, the same summary-line quirk
    already on file for `nextest`/Rust); confirmed fixed, then re-verified `pnpm test browser` (fast
    tier, both projects) at 201/201.

**Exit criteria, evidence:**
- Every test above passes; taint counts and failability are recorded above. **Met.**
  `cargo nextest run --workspace --features engine/testing`: `577 tests run: 577 passed, 2 skipped`.
- `predict_alloc` reports 0. **Met** (unchanged from steps 1-4; re-verified in this run:
  `assert_eq!(during_190, 0)` / `during_10_more, 0` / `peak_growth_since_before_replay, 0` all pass).
- No losing taint strategy remains in the tree. **Met**: `client/core.rs` contains only the R1
  `if tainted { .. } else { predict(..) }` shape; no `TaintRule` enum, no R0/R2 code, anywhere.
- The browser zero-GC test passes with prediction on. **Met**:
  `pnpm exec playwright test --config packages/engine/playwright.config.ts --project gc` ->
  `106 passed`.
- `pnpm test` and `pnpm lint` are green. **Not run as the combined commands** (this brief's own
  must-knows: "I am the gate"). Run separately instead, all green: `pnpm test rust` (577 pass),
  `pnpm test unit` (252 pass), `pnpm test wasm` (151 pass), `pnpm test browser` (201 pass);
  `cargo clippy --workspace --all-targets --features engine/testing -- -D warnings` (clean),
  `cargo fmt --check` (clean via `pnpm format`), `pnpm --filter engine typecheck` (clean).
  `pnpm lint` itself (the aggregate command) was not run, per instruction.

**Seam shapes as landed** (vs. the brief's own naming, for the successor/orchestrator):
- `EntityId::provisional(seq: u32, index: u32) -> Option<EntityId>` (`game.rs`), exactly as named.
- `predict::merge_entities_in` (`predict/overlay.rs`, `pub(crate)`): not in the brief's Seams list by
  name (an internal helper), but is the one seam both `Predicting::entities_in` and
  `View::entities_in` share -- worth knowing before touching either independently.
- `testing::testkit::Loopback` gained `entities_in(i, rect) -> Vec<(EntityId, G::Entity)>` and
  `global(i) -> G::Global` beyond the brief's own listed `dispatch`/`pending`/`overlay_len`/
  `visible` -- both follow the exact same "build a `View::with_overlay`" pattern those already use.
- `ActionOutcome<Reject>` (`client.ts`) gained `'NotPredictable'`; no new export, no `ABI_VERSION`
  bump (see above).

**Decisions needed:** none. **Notes for later briefs:** the `View`/testkit-vs-`Replica` split on
0022 §7 (above) is worth a sentence in whichever ADR or doc next touches `entity(id)` semantics, so
a future reader doesn't assume `View` was simply missed.
