---
paths:
  - "packages/engine/crates/engine/src/predict/**"
  - "packages/engine/fixtures/predict/**"
---

# Prediction: the client predicts by replaying the game's own `apply`

The client never runs tick rules and never gets a second, separate rule to maintain: `Predicting`
(`crates/engine/src/predict/predicting.rs`) reuses the same `Game::apply` a rejecting host runs,
against an overlay layered over the replica (`docs/decisions/0012-prediction-and-reconciliation.md`
Decision; `docs/decisions/0003-game-facing-api.md` Consequences: "validate first, write after; add
a `?` to each read").

In a game's `apply`/`predict`/`admit` and in the fixtures under `predict/`:

- **Validate first, write after.** A rejecting handler must not have written anything (checked by
  the host's own debug/test-build panic and, in release, its undo journal, `docs/decisions/
  0037-undo-journal-adopted.md`) -- under prediction there is no journal at all, so a handler that
  writes before validating leaves the overlay's rollback truncating state the handler never meant
  to keep.
- **`?` on every read.** A read of state the client does not hold returns `Err(Unknown)`; the `?`
  operator is what lets the engine notice it (`Overlay::mark_unknown`) and decline the whole action
  as `NotPredictable` instead of predicting a half-known result. A read written without `?` (an
  `.unwrap()`, a manual `match` that swallows `Unknown`) hides that signal.
- **Never encode a provisional id.** A client-local spawn's id has bit 31 set
  (`EntityId::is_provisional`, 0022 §5) and is never sent, logged, hashed or put in `G::Ui` JSON as
  anything but a display value; address a predicted entity by tile in an action, never by id
  (0022 §6).
- **A predicted status is a hint, not a verdict.** `Prediction::Rejected` is never shown to the
  player as a rejection on its own -- the action is still sent, and only the host's own ack
  (`Confirmed`/`Rejected` through `ActionResults`) is authoritative. `NotPredictable` means "no
  ghost yet", not "rejected".
- **Texel conversion always reads overlay-then-replica, and is triggered only through the dirty
  set** (docs/plan/26-prediction-rendering-and-clocks.md): a chunk's `CHUNK` upload record
  (`client/upload.rs`'s `Uploader::stage_predicted`) reads pristine, then the replica's own
  overlay, then the prediction overlay's effective tiles (`Overlay::effective_tiles`) on top --
  never the prediction overlay alone, and never outside a dirty-chunk re-stage
  (`ClientCore::mark_dirty`/`OverlayDiff`, the one and only path that decides a chunk needs
  re-staging; a per-frame unconditional re-scan would defeat "no upload while unchanged"). Key
  cross-ack client state by tile, not by transient upload bookkeeping: the ghost-to-real swap at
  an ack is a property of the *overlay* going empty for that tile (`OverlayDiff` sees it removed),
  not of any upload-side identity a slot/record carries from one frame to the next.

Verified by `fixtures/predict`'s own `loopback`/`alloc` suites (`pnpm test rust -t predict`); the
replay loop's own zero-allocation property is `predict_alloc`, proven failable per file of
`crates/engine/src/predict/` by an inject-fail-revert (a temporary allocation that the test then
catches, reverted before commit).

Gotchas the tests cannot see or that make them vacuous:

- Swallowing `Unknown` in `can_place` (`unwrap_or_default` on `traits_at`) still yields `NotPredictable` at the subscription edge, because the engine declines any spawn touching an unheld chunk: the `?` rule is enforced by the engine and review, not a test. Likewise `client.input.setMode('tool')` while placing passes the drag test (the engine pans on a one-pointer drag in either mode), so the no-`setMode` rule is review-enforced.
- A re-stage of a resident chunk must never pass through the non-resident state: `Replica::apply_snapshot_overlay` -> `replace_overlay` evicts the cached slab, and a host `ChunkSnapshots` for an already-rendered chunk staged `INDIR_NONE` for one frame (a grey `NEUTRAL` flash that looked like a prediction bug). Materialise synchronously on replace and cancel an `Evicted`-then-`Loaded` pair for one slot in one drain.
- Prediction scenarios need a second client sending `SetGlobal` every tick from before warm-up (`warm_up_with_noise`), else the first non-empty frame also carries the ack, the replay loop never runs and `frozen_predicted_tick` passes vacuously. `predict_alloc` compares `high_water_bytes` with a mark taken before the first replay call, warm-up included. A game whose `apply` panics (`fx-panicky`) opts out with `Game::predict -> false`, because `ClientCore` runs `apply` client-side for every game.
- Open: prediction runs `G::apply` in the client `.wasm`, so a panicking `apply` traps the client instance; M24 recovery covers only the sim worker and `fx-panicky` hides it. Undecided: report `NotPredictable` or re-instantiate the client (0050 covers only the generic client-trap re-`Hello`).
