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

Verified by `fixtures/predict`'s own `loopback`/`alloc` suites (`pnpm test rust -t predict`); the
replay loop's own zero-allocation property is `predict_alloc`, proven failable per file of
`crates/engine/src/predict/` by an inject-fail-revert (a temporary allocation that the test then
catches, reverted before commit).
