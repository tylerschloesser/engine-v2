# 0022: Entity ids: monotonic, never reused, layout-free; predicted entities are addressed by tile

Status: Accepted (2026-09-19). Settles the entity-store and id-reuse item deferred in [0007](0007-world-model.md) and the provisional-id item deferred in [0012](0012-prediction-and-reconciliation.md), whose interim addressing rule it replaces (§6). Implemented in milestones M12, M21 and M25.

## Context

Two items were deferred to Phase 2 and depend on each other: provisional ids for predicted entities ([0012](0012-prediction-and-reconciliation.md), [0003](0003-game-facing-api.md) item 1) and the entity store layout with its `EntityId` reuse policy ([0007](0007-world-model.md) Consequences). The forces:

- The host allocates ids from a counter in sim state ([0007](0007-world-model.md) section 5), so a client that predicts a `spawn` cannot know the real id. The reference game places a furnace with a predicted action and may deposit into it before the ack arrives.
- The engine sees `G::Action` only as opaque `Codec` data ([0003](0003-game-facing-api.md)); the approved crate list has no derive macro that could walk it.
- Ids appear in snapshots, deltas, per-chunk hashes and (when a game puts one in an action) the log, so anything encoded in an id becomes part of a world's identity and must be identical in replay and in every runtime ([0002](0002-determinism-same-wasm-everywhere.md)). [0002](0002-determinism-same-wasm-everywhere.md) section 2 already warns that an arena's free list is hidden state that must be serialized.
- The host and the client replica mutate the same `Store` through the same `Store::apply` ([0011](0011-wire-format-and-deltas.md)); the replica holds a sparse subset of the host's ids.
- `EntityId` is `u32` and TS-facing types avoid `u64` ([0003](0003-game-facing-api.md)).

`spikes/prediction-api` addressed the furnace by tile and showed that a dependent pending action replays correctly across the ack of the action it depends on, with no game code.

## Decision

**1. Real ids.** `EntityId(u32)` is allocated only by the host's `WorldWrite::spawn`, from `next_entity_id` in sim state, starting at 1, **monotonic and never reused**. `0` is never allocated (it is "none"; it matches `pick_id == 0` in [0018](0018-renderer.md)). Bit 31 is never set on a real id, so a world has 2^31 − 2 ids. Ids are handed out in `spawn` call order, which is log order and then tick-rule order, so replay reproduces them.

**2. Exhaustion.** The per-action state-budget check of [0004](0004-action-timing-and-rejection.md) also rejects with `StateBudgetFull` when fewer ids remain than the entity count of `max_action_growth` ([0007](0007-world-model.md) section 8). A tick-rule `spawn` with no id left is an engine fault. At 1,000 spawns per second the space lasts 24 days of continuous ticking; widening the id is a schema change, not planned.

**3. Store layout is not state.** `Store.entities` is one ordered map keyed by `EntityId`, the same type on the host and in the replica: `BTreeMap<EntityId, G::Entity>` in v1. There is no slot, generation or free list, so nothing about the layout is serialized, hashed or sent, and the layout may later change (for example to a paged slab plus a sorted id index) without touching saves, wire or goldens; heavy mode and the golden hashes ([0002](0002-determinism-same-wasm-everywhere.md)) prove any such change invisible. The trigger to revisit is the slow-tier tick benchmark on the standard large save ([0020](0020-testing-strategy.md) section 9). `G::Entity` is a single type ([0003](0003-game-facing-api.md)), so there is one value store; "type-segregated" in [0007](0007-world-model.md) section 5 is read as the per-system active lists of its section 7. This supersedes the words "type-segregated stores" in that sentence and nothing else.

**4. What is hashed, logged and sent.** Hashed and snapshotted: `next_entity_id` (the "id counters" of [0005](0005-persistence-and-recovery.md)), then every entity as `(id, Codec bytes)` in ascending id order; a per-chunk hash ([0013](0013-sessions-and-integrity.md)) takes the entities anchored in that chunk in ascending id order. Logged: nothing new; an action may contain a real `EntityId` as ordinary game data. Sent: ids as LEB128 varints ([0011](0011-wire-format-and-deltas.md)); small monotonic ids keep them at 1–3 bytes. Never hashed, logged or sent: provisional ids and anything about store layout.

**5. Provisional ids are client-local.** `Predicting::spawn` returns an id with **bit 31 set**, derived from the pending action's `seq` and the spawn's index within that action, so it is identical on every reset-and-replay ([0012](0012-prediction-and-reconciliation.md)); the bit layout below bit 31 is private to the prediction module. A provisional id lives only inside one client-role instance: the overlay, `View`/`FrameView`, `Draw.pick_id`, and `G::Ui` JSON. The engine never encodes one. It is enforced without looking inside `G::Action`: `EntityId`'s `Deserialize` refuses a value with bit 31 set, so action JSON that carries one fails to parse at dispatch and is never sent, and a wire action that carries one is malformed ([0004](0004-action-timing-and-rejection.md) step 1). `Serialize` accepts it, because `Ui` may show one.

**6. Addressing rule (permanent; replaces the interim rule in [0012](0012-prediction-and-reconciliation.md)).** An action names anything its sender may have predicted **by tile**. `entity_at(tile)` resolves to the provisional id under `Predicting` and to the real id under `Authority`, so one handler serves both and a dependent action sent before the ack is valid on the host. An action may carry a real `EntityId` for anything else. The engine never rewrites or inspects `G::Action`. Consequently `Applied` ([0004](0004-action-timing-and-rejection.md)) carries nothing, `Confirmed` carries no id map ([0012](0012-prediction-and-reconciliation.md) step 2), and game client code keys animation or panel state that must survive the ghost-to-real swap by anchor tile.

**7. `entity(id)` on a client.** Because ids are never reused, a stale id can never alias another entity. A real id that the replica and overlay do not hold returns `Err(Unknown)` (the client cannot tell "despawned" from "outside my subscription", and under prediction both must decline). A provisional id not in the overlay returns `Ok(None)`: that namespace is the client's own. An overlay tombstone returns `Ok(None)`. The definitive existence question on a client is `entity_at(tile)` inside a subscribed chunk, which is what tile addressing already holds.

## Alternatives rejected

- **Host-side resolution of provisional ids** (the host keeps a per-player `(seq, spawn index) → real id` table and `EntityId`'s `Deserialize` resolves through a decode context). It needs no view into `G::Action`, but adds unlogged host state that must survive reconnect and panic recovery, a re-encode of every action before the write-ahead log, hidden deserializer state, and remap events for ids the UI already holds. It buys one thing: naming a tile-less entity within one RTT of one's own predicted spawn, which no planned game does. It stays additive, since a provisional id already encodes `(seq, index)`.
- **Client-side rewriting inside pending actions on ack.** Needs a visitor over `G::Action` (a proc-macro crate outside the approved list), and the bytes already sent cannot be rewritten, so the host would have to resolve ids anyway.
- **Client-derived real ids** `(player, seq, index)`. Do not fit `u32`; sparse ids cost 5 bytes per put instead of 1–3. A per-player counter that does fit mis-addresses: when the host rejects an earlier spawn, later predicted ids shift onto different entities.
- **Never predicting spawns.** Placement is the most latency-visible action in the genre, and the spike showed predicted placement converging with no visible change.
- **Generational index (slot + generation in the id).** Puts the store layout into ids and therefore into wire, snapshots and hashes; requires serializing the free list and every dead slot's generation; wraps (ABA) after 2^13 reuses at 2^18 slots; and the replica needs a keyed map regardless, so the only gain is an unmeasured O(1) host lookup.
- **Reusing freed ids (lowest-free-first).** A UI-held id or an in-flight action would silently address a different entity.

## Consequences

- Game authors get one rule: name buildings by tile in actions. The reference game's action shapes already do (`PRE-PLAN.md` section 4). Belt and inserter games fit: everything a player places occupies tiles.
- A player-spawned entity with no tile presence cannot be named by its spawner until the ack (under one RTT): an action carrying its provisional id fails at dispatch. Accepted; the first rejected alternative is the additive way out.
- `BTreeMap` lookups are O(log n); at the state budget that is about 18 comparisons. Accepted until the benchmark in decision 3 says otherwise.
- Owners: the store and `next_entity_id` land with `Store` (M12); the exhaustion clause lands with the state-budget check (M21); provisional ids, the `Deserialize` guard test and decision 7 land with prediction (M25).

## Sources

- [`../../spikes/prediction-api/RESULT.md`](../../spikes/prediction-api/RESULT.md) ("Entity ids under prediction", dependent-actions test, `entity(id)` note); `spikes/prediction-api/engine/src/lib.rs` (`EntityId::provisional`, `read_entity`, `read_entity_at`).
- [0002](0002-determinism-same-wasm-everywhere.md) section 2 (free lists as hidden state); [0005](0005-persistence-and-recovery.md) (snapshot contents); [0007](0007-world-model.md) sections 5, 7, 8.
