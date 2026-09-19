# 0013: Sessions and integrity

Status: Accepted (2026-09-19). Amended by [0024](0024-planning-amendments.md) §8.

## Context

Requirements in `docs/spec/sync.md` fix access control (a join key in the invite link plus a device-local identity secret, no cross-device recovery) and one world per server process. Accounts, lobbies, and matchmaking are non-goals (`docs/spec/overview.md`). iOS and Android drop sockets on every app switch, so reconnect is the common path, not an error flow. A tagless wire format ([0011](0011-wire-format-and-deltas.md)), bit-identical prediction ([0012](0012-prediction-and-reconciliation.md)), and client-side worldgen ([0008](0008-chunk-generation.md)) are only sound if both ends run the same build ([0002](0002-determinism-same-wasm-everywhere.md)). Patterns taken from Quake 3 ("baseline too old: send full state" as the resync rule), Gambetta (action sequence numbers monotonic across reconnects), and Colyseus (a grace period that holds the seat; rejected: its per-connection token, since ours must survive a page reload).

## Decision

**Identity.** On first run the client mints a 128-bit secret (`crypto.getRandomValues`) and keeps it in `localStorage`. The host keeps `SHA-256(secret) → PlayerId` (WebCrypto, present in every target runtime) in a host-side **session table** persisted through the injected storage, outside sim state; the log and the sim only ever see `PlayerId`. First sight of a secret is a join. **Join key:** an opaque shared secret from server config, carried in the invite link's URL fragment; `max_players` defaults to 8. Single-player uses the same path with an empty key.

**Handshake** (`reliable-ordered`, first message each way):

```
Hello   = [magic u32][protocol_version u16][build_hash [u8; 32]]     // frozen prefix: layout never changes
          join_key · player_secret [u8; 16] · CameraReport (0010)
          resume? = { epoch u32, last_tick u32, [(dx i16, dy i16, version u32)] ≤ 128 }   // chunk coords relative to the view centre
Welcome = { player_id, epoch, tick, tick_rate, world seed + params (0008), view clamps (0010),
            last_processed_action_seq (0004), last presence sample (0001) }
Reject  = [magic][protocol_version][reason u8: VersionMismatch | BadKey | Full][server build_hash]   // frozen
```

**Join is late join;** there is no other kind. After `Welcome` the host injects the logged connection event (`PlayerEvent::Joined` on first sight of a secret, then `Connected`; names and sequencing: [0003](0003-game-facing-api.md), [0004](0004-action-timing-and-rejection.md)); the first frames carry `Global` and `Player` snapshots and chunk enters, visible chunks first; the client reveals the world once its visible chunks are both received and locally generated.

**Reconnect is the same path plus the resume hint; the host keeps no per-session state.** For each chunk the new subscription wants: version equal ([0011](0011-wire-format-and-deltas.md)) → a 3-byte "keep"; different or absent → snapshot; held but unwanted → leave. `Global` and `Player` are always resent. `epoch` increments at every host start; a hint from another epoch is ignored, because a recovery that lost the log tail ([0005](0005-persistence-and-recovery.md)) can reuse tick numbers for different content. The client then resends pending actions with `seq > last_processed_action_seq`; that counter is per-player sim state rebuilt from the log ([0004](0004-action-timing-and-rejection.md)), so nothing is applied twice, including across a host restart. **Cost: one RTT plus ≤ ~1 KB up and typically ~1 KB down.** A page that iOS discarded reloads, presents the same secret, and takes the plain join path back to the same state.

**Client policy.** Dead after **3 s** without a frame (heartbeats arrive every 500 ms, [0010](0010-rates-and-subscriptions.md)) or on `close`. On `visibilitychange → visible` or `online`, probe at once with a 1 s deadline. Backoff 0, 0.5, 1, 2, 5 s (cap), jittered; the new socket opens before the old one is discarded. The game stays interactive on last known state; an indicator appears after 1 s; no modal and no error for outages under ~10 s.

**A disconnected player's state.** Presence vanishes from other clients at once. The logged `Disconnected` event is injected only after a **10 s grace**, so tab switches neither churn the log nor flicker the roster; an explicit `Bye` skips the grace. The game's handler decides consequences (reference game: cancel an in-progress collect; crafts and furnaces continue). Player state persists indefinitely under its `PlayerId`. The last presence sample is kept in the host-side session table (the `SHA-256(secret) → PlayerId` table above; [0001](0001-camera-and-presence.md)) so a returning player resumes where they were. The same secret in a second tab: newest wins; the old socket gets `Bye{Superseded}` and must not auto-reconnect.

**Build-hash handshake.** `build_hash` is the full SHA-256 of the exact `.wasm` bytes, emitted by the build into the client bundle and the server ([0017](0017-packaging-and-build.md)). `protocol_version` covers only the frozen prefixes. **Strict equality, no compatibility ranges.** On mismatch the host sends `Reject{VersionMismatch}` and closes; the engine raises an event whose default handler reloads the page **once** (guarded in `sessionStorage`), then shows "updating" and retries with backoff, which covers deploy skew between static hosting and the sim host in either order. A redeploy mid-session is therefore: sockets drop → reconnect → mismatch → reload → plain join with the same secret.

**World lifecycle.** One server instance hosts exactly one world. `createWorldServer` ([0009](0009-transport-and-hosting.md)) loads the newest snapshot and replays the log tail if storage holds a world, otherwise creates one from `WorldConfig.params` ([0005](0005-persistence-and-recovery.md)). Ticking stops when the last `Disconnected` is logged (unless `keepTickingWhenEmpty` is set); if nobody returns within **30 s** the host snapshots, flushes the log, and calls `onIdle`. Ticks are counted, never inferred from wall-clock, so a pause is invisible to replay. A new connection resumes the timer.

**Per-chunk desync hashes.** What can drift is the authoritative replica; prediction mismatches heal by design and are never hashed. Hash = the engine's 64-bit state hash over the chunk's canonical snapshot encoding (overlay plus entities anchored there; the chunk-enter encoder, so there is no second canonical form, and never a NaN per [0002](0002-determinism-same-wasm-everywhere.md)). The host piggybacks `{chunk, hash}` for **one subscribed chunk per 4 ticks**, recently modified first, then round-robin: ~60 B/s, a sweep of 35 chunks in 7 s and of 128 in ~26 s. `Global` and `Player` hashes every 5 s. The client hashes its replica (never the overlay) right after applying that frame, so both sides hash the same tick. On mismatch the client sends `ResyncChunk{coord}`, the host answers with a snapshot through the chunk bucket, and both sides record a desync report. Dev builds check every chunk every frame and dump both encodings ([0020](0020-testing-strategy.md)).

## Alternatives rejected

- **Server-minted tokens:** equal security without accounts, plus an issuance round trip and a second code path for single-player.
- **Seat reservation as the only reconnect path** (Colyseus): must also work after a page reload or a host restart.
- **Per-session resume state on the host:** lost on every restart, which on Durable Objects is routine.
- **Version compatibility ranges:** would force tags and evolution rules into the wire format and break bit-identical prediction.
- **Immediate `Disconnected`:** every screen lock would write two log records and cancel the player's collect.
- **Whole-world or overlay-inclusive hashes on clients:** clients do not hold the world, and predicted state differs by design.
- **Lobbies, world directories, or process spawning in the engine:** the deployer's problem, per Requirements.

## Consequences

- If the browser evicts `localStorage`, the player returns as a new player. Accepted per Requirements.
- The join key is the only gate; anyone holding the link can join until `max_players`.
- Games that cache their bundle in a service worker must make the mismatch reload bypass it.
- A host restart costs each client a full join (under 1 KB in wilderness, ~140 KB in a dense base on a phone) and whatever [0005](0005-persistence-and-recovery.md) defines as the loss window.
- Deferred to Phase 2: a "copy my player link" escape hatch for moving an identity between devices, because Tyler accepted no cross-device recovery for now.
- Deferred to Phase 2: measuring how iOS Safari reports a worker-owned socket after the tab resumes (prompt `close` vs. silence), because it needs a real phone and only tunes the 3 s timeout and the probe rule.

## Sources

- `docs/research/sync.md` sections 1.5, 2, 3.11–3.14; Requirements in `docs/spec/sync.md`, `docs/spec/simulation.md` (idle worlds), `docs/spec/reference-game.md` (returning player resumes in place).
- https://developer.apple.com/forums/thread/716118 (iOS suspends sockets of backgrounded pages) · https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ (restarts)
- https://fabiensanglard.net/quake3/network.php · https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html · https://docs.colyseus.io/room
