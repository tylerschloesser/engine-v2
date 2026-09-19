# 0001: The camera is not an action; presence and witness-carrying actions

Status: Accepted (2026-09-19)

## Context

Tyler's ruling (Fixed decisions in [`../spec/overview.md`](../spec/overview.md), Requirements in [`../spec/simulation.md`](../spec/simulation.md)): the camera never mutates the world and is not an action. The reference game nevertheless draws each player as a circle that springs after their camera, and only lets a player collect a resource that is in range ([`../spec/reference-game.md`](../spec/reference-game.md): "Player position is presence, not world state"). So the engine needs a way to show players to each other, and a way for a position-dependent rule to stay deterministic and replayable, without any camera-derived data entering the sim.

Why the ruling matters: if viewing cannot mutate, there is nothing to log, replay needs no camera stream, the log stays at the size in [0004](0004-action-timing-and-rejection.md), chunk materialization order (camera-driven, nondeterministic) cannot influence state ([0007](0007-world-model.md)), and the camera can run at display rate on the main thread with no round trip ([0019](0019-camera-input-and-overlay.md)).

## Decision

**Camera report.** The client reports its view to the host as a 16-byte `latest-wins` subscription message, sent on change, at most 10 Hz. It is not an action: never logged, never visible to `apply`/`tick`, absent from snapshots and hashes. The host derives the chunk set and look-ahead from the reported rect and velocity. Field layout, rings, clamps, look-ahead: [0010](0010-rates-and-subscriptions.md).

**Presence is an engine channel** for ephemeral, unlogged, per-player, game-defined data.

```rust
pub trait Presence: Codec + Copy + 'static {       // fixed size, at most 32 bytes encoded; `()` = no presence
    fn pos(&self) -> WorldPos;                     // Q24.8 (0007); picks recipients, feeds interpolation
    fn vel(&self) -> [i32; 2];                     // Q24.8 tiles per second; other fields take the newer sample
}
// reference game: PlayerPresence { pos: [i32; 2] /* Q24.8 */, vel: [i16; 2] }  = 12 bytes
```

- Producer: the game's client-side Rust writes `G::Presence` once per client frame from the camera block (the spring lives here, in ordinary floats, with variable `dt`; nothing depends on its bits). Hook signature: [0003](0003-game-facing-api.md).
- Uplink: the engine samples it at most 10 Hz while it changes, plus one final at-rest sample, in the same uplink batch as the camera report. Message class `latest-wins` ([0009](0009-transport-and-hosting.md)).
- Host: keeps the latest sample per player, stamped with the receive tick; checks it lies inside the world cap; relays it in the next frame to each client subscribed to the chunk containing `pos()`. Never queued: a slow client gets only the newest sample. On disconnect the host tells clients at once and drops the sample from relay.
- Remote rendering: samples go through the same interpolation buffer and code path as replicated entities (method and limits: [0012](0012-prediction-and-reconciliation.md)). Because sampling is on-change, a player at rest sends nothing; the host therefore re-relays each connected player's held sample at least once per second, so prolonged silence at a receiver means a stalled connection, never a stationary player.
- The host keeps each player's last sample in the host-side session table ([0013](0013-sessions-and-integrity.md)), outside the snapshot and the hash, so a returning player's camera can start where they were. The client also remembers its own camera locally.
- Presence is readable by exactly one game hook, `admit` (below). `apply`, `tick`, `WorldRead`, snapshots, the log and the state hash cannot reach it; the type system enforces this because `PresenceTable` is a parameter of `admit` only.

**Witness-carrying actions.** A rule that depends on non-sim data gets that data copied into the action:

```rust
Action::StartCollect { tile: TilePos, from: WorldPos }   // `from` = the client's own position when it pressed the button
Action::CancelCollect                                    // sent by the client when its spring leaves range
```

1. *Admission (host only, not replayed):* `G::admit` compares `from` with the player's latest presence sample and rejects an implausible claim. Reference game: reject if farther than 16 tiles from the sample or if no sample exists. The tolerance absorbs staleness of half an RTT plus one 100 ms sample interval.
2. *`apply` (host live, host replay, client prediction):* checks `dist(from, tile) <= RANGE` in integer fixed-point from the action's own bytes, together with the sim-state rules (resource exists, not already collecting).
3. "Panning out of range cancels a collect" (a Requirement) is a client-sent `CancelCollect`, an ordinary logged action. The sim never learns about movement any other way.

**Why "log only admitted actions, but `apply` re-validates on replay" is sound.** There are two kinds of check. Checks against *non-sim* state (presence, rate limits, connection) have inputs that are not in the log, so replay cannot re-run them; logging only what passed is sound if and only if the core never reads that state and everything the core needs from it travels inside the action as a witness. Both hold by construction above. Checks against *sim* state are deterministic, so re-running them in replay returns the same verdict at no cost, keeps one code path for live, replay and prediction (no `apply_unchecked` that runs only after crashes), and makes re-executing a log tail under new code safe ([0005](0005-persistence-and-recovery.md)). Write-ahead logging forces this anyway: a frame is logged before `apply` runs, so the log necessarily contains admitted actions that the sim then rejects, deterministically.

## Alternatives rejected

- **Camera as an engine-defined action.** Ruled out by Tyler. It would also put a 10 Hz stream in a log kept forever, make replay depend on where people looked, and tempt "only tick loaded chunks" rules through which viewing mutates the world.
- **Logged movement action sampled from the camera** (research option b). The camera re-enters the sim through a side door; movement becomes 90%+ of the log (288-576 KB per player-hour quantized, against 16-65 KB); the spring becomes deterministic sim code; and predicting a springy body needs tick-stamped inputs, a server-side input jitter buffer and error smoothing, none of which discrete actions need.
- **Range check at admission only, no witness.** An honest player who just arrived in range is refused because the host's presence lags; the rule cannot be unit-tested headlessly, replayed, or predicted with zero error.
- **Host-injected `CancelCollect` when presence leaves range.** Adds host-originated game actions as a concept; the client already knows the moment it leaves range.
- **Relay presence to every client regardless of viewport** (sync research 3.9). No recipient selection and cheap at 8 players, but it sends data nobody can see and conflates "who is here" with "who is near". Who is connected is the engine roster in the `Global` scope ([0011](0011-wire-format-and-deltas.md)), not presence.

## Consequences

- In a game built this way, sim rules can never depend on where a player is (no enemies that chase players). A game that needs that uses ordinary actions; nothing in the action pipeline forbids a continuous action stream.
- `admit` runs on the host only, so replay tests do not cover it; it needs its own unit tests ([0020](0020-testing-strategy.md)). A modified client can lie within the tolerance or never send `CancelCollect`; accepted under the trust model in `overview.md`.
- Replays show the world evolving without avatars.
- No sim-owned entity moves in the reference game. Remote interpolation is exercised through presence only, which shares the entity interpolation path; continuous prediction is not exercised (coverage: [0003](0003-game-facing-api.md)).
- Deferred to Phase 2: a fast typed input path and quantized delta encoding for continuous action streams, because no planned game needs them and they can be added without changing the log format.
- Deferred to Phase 2: recording presence as an optional non-authoritative replay track, because it is cosmetic.

## Sources

- [`../research/simulation.md`](../research/simulation.md) 3.12 (soundness analysis, witness pattern), 3.9 (log sizes)
- [`../research/sync.md`](../research/sync.md) 3.4 (subscription message), 3.9 (presence channel, cost of option b)
- [`../research/reference-game.md`](../research/reference-game.md) 1.1, 1.5 (closed-form spring: https://www.ryanjuckett.com/damped-springs/)
- [`../research/client.md`](../research/client.md) 3.6 (camera block read by the game's client Rust)
- Event sourcing's command/event split as used by SpacetimeDB: https://spacetimedb.com/docs/functions/reducers/reducer-context/
- Factorio latency state and server as arbiter: https://www.factorio.com/blog/post/fff-302
