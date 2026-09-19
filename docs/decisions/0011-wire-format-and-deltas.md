# 0011: Wire format and deltas

Status: Accepted (2026-09-19)

## Context

`docs/spec/sync.md` asks for a binary encoding the client decodes without allocating, a way for game data to plug into it, delta mechanics over a reliable ordered stream ([0009](0009-transport-and-hosting.md)), chunk enter/leave, and state that is not chunk-shaped. Two facts from elsewhere shape the answer: every `WorldWrite` method is a whole-value put ([0003](0003-game-facing-api.md), proven by `spikes/prediction-api`), and clients regenerate pristine terrain themselves ([0008](0008-chunk-generation.md)). Patterns taken from Quake 3 (full state is a delta from nothing: one encoder), SpacetimeDB (subscribe = consistent initial state, then atomic updates), naia (entering scope sends full state, leaving sends a removal), and Factorio FFF-302 (keep messages absolute and self-contained; order-dependent relative encodings caused its megapacket bug).

## Decision

**Encoding.** Tagless, non-self-describing binary with no schema evolution; the build-hash handshake ([0013](0013-sessions-and-integrity.md)) guarantees both ends run the same `.wasm`. Engine framing is hand-written little-endian: fixed-width coordinates and ticks, LEB128 varints for ids, counts, and lengths, run-length runs for tile overlays. Game-typed values (`G::Action`, `G::Entity`, `G::Player`, `G::Global`, `G::Reject`, the presence payload) are `postcard` via `serde`, the same bytes used in the log ([0005](0005-persistence-and-recovery.md)). No `permessage-deflate`. Only the handshake prefix is layout-stable across builds.

**Frame** (host → client, one transport packet per frame):

```
[type u8][flags u8][tick u32][ack_seq u32]                  // 10 bytes; ack_seq = last action seq processed for this player (0004)
then sections, fixed order, each [section_id u8][len varint][bytes]:
  ActionResults · Global · OwnPlayer · ChunkEnterPristine · ChunkSnapshots · ChunkLeaves · ChunkDeltas · Presence* · Hashes
  (* latest-wins class; every other section is reliable-ordered)
```

A frame is applied **atomically**: the client applies every section before the next `extract`, so an action's ack and the deltas it caused are never seen apart ([0012](0012-prediction-and-reconciliation.md)).

**Decode path, no JS allocation.** The net worker copies each message's bytes into a SAB ring; the client worker copies them from the ring into a fixed receive region of its WASM memory and calls one export, `on_frame(ptr, len)` ([0014](0014-js-wasm-boundary.md), [0015](0015-threads-memory-and-topology.md)). Rust parses in place with a borrowing reader. No JS object exists per frame, section, or entity in the client worker. Allocation-free decode requires `G::Entity`, `G::Player`, and `G::Action` to be plain data (no `Vec`, `String`, or `Box`).

**Deltas are the only write path and are derived mechanically.** The engine, not the game, defines:

```rust
enum Delta<G: Game> {
    Tile { pos: TilePos, tile: Tile },              // 4-byte packed tile (0007)
    EntityPut { id: EntityId, entity: G::Entity },
    EntityGone { id: EntityId },
    Player { who: PlayerId, state: G::Player },
    Global { state: G::Global },                    // not in the spike; its put method belongs to 0003
}
```

Each `WorldWrite` put applies to the authoritative store, is recorded as one `Delta`, and is routed to a scope derived at write time from the tile position, the entity's footprint, or the player id. The client replica applies the same value through the same `Store::apply`. Games write no delta types, no `apply_delta`, and no encoders. A snapshot is the same puts emitted from empty; puts are idempotent, so an entity straddling two snapshotted chunks may arrive twice harmlessly.

**Scopes** (one mechanism: snapshot on subscribe, then puts):

| Scope | Audience | Holds |
|---|---|---|
| `Chunk(coord)` | subscribers of that chunk | tile overlay, entities whose footprint overlaps it |
| `Player(id)` | that player only | inventory, unlocks, timers in progress |
| `Global` | every connected client | engine roster (id, online flag) plus one game-defined value |
| `Presence` | per [0001](0001-camera-and-presence.md) | ephemeral samples; not sim state, never hashed or logged |

`Global` and `Player` are small by construction and are sent in full on every connect. An entity is delivered if *any* chunk under its footprint is subscribed, deduplicated by id; its anchor chunk owns it for hashing and persistence; a footprint may not exceed one chunk per axis. For entities that move between chunks, the engine emits full state on entering a client's subscription and `EntityGone` on leaving it.

**Chunk enter**, inside frame T: either an entry in `ChunkEnterPristine` (coordinate only, delta-coded, ~3 B: no overlay, no entities) or a snapshot `{coord, version, overlay runs, entity puts}` consistent as of the end of tick T; deltas for that chunk begin at T+1. The host never sends pristine tiles. **Chunk leave**: `{coord}`; the client frees that chunk's overlay and any entity no longer overlapping a subscribed chunk. The pristine terrain cache is separate and survives.

**Versions instead of acks.** On a reliable ordered stream the client has exactly what was sent, so there are no acks, baselines, or per-client snapshot history. The only bookkeeping is a **per-chunk version: the tick (u32) of the chunk's last replicated change**, stored with the chunk on both sides. It makes reconnect stateless ([0013](0013-sessions-and-integrity.md)). `last_received_tick` in the uplink ([0010](0010-rates-and-subscriptions.md)) exists only for backpressure. If a client's queued deltas for a chunk outgrow that chunk's snapshot, the host drops them and sends the snapshot.

## Alternatives rejected

- **Game-authored delta enums with `build_deltas`/`apply_delta`:** the spike showed they are unnecessary, and two mutation paths drift.
- **Engine-side field diffing by reflection** (bevy_replicon, naia, Colyseus schema): the engine would have to understand the game's data model.
- **Engine `WireWrite`/`WireRead` traits with a derive macro:** needs proc-macro crates outside the approved list; `postcard` is approved, tagless, and varint-packed already.
- **JSON, protobuf, or any tagged format:** allocation, size, and evolution that strict build equality makes pointless.
- **Decoding in JS with `DataView`:** per-entity JS work and objects on the client worker.
- **Quake-style acked baselines:** solve packet loss the transport already hides.
- **Client keeps a left chunk's overlay and revalidates by version on re-enter:** small saving once pristine terrain is local; hysteresis already covers the common case.

## Consequences

- Changing one field re-sends the whole value (a furnace is ~12 B plus id). Accepted at the budget in [0010](0010-rates-and-subscriptions.md).
- Any wire or data-model change is a build-hash change; there is no mixed-version operation.
- An overlay can arrive before the client's local generation of that chunk finishes; the replica stores overlays sparsely, independent of the terrain cache.
- `Global` scope, chunk leave, and all byte encoding were not built in the spike; the mechanism is the same puts, so the risk is low.
- Deferred to Phase 2: engine-side byte-diffing of old vs. new values at frame-build time, because it changes no game-facing API and should follow a measurement on a busy furnace field.
- Deferred to Phase 2: exact section ids, varint coordinate coding, and overlay run format, because they are implementation details fixed by the first encoder and its golden-bytes tests.

## Sources

- `docs/research/sync.md` sections 2, 3.2, 3.3, 3.5, 4; `spikes/prediction-api/RESULT.md` ("Can deltas be derived mechanically from writes?", `Delta<G>`).
- https://postcard.jamesmunns.com/wire-format (checked 2026-09-19: not self-describing, varint + zigzag, struct fields in order without names, stable since 1.0) · crate policy in Requirements, `docs/spec/runtime-and-packaging.md`.
- https://fabiensanglard.net/quake3/network.php · https://spacetimedb.com/docs/clients/subscriptions/ · https://github.com/naia-lib/naia · https://www.factorio.com/blog/post/fff-302 · https://gafferongames.com/post/snapshot_compression/
