# 0012: Prediction and reconciliation

Status: Accepted (2026-09-19)

## Context

`docs/spec/sync.md` requires that lag not be noticeable, yet clients never hold the whole world, so whatever is predicted must run on a partial replica. `spikes/prediction-api` proved a design in which the game writes each rule once ([0003](0003-game-facing-api.md)). Patterns taken from Factorio's latency state (FFF-83/302: reset to confirmed state, re-apply pending local actions; do not hide cascading actions), Gambetta (per-input sequence numbers, ack, replay unacked inputs; render remote entities in the past), Overwatch (predict by default, opt out), lightyear (decay a visual error instead of snapping), and Fiedler (Hermite interpolation with velocity).

## Decision

**What is predicted:** only the local player's own discrete game actions. All of them by default, with a per-action opt-out for actions that cascade or draw from the sim RNG. **The client runs no tick rules.** Remote players, machines, and every consequence of a tick rule are never predicted.

**Mechanism: reset-and-replay overlay.** The game's single `apply(world, who, action) -> Result<(), Reject>` runs on the client against `Predicting` (reads overlay-then-replica; writes are puts pushed onto the overlay). The overlay is three preallocated vectors (tiles, entities with tombstones, players) that keep capacity across `clear()`; a failed action rolls back by truncating to a mark. At dispatch the action is applied once, queued as pending with its `seq`, and sent. Then, once per received frame ([0011](0011-wire-format-and-deltas.md)):

1. apply the frame's deltas to the authoritative replica;
2. pop pending actions with `seq <= ack_seq`, raising `Confirmed` or `Rejected(reason)` to the game UI (`Confirmed` carries a provisional→real entity id map, in spawn order, only if the provisional-id item deferred under Consequences picks id rewriting; [0004](0004-action-timing-and-rejection.md) `Applied`);
3. `overlay.clear()`;
4. re-run `G::apply` for each still-pending action.

Measured: 0 allocations over 190 frames × 4 pending actions. The pending queue has fixed capacity (initially 32); when full, dispatch fails locally.

**`Unknown` reads.** A read of state the client does not hold (anything outside its subscription, including `tile()`, since the chunk's overlay is absent even though pristine terrain is computable) returns `Err(Unknown)`, which `?` converts through `From<Unknown> for G::Reject`. The engine also sets a `saw_unknown` flag that overrides whatever the handler returned. The engine then truncates the overlay to the pre-action mark, marks the action `NotPredictable`, and **still sends it**; the UI may show it as pending. A local `Rejected` is likewise a hint, never a verdict: the client always sends and the host decides.

**Frozen predicted tick.** Under prediction `w.tick()` returns the tick estimated at submit time, stored per pending action. Replays never re-estimate it; otherwise a timer written by the handler is rewritten every frame and its bar crawls backwards.

**Two clocks.** Authoritative = tick of the latest frame. Predicted = authoritative + lead, where lead is the estimated round trip in ticks. A player's own timers are written and rendered in the predicted clock, before and after the ack, so the bar advances one step per tick with no jump at confirmation. Everything not predicted renders against the authoritative clock.

**Correction without snapping.**
- An action's ack and the deltas it caused arrive in one atomically applied frame, so the ghost leaves the overlay in the same render in which the real result appears; the id map, if the deferred provisional-id item under Consequences keeps it, lets the renderer carry animation state across (otherwise the stable key does).
- A conflicting delta can arrive before the reject ack; re-prediction then fails and the ghost goes early. The spike showed no torn state (ghost XOR refunded item) on any frame.
- `extract` marks overlay-sourced tiles and entities as `predicted`, so the game can style pending things and animate a rejection using its reason code instead of popping.
- If the lead estimate was off by k ticks, the ack causes exactly one k-tick correction of an own timer; the displayed offset eases to zero over ~200 ms.

**Remote motion: interpolation, not prediction.** Presence samples ([0001](0001-camera-and-presence.md)) and any moving entity share one buffer and one code path in the client-role WASM: Hermite interpolation on position + velocity at `host time − interpolation delay` ([0010](0010-rates-and-subscriptions.md)); extrapolate at most 250 ms, then hold; fade an avatar after 2 s of silence. Progress of remote machines and players is derived from replicated parameters and the authoritative clock.

**Single-player runs the identical path:** a sim worker as host and the same client worker, two instances of one compiled module, the same frames over the in-browser transport ([0009](0009-transport-and-hosting.md)). Prediction stays on: without it an action waits for the next tick boundary (up to 50 ms) plus two hops and a frame. The replica holds only subscribed chunks (at most ~0.5 MB at the 128-chunk cap), not a second world.

## Alternatives rejected

- **Client-side tick simulation of subscribed chunks:** tick rules would have to be correct on a partial world, where inputs from unsubscribed chunks make mispredictions systematic rather than rare.
- **Rollback of full state** (lightyear, Overwatch): the client does not hold the state to roll back, and continuous tick-aligned input needs a run-ahead clock, a host input jitter buffer, and time dilation, none of which discrete actions need.
- **No prediction:** every tap would wait 60–200 ms RTT plus a tick boundary; perceptible even in single-player.
- **A separate game-written `predict()` per action:** two implementations of each rule drift apart. The spike made this fallback unnecessary.
- **Cloning the replica per frame instead of an overlay:** copies every subscribed chunk 20 times a second.
- **At the subscription edge, predicting only what is visible:** draws a ghost whose validity nobody checked. **Rejecting locally without sending:** makes partial knowledge authoritative over full knowledge.
- **Player movement as a predicted, logged action:** see [0001](0001-camera-and-presence.md).

## Consequences

- Game authors follow two rules: validate first, write after; and use `?` on every read. Prediction-specific game code in the spike was 5 lines.
- A panic in `apply` under prediction traps only the client instance; the host is always a different instance.
- Interim rule until item 1 below is settled: actions address things that may be predicted by a stable key (tile), not by `EntityId`.
- Deferred to Phase 2: provisional ids for predicted entities (stable-key addressing vs. engine rewriting of ids inside pending actions), because the choice depends on the reference game's final action shapes and on whether the engine may see inside `G::Action`.
- Deferred to Phase 3 (the prediction milestone): the taint rule after a `NotPredictable` action (likely: mark every later pending action `NotPredictable`), because a later action predicted without its effects can be rejected locally while the host accepts, and the rule needs tests against the real pending queue.
- Deferred to Phase 2: the per-frame overlay change list for the renderer (diff the overlay before and after each replay; emit dirty tiles/entities plus the `predicted` flag), because it depends on the DrawList design in [0018](0018-renderer.md).
- Deferred to Phase 2: enforcing host-side atomicity of `apply` with an undo journal, because its cost is unmeasured; until then the host asserts that a rejecting handler recorded no write.
- Deferred to Phase 2: the own-timer completion gap (the bar is full one RTT before the host's tick rule delivers the result; options: accept it, render over `duration + lead`, or an opt-in predicted expiry), because it is a UX call that needs the running game.
- Deferred to Phase 2: lead (clock) estimation, iterating reads over replica + overlay, and distinguishing "does not exist" from "outside my subscription" in `entity(id)`, because the spike used an exact lead and built none of them.

## Sources

- `spikes/prediction-api/RESULT.md` (verdict, tests, allocation count, open problems); `docs/research/sync.md` sections 2, 3.6–3.10.
- https://www.factorio.com/blog/post/fff-83 · https://www.factorio.com/blog/post/fff-302 · https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html
- https://www.gdcvault.com/play/1024001/-Overwatch-Gameplay-Architecture-and · https://github.com/cBournhonesque/lightyear · https://gafferongames.com/post/snapshot_interpolation/
