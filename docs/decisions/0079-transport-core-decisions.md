# 0079: Transport core: decisions made while building it (M42)

Status: Accepted (2026-10-11). Amends [0076](0076-transport-lines-engine-game-split.md) §7 (the state hash covers the transport store once it has ever held a line) and §8 (the arena's real size and where it is reserved); settles the save behaviour 0076 Consequences assumed. Implemented by milestone 42 (`docs/plan/42-transport-core.md`); its Deviations hold the evidence.

## Context

Milestone 42 built `engine::transport` as sim state in `Store<G>` with the B1 run store of [0077](0077-transport-item-representation.md) A6. Building it moved six things the ADRs had stated or assumed: what the state hash covers, how runs are encoded, what a restored world must carry, how the host-tick-only rule is enforced, how much memory the arena takes and where, and what happens to a save written before the store existed. Each is a technical decision; this ADR records them so that `Store`, `persist` and the TypeScript loader agree with the text.

## Decision

**1. The state hash covers the transport store once the store has ever held a line.** `Store::encode` always writes the transport section (last, after the wake queue); `Store::hash_state` skips it while the store is pristine (`next_id == 1` and no line; `next_id` is encoded, so a restored world hashes like the live one). Every world that never creates a line keeps its pre-M42 hash: no fixture golden and not the reference game's `full-game.json` changed, which is the proof that milestone 42 changed nothing for a game without belts. Amends 0076 §7's "byte for byte": the section enters the hash with its first line and never leaves it (a store that destroyed every line still hashes it: `next_id` stays above 1).

**2. A later run's encoded distance is `gap + SPACING`**, the distance from the item ahead, not the in-memory free gap. With the free gap encoded no byte pattern could violate spacing and the codec's validation would have nothing to reject; with the distance encoded, decode rejects any `dist < SPACING` and any position past `len - 1` with `CodecError::Malformed` (pinned by `transport_codec_round_trip_and_rejects_spacing_violation`). The per-line record is `id, len, speed, out, sunk, jam, run_count, runs (item, count, dist)`, then `next_id` (`transport/codec.rs`).

**3. The jam cursor is encoded.** A re-walk from the front can merge a same-kind pair the cached skip leaves unmerged (a pair the `u16` count guard refused whose front run later shrank), so a restored world without the cursor would advance differently from the live one. The cursor is sim state; `touched` and the computed `jam()` summary are not.

**4. The host-tick-only rule is a phase flag.** `Authority` carries `in_genesis` and `in_tick` (set by `Sim::step` around `G::tick` only); `transport_mut()` is `Ok` when either is set and otherwise `Err(Unknown)` behind a `debug_assert!` naming 0076 §6, so it fires in `apply` and in `on_player`. `TickCx` answers `Ok` itself, `Migrating` answers `Ok`, `Predicting` marks the overlay and answers `Err(Unknown)` (`transport_in_apply_is_unknown`, `transport_predicting_is_unknown`, `transport_tick_and_genesis_are_ok`).

**5. The arena is reserved once, when the world params arrive, and it is 7 MiB at the defaults, not 4.** `Store::new` holds an empty store with no arena (a replica and a plain test store pay nothing); nothing is reserved until `set_transport_caps` applies `WorldParams::{max_lines, max_items}`, which every host genesis, restore, upgrade, migrate and test-replay path does exactly once (the review of milestone 42 found the defaults reserved first and the world's caps on top; fixed before the commit). A B1 run node is 16 B (an 8 B run plus two `u32` links), so 262,144 items are 4 MiB, lines about 2 MiB, scratch about 1 MiB: 7 MiB against 0076 §8's nominal 4 MiB. On the baseline phone that is most of 0007 §8's 8 MiB slack; the defaults stand until milestone 57 measures the phones, and a game without belts sets both caps to 0. The host's memory-split check (`Host::init`) must count the arena (milestone 42's follow-up), else the budget it enforces cannot trip for the biggest new allocation.

**6. A save written before the store existed is refused, not replayed.** `CONTAINER_VERSION` is 2. The Rust readers return `PersistError::ContainerVersion` (`snapshot_old_layout_is_incompatible`). The TypeScript loader had treated a container mismatch like a bad CRC and fallen back to a genesis replay of segment 0's log (`docs/architecture/persistence.md`, now superseded on this point), which would present a long-lived world as `recovered` at the state it had at the end of its first 4 MiB segment: silent partial loss. From milestone 42 a container mismatch is `WorldLoadError.kind = 'container'`, surfaced to the client as `save-incompatible`, every stored byte untouched. Tyler is told in the milestone report: existing reference-game saves refuse to load; there are no live players ([0076](0076-transport-lines-engine-game-split.md) Consequences); no migration is written.

**7. Two primitives moved forward; two hooks changed shape.** `insert_at`/`remove_at` (0076 §3, planned for milestone 43) exist from milestone 42 because six of the twenty rule cases need them; `destroy` is minimal until 43. `Line::jam()`/`Line::touched()` are `Transport::jam(line)` (computed on read from a `held` bit `advance` sets) and `Transport::touched(line)` (an epoch mark, no per-tick clearing pass); milestone 47 may change them when the tracker is built.

**8. A plain hand-off needs `target.len >= feeder.speed`.** An item at the feeder's front moves at most `speed` in one tick, so it lands at `target.len + p` with `p >= -speed`; a target shorter than the feeder's speed would put it below 0 (the review found the `u32` cast wrapping to a position of about 4.29 billion that decode later rejects, making the world's snapshots unrestorable). `set_out(a, Next(b))` and `set_speed` refuse the violation with `BadSpeed`, decode rejects a stored graph that has it, and milestone 43's `split`/`shrink`/`rescale` must refuse to shorten a target below its feeders' speeds. 0076 §1's `speed < len` is the within-line half of the same rule.

**9. Belt motion marks the world dirty.** `advance` returns whether anything changed and the host marks the world dirty on it, as it does for every write through `transport_mut`; before this, a world where only belts moved was never snapshotted ("every 1,200 ticks if dirty", and at pause only if dirty) and reloaded with its belts rewound.

**10. `insert_back` lands before the tick's move.** The landing `max(len - speed, tail + SPACING)` is the item's position before this tick's `advance` (which runs after `G::tick`, 0076 §2), so an item inserted at tick `T` sits at `len - 2 x speed` when `T` ends: it entered one tick's travel inside the back edge and then moved. A `Sink` line with `len < 2 x speed` sinks it the same tick, legal and conserved. Milestone 42's brief had stated the opposite ("sits at `len - speed` after this tick's move"); the spike and the production code agree with this section, and milestone 41's spawner replay on the client is built on it.

**11. A cut cycle moves every item once per tick.** The update order cuts a cycle at its lowest `LineId`, which advances first and whose front therefore lands on a line that has not advanced yet; the landed items are left in place by that line's advance (a per-line count of items landed from a not-yet-advanced source, cleared at the end of `advance`), so an item never moves twice in one tick and a belt loop runs at belt speed everywhere. Built in milestone 42 in about 40 lines, inside the early-exit path; pinned by `transport_cycle_cut_moves_every_item_exactly_speed` and the per-item reference test's own cut rule.

## Alternatives rejected

- **Hash the transport section always and regenerate every golden.** Honest but blind: a regenerated hash cannot show whether the sim behaviour of a non-belt world changed; the conditional hash keeps every existing golden as that proof.
- **Encode the free gap and skip decode validation.** A codec check that cannot fail is the defect 0069 §1 names.
- **Leave the fallback-to-genesis-replay for old saves.** A loss presented as a recovery.
- **Reserve the arena in `Store::new`.** Its signature has 18 callers and a replica would pay 7 MiB for nothing.
- **Clamp a too-far landing to 0** instead of refusing the layout (§8). A clamp hides a lost tick of travel; refusing at `set_out` names the layout that cannot work.
- **Let items crossing a cycle's cut move twice** (§11). A visible jump once per lap at one tile, for a layout (a belt loop) players build on purpose.
- **Shrink the node to 12 B** to meet the nominal 4 MiB. Not now: positions need `u32` gaps and links need `u32` indices; the phone measurement of milestone 57 decides whether the caps or the node change.

## Consequences

- `docs/architecture/persistence.md` (the container line), `world-and-worldgen.md` (the state-budget line names the two caps) and `simulation.md` ("The tick" names `advance`) are updated by milestone 42.
- Milestone 43's brief drops `insert_at`/`remove_at` from its scope; milestone 57 revisits §5's defaults on the phones; milestone 47 may replace §7's hooks.
- Trigger to revisit §1: a second subsystem wanting a conditional hash (then a general "present sections" rule replaces it).

## Sources

- Milestone 42's Deviations (`docs/plan/42-transport-core.md`), its tests under `crates/engine/tests/main/transport_*.rs` and `tests/no_alloc_transport.rs`.
- [0076](0076-transport-lines-engine-game-split.md) §6-§8, [0077](0077-transport-item-representation.md) A6/A6b, [0069](0069-working-rules-learned-in-phase-3.md) §1, §6.
