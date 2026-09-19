# 0004: Action timing, ordering, validation and rejection

Status: Accepted (2026-09-19)

## Context

Actions are the only way to change the sim from outside, and "all actions with their timings" are part of the world's identity ([`../spec/simulation.md`](../spec/simulation.md)). With 2-8 clients on mobile networks, someone has to decide which tick an action lands on, in what order, what happens to an invalid one, and how the sender's prediction layer ([0012](0012-prediction-and-reconciliation.md)) learns the outcome. The host is a single process per world, so it can be the sole sequencer.

## Decision

**The host assigns the tick and the order; the log's order is the canonical order.**

- An action received while tick *T* is current is scheduled for tick ***T+1***. Clients never choose ticks. There is no input delay and no waiting for slow clients.
- Within a tick, actions apply in **host arrival order**, before the tick rules: `for a in frame(T+1) { apply(a) }; tick()`. The log records the order positionally. Engine-defined connection events (`Joined`, `Connected`, `Disconnected`; grace period in [0013](0013-sessions-and-integrity.md)) are sequenced in the same stream and reach the game through `on_player` ([0003](0003-game-facing-api.md)).
- The host, never the client, stamps `who: PlayerId` from the connection.
- Every client action carries a per-connection, monotonically increasing `seq: u32`; each host frame's header carries `ack_seq`, the last `seq` processed for that player (framing: [0011](0011-wire-format-and-deltas.md)).

**Pipeline per action:**

| Step | Where | On failure |
|---|---|---|
| 1. Decode postcard into `G::Action` | host | Malformed: protocol error, connection closed ([0013](0013-sessions-and-integrity.md)). Not a rejection |
| 2. Admit: rate limit (20 actions/s sustained, burst 40, per connection), then `G::admit` ([0001](0001-camera-and-presence.md)) | host only, never replayed | `Rejected`; **not logged** |
| 3. Append to the frame for *T+1*; the frame is written to the log before it is applied ([0005](0005-persistence-and-recovery.md)) | host | storage failure is fatal to the world |
| 4. `G::apply` at the start of *T+1*: deterministic validation against sim state, then writes. A rejecting `apply` must have written nothing. The engine first checks the state budget ([0007](0007-world-model.md)) | host live, host replay; clients run the same code for prediction | `Rejected`; **the action stays in the log** and replay rejects it again, identically |
| 5. Ack | host | |

**Acks ride on deltas.** The results for every action a client sent during tick *T* are delivered in that client's network frame for tick *T+1*, in `seq` order, together with the deltas those actions caused, and the frame is applied atomically on the client. A frame is sent for a tick whenever there is an ack to carry, even with no deltas.

```rust
pub struct Ack<G: Game> { pub seq: u32, pub tick: Tick, pub result: Result<Applied, Rejected<G>> }
pub struct Applied { pub spawned: /* real EntityIds in spawn order */ .. }     // maps provisional ids (0012)
pub enum Rejected<G: Game> { Game(G::Reject), Engine(EngineReject) }
pub enum EngineReject { RateLimited, StateBudgetFull, EngineFault /* skip record, 0005 */ }
```

**Flow to the prediction layer.** The client keeps a queue of unacked actions. On each frame it applies the deltas to its replica, pops every pending action with `seq <= ack_seq`, clears the overlay, and re-runs `apply` for what is still pending ([0012](0012-prediction-and-reconciliation.md)). Because the ack and its deltas share a frame, a confirmed ghost is replaced by the real thing in one render, and a rejected one disappears with no intermediate state. For each popped action the game's TypeScript gets `onActionResult(seq, Confirmed | Rejected(reason))` so it can show feedback. A local prediction failure is a hint, never a verdict: the client always sends the action. After a reconnect the client resends pending actions with `seq` above the host's last processed value, so nothing applies twice ([0013](0013-sessions-and-integrity.md)).

**Log growth.** With the log frame layout in [0005](0005-persistence-and-recovery.md), one action costs about 16 bytes alone in its frame and about 10 bytes when frames are shared (payload 3-8 bytes: two zigzag varint coordinates, an item or recipe id, a count). Connection events are about 9 bytes each.

| Play style | Actions per player-hour | Log per player-hour |
|---|---|---|
| Casual, one action per 4 s | 900 | 14 KB |
| Active, 1 per second sustained | 3,600 | 58 KB |
| Drag-building, 5 per second sustained | 18,000 | 180 KB |

4 players x 200 hours at the "active" rate is about 46 MB before compression, against browser quotas of 10 GiB or more. "Indefinitely" therefore needs no compaction. The rate limit caps the worst case at 20 x 3,600 x 10 B = 720 KB per player-hour.

## Alternatives rejected

- **Client-stamped ticks with a server-side input buffer** (Overwatch style). Needed for continuous input whose feel depends on which tick it lands on; discrete actions do not care, and it adds clock dilation feedback and an input delay.
- **Ordering by player id within a tick.** Only needed in peer lockstep with no arbiter; it gives low ids permanent priority in races.
- **Scheduling several ticks ahead** (lockstep "turns"). We are not lockstep: clients hold partial worlds and never simulate ticks, so no one needs the action before the host applies it.
- **Rejection as a separate message or channel.** It could arrive before or after the state it refers to and cause a visible flicker; riding the delta frame removes the race.
- **Logging only actions that `apply` accepted.** Impossible with write-ahead logging, and it would require a second, unchecked apply path for replay ([0001](0001-camera-and-presence.md)).
- **Logging admission rejections.** They depend on non-sim state and have no effect on the world.

## Consequences

- An action's latency to authority is at most one tick (50 ms at 20 Hz) plus the network; prediction hides it for the sender.
- Arrival order means the player with the lower latency wins a race. Accepted for co-op.
- `apply` runs in three places from one source, so its validation must be complete: the UI preventing an invalid action is a convenience, never the rule.
- The host asserts that a rejecting `apply` recorded no writes; enforcement by undo journal is deferred ([0003](0003-game-facing-api.md)).
- The rate limit is an engine default, overridable per game.
- Deferred to Phase 2: a typed fast path for continuous action streams, because no planned game has one ([0001](0001-camera-and-presence.md)); the log estimate above would then be dominated by that stream (288-576 KB per player-hour at 10-20 Hz, quantized).

## Sources

- [`../research/simulation.md`](../research/simulation.md) 3.3 (timing, pipeline), 3.9 (frame layout and growth table)
- [`../research/sync.md`](../research/sync.md) 3.7 (reconciliation loop), 3.10 (ack and deltas in one atomic frame), 3.11 (resend after reconnect)
- Spike: [`../../spikes/prediction-api/RESULT.md`](../../spikes/prediction-api/RESULT.md) (rejection race test: never a torn state; replay of a log that includes rejected actions reproduces the hash)
- Factorio, server as arbiter and "next tick" semantics: https://www.factorio.com/blog/post/fff-302
- Gambetta, client-side prediction and server reconciliation: https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html
- Overwatch netcode (input buffer, rejected alternative): https://www.gdcvault.com/play/1024001/-Overwatch-Gameplay-Architecture-and
