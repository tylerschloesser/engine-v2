# M12: `Game` trait, `Delta` and the `Store`

Status: done (2026-09-21) · After: 07, 08 · Tyler-dependent: no

Split: the original M12 exceeded the reading-list and size rules. This brief lands the data side (trait, deltas, store, hash). `12b-world-access-and-sim-driver.md` lands `WorldRead`/`WorldWrite`, `Authority`, `Ticks` conversions, the `Sim` driver and the golden-hash scenarios.

## Goal
The engine crate has the full `Game` trait of 0003, the engine-defined `Delta<G>`, and a `Store<G>` (tile overlays via M07, entities, players, global) whose only mutator is `Store::apply(&Delta<G>)`. The store encodes canonically and hashes with M05's state hash; a fixture game's types compile against the trait natively and for `wasm32`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0003-game-facing-api.md` (Decision: the trait block, "Deltas are engine-defined", "`Codec`"; Consequences item 7)
3. `docs/decisions/0011-wire-format-and-deltas.md` ("Deltas are the only write path", "Scopes")
4. `docs/decisions/0022-entity-ids-and-provisional-ids.md` (entity store layout, `EntityId` reuse)

Mine from spikes: `spikes/prediction-api/engine/src/lib.rs` (`Store`, `Store::apply`, `Delta`, `Scope`; replace its `BTreeMap` tiles with M07 overlays and its std `Hash` with `Codec` bytes). Rules that apply: `.claude/rules/determinism.md`.

## Scope
- `Game` trait with **every** associated item of 0003 Decision, so later milestones never touch fixture `impl Game` headers. Types this milestone cannot fill are declared as shells with no-op defaults: `TickCx<'_, G>` (M12b/M21b), `FrameCx`, `FrameView`, `DrawList` (M16b/M17/M18), `PresenceTable<G>` (M19), `OldStore` (M24b), `SaveIncompatible`, `PlayerEvent`, `Unknown`. `ClientSide<G>` and `Presence` get `impl .. for ()` so a fixture writes `type Client = (); type Presence = ();`. M09 already declared `ClientSide<G = ()>` for `tile_visual` (`crates/engine/src/client/texel.rs`) — extend that trait in place (add the `G: Game` bound, drop the `= ()` default, add the shell methods) rather than redeclaring it.
- `Tick(u32)`, `Ticks(u32)`, `TickRate` with `hz()` and `HZ_20` only (conversions: M12b). `PlayerId`, `EntityId` (per 0022 §1: `u32`, 0 = none, bit 31 never set on a real id; the `Deserialize` guard is M25).
- `Delta<G>` per 0011 plus the engine-internal `Roster` variant (Planning decisions).
- `Store<G>`: embeds M07's `TerrainStore` (overlays are its state half; the canonical-overlay rule stays M07's), entity store **per 0022 §3–4** (ordered map, `next_entity_id`, nothing about layout encoded), player table (`PlayerSlot { state, last_seq, online }`, ordered by `PlayerId`), `G::Global`, id counters. `Store::apply`, idempotent. Counts `entity_count()` and `modified_tile_count()` (the latter delegates to `TerrainStore::modified_tiles()`; M21 consumes both).
- Canonical encoding `Store::encode(&self, &mut impl ByteSink)` / `Store::decode(&mut ByteReader)` in the order 0005 "Snapshot" lists for the engine section (terrain through `TerrainStore::write_canonical`; timers and active lists are appended by M21b), and `impl StateHash for Store<G>` (M05).
- `SimRng` (0002 "Randomness" row: PCG32, integer range sampling, `fork`), unless M05 already landed it.
- Fixture crate `packages/engine/fixtures/puts/` (package `fx-puts`, M02 conventions): types only in this milestone (`Action`, `Reject`, `Entity`, `Player`, `Global`, `Ui = ()`); handlers arrive in M12b.

## Non-scope
`WorldRead`/`WorldWrite`, `Authority`, `View`, scope routing, `genesis`/`apply`/`tick` execution, `Ticks` conversions (M12b). Prototypes, footprints, occupancy (M21). Wire bytes of deltas (M14). Snapshots to storage (M22). No ABI export changes.

## Files, packages and crates touched
`packages/engine/crates/engine` (modules `game`, `delta`, `store`, `rng`, `time`), `packages/engine/fixtures/puts`.

## Seams
**Provides:** `Game`, `ClientSide`, `Presence`, `Unknown`, `PlayerEvent`, shells `TickCx`/`FrameCx`/`FrameView`/`DrawList`/`PresenceTable`/`OldStore`; `Tick`, `Ticks`, `TickRate::{hz, HZ_20}`; `PlayerId`, `EntityId`; `Delta<G>`; `Store<G>::{new, apply, encode, decode, state_hash, entity_count, modified_tile_count, player, entity, global, last_seq}`; `SimRng`; fixture `puts` types.
**Consumes:** M05 `Codec`, `ByteSink`/`ByteReader`, `StateHash`, `assert_golden_bytes!` + `pnpm golden:bytes`; M07 `Tile`, `TilePos`, `ChunkCoord`, `ChunkDims`, `TerrainStore`, `Registry`, `TraitSet`, `PrototypeId`, `Footprint`; M08 `Worldgen`, `Pristine<W>`; M09 `ClientSide<G>` and `TileTexel`: M09 landed this as `pub trait ClientSide<G = ()>` (not literally unbounded — a default of `()`, so a fixture can `impl ClientSide for Fixture {}` without naming `G`) with the one method `tile_visual`; this milestone adds the `G: Game` bound, `Game::Client` and the other methods as shells, **dropping M09's `= ()` default** (a defaulted, unconstrained `G` and a `G: Game` bound cannot coexist on the same parameter) — see Planning decisions. Also from M09 (`crates/engine/src/client/texel.rs`): `Registry::{base_visual, resource_visual}` getters and the free function `client::texel::install_visual_tables(&Registry)` (snapshots a filled `Registry` into the instance-wide visual-tables cell); M09's fixtures call `set_base_visual`/`set_resource_visual` then `install_visual_tables(&reg)` once — `Game::register`'s tail is where a real game does the same, so this milestone's `Game::register` shell should leave room for that call. M02 fixture conventions, `abi::Arena` counters for the no-alloc test.

## Planning decisions
- **Entity anchor (0024 §7).** 0003 replaced the spike's `footprint(e)` (origin + size) with `prototype(e) -> PrototypeId`, which carries no position, so the engine cannot derive scope or occupancy. 0024 §7 adds the required hook `fn anchor(e: &Self::Entity) -> TilePos` next to `prototype`. M12 declares it; M12b routes scope by it; M21 adds the footprint.
- **`Delta::Roster { who, online }` (0024 §8).** 0011 puts the engine roster in `Global` scope but its `Delta` enum has no variant for it. The roster changes only through logged connection events, so it is sim state: a sixth, engine-only variant keeps "`Store::apply` is the only mutator" true.
- **Missing player.** `Store::player(who)` for an id with no slot is the one host-side `Err(Unknown)`. M12b asserts a slot exists after `on_player(.., Joined)` with the message "on_player(Joined) must put_player".
- **`last_seq` lives in `PlayerSlot`**, because 0004 makes it sim state; it is encoded and hashed.
- **Shell types now, not later:** associated type defaults are unstable, so adding `type Ui` in M16b would break every fixture; declaring the full trait once is cheaper.

## Order of work
1. ids, `Tick`, `TickRate` minimal, `Unknown`, `PlayerEvent`, shells. 2. `Game` trait + `ClientSide`/`Presence` unit impls. 3. `Delta`. 4. `Store` + `apply`. 5. encode/decode/hash. 6. `SimRng`. 7. fixture types; build for native and `wasm32`.

## Tests added
Rust native: `store_apply_is_idempotent`; `store_roundtrip_bytes_equal` (encode → decode → encode); `store_hash_ignores_insertion_order`; `store_golden_bytes` (M05 pattern); `entity_id_policy_*` (cases named by 0022); `simrng_golden_sequence`; `puts_fixture_builds_wasm32` (import allowlist test from M02 picks the fixture up).

## Exit criteria
- [x] Every test above passes; the `puts` fixture appears in M02's allowlist test run.
- [x] `grep -r "HashMap" crates/engine/src/store*` is empty (ordered containers only, 0007 §2).
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t store` · `pnpm test rust -t simrng` · `pnpm test wasm -t allowlist` · `pnpm golden:bytes -- store` (only to bless new goldens) · `pnpm lint`.

## Budgets
None measured here. `Store` must not allocate in `apply` for an existing key with plain-data values (asserted with the counting allocator from the spike's `alloc.rs`, test `store_apply_existing_key_no_alloc`).

## Context artifacts
Update `packages/engine/crates/engine/CLAUDE.md` (module map: `game`, `delta`, `store`). `paths:` of `.claude/rules/determinism.md`: M02's `packages/engine/crates/**` already reaches the new modules; add a glob only if one of them falls outside it, and never one that matches no file (M01's `context-artifacts` test).

## Manual device checks
none

## Deviations

**M09/`ClientSide` fallout (the brief's own flagged risk, confirmed).** Extending `ClientSide<G>`
in place (add `G: Game` bound + `Default` supertrait, drop the `= ()` default) forces `Uploader<C:
ClientSide<G>, G>` (`client/upload.rs`) to drop its own `G = ()` default too, since `(): Game` does
not hold. That in turn breaks both of `ClientSide`'s pre-M12 implementors, because `Default` is a
hard requirement on *whichever type implements `ClientSide`*, independent of which `G` is chosen:
- `client/upload.rs`'s own `#[cfg(test)] struct Fixture;` -- trivially fixed with `#[derive(Default)]`
  plus a small local `NoGame`/`NoAllocGen`-style `Game` shim (never driven; every `Game` method
  either has a default or is `unimplemented!()`), since the test module had no `Game` type at hand.
- `fixtures/terrain`'s `FixtureTerrain` -- **not** trivially fixable the same way: `FixtureTerrain`
  is built from `Instance::init`'s role-specific arguments (`GenCore`/`TerrainStore`/etc.), so it
  has no sensible `Default`. Fixed by *not* using `FixtureTerrain` as `Uploader`'s `C` any more:
  added a separate unit struct `Vis` (`#[derive(Default)] struct Vis; impl ClientSide<NoGame> for
  Vis {}`, using the inherited default `tile_visual`, matching `FixtureTerrain`'s old trivial
  impl) plus a local `NoGame: Game` shim (`type Worldgen = FixtureTerrain`, reusing its existing
  `Worldgen` impl; every other associated type is `()`/a small `NoReject`; every required method
  `unimplemented!()`, since this fixture has no `Sim` role and never calls them). `uploader: Box<Uploader<FixtureTerrain>>`
  → `Box<Uploader<Vis, NoGame>>`; `Uploader::<FixtureTerrain>::new` → `Uploader::<Vis, NoGame>::new`.
  No public seam of either crate changed name or shape from the outside: `Uploader<C, G>`'s own
  generic *signature* is unchanged (`C: ClientSide<G>`), only `G`'s default was dropped and one
  fixture's internal type arguments changed. `ts-rs` (pre-approved, 0017 §7) is now an active
  dependency of `engine`, `fx-terrain` and `fx-puts` (for `Action`/`Reject`/`Ui`'s `TS` bound).
  Considered and rejected: giving `FixtureTerrain` itself a `Game` impl (it would still need
  `Default`, the actual blocker); splitting `tile_visual` into its own `Default`-free supertrait so
  `Uploader` never needs `G: Game` at all (technically cleaner, but renames `Uploader`'s own
  `Provides` signature from M09 -- out of scope for me to decide, flagged here for awareness, not
  applied).

**`Store` fields not covered by the Scope bullet, added for M12b.** `Store::terrain(&self) ->
&TerrainStore` (read access for the future `WorldRead` impl) and `Store::next_entity_id(&self) ->
u32` (M12b's `spawn` needs to know the next id before writing the `EntityPut` that advances it) and
`Store::player_slot(&self, PlayerId) -> Result<&PlayerSlot<G>, Unknown>` (the whole slot, not just
`state`) are additive accessors beyond the literal Provides list, not renames of anything.
`PlayerSlot<G>`'s fields (`state`, `last_seq`, `online`) are `pub`.

**`Store` does not hold `Tick`/`SimRng`.** 0005's "Snapshot" engine-section order lists `tick,
SimRng, player table, id counters, overlays, entities, active lists and timers`, but this
milestone's Goal names `Store` as "tile overlays, entities, players, global" only -- `tick` and
`SimRng` are the host driver's state (`Authority`, M12b), not `Store`'s. `Store::encode`/`decode`'s
own canonical order is therefore just the `Store`-owned subset, in 0005's relative order: **player
table, id counters, `Global`, terrain (`TerrainStore::write_canonical`), entities.** `Global`'s
placement (right after the player table, before terrain) is this milestone's own choice: 0005 does
not name where the single `Global` value sits, and it goes beside `Player` because 0011 "Scopes"
groups them ("`Global` and `Player` are small by construction and are sent in full on every
connect"). M22 is expected to interleave `tick`/`SimRng` around `Store`'s bytes when it assembles
the full snapshot.

**`PlayerId(pub u32)`.** 0003 only says "a small integer"; 0022 §1's `u32`/"0 = none" convention is
written for `EntityId`. Read `PlayerId, EntityId (per 0022 §1: u32, 0 = none, ...)` in the brief's
Scope bullet as applying that same shape to both for consistency (`Ord`, `Codec`, both `u32`) --
`PlayerId` has no provisional-id concept, so its bit-31 convention and the M25 `Deserialize` guard
are `EntityId`-only; nothing enforces "0 = none" for `PlayerId` in code yet (no test needs it).

**`Delta::Roster` with no player slot is a silent no-op**, not a panic (Planning decisions says
M12b's `on_player(Joined)` always `put_player`s first, so this should not occur in practice; `apply`
itself stays infallible and idempotent either way): `store::tests::roster_delta_is_a_noop_without_a_slot`.

**Entity `next_entity_id` derivation.** `Store::apply`'s `Delta::EntityPut` bumps `next_entity_id`
to `max(current, id + 1)` for *every* applied id, not only host-originated spawns (`apply` cannot
tell the difference). This is deterministic and idempotent under replay/reordering
(`entity_id_policy_next_entity_id_tracks_the_max_applied`), matching 0022 §1's "ids are handed out
in `spawn` call order, which is log order... so replay reproduces them": the counter only ever
needs to track the maximum id ever put.

**`SimRng` algorithm and pinned golden.** PCG32-XSH-RR (O'Neill 2014), 64-bit state, `below(bound)`
via the classic PCG threshold-rejection method, `fork(stream)` reseeds a child via two `next_u32`
draws. `simrng_golden_sequence` pins, for seed `0x5EED_1234_ABCD_0042`: `0xacf64617, 0x61de8173,
0xee0598b5, 0x8507040c, 0x61515ef0, 0xfb8e46aa, 0x28952f0b, 0xcea648b0` (computed from this exact
implementation, printed with `cargo test -p engine --lib rng::tests::simrng_golden_sequence --
--nocapture` and pinned here, same convention as `worldgen::tests::hash2_vectors`).

**`puts` fixture's `Action`/`Reject`/`Entity`/`Player`/`Global` shapes** (M12b may adjust; nothing
here is a fixed seam beyond "these types exist and are `Codec`/`TS`-compatible"): `Action` is
`SetTile { pos, base, resource } | Spawn { pos } | Despawn { id: u32 } | Deposit { id: u32, amount:
u16 } | SetGlobal { day: u32 }` over a plain `Pos { x: i32, y: i32 }` (not `engine::world::TilePos`,
which does not derive `TS`); `Reject` is `Unknown | NotFound` with `impl From<Unknown> for Reject`;
`Entity { amount: u16 }`, `Player { deposits: u32 }`, `Global { day: u32 }`. `fx-puts`'s `Instance`
is implemented directly (`init` only, every other role method `Status::Unsupported`), not through
`Game`/`export_game!`, since no handler exists yet; added a `fixtures/puts/CLAUDE.md` (not listed
in Context artifacts, but matches every sibling fixture directory's convention).

**Measured:** `pnpm test` — `rust` 145→168 (+23), `unit` 145 (unchanged), `wasm` 35→38 (+3, the
`puts` fixture's own allowlist/target-features/registry rows), `browser` 90 (unchanged). `pnpm
lint` green (biome, rustfmt, clippy, tsc). `grep -r "HashMap" crates/engine/src/store*` empty.
Commits `6681bd1`..`a0dca07` (six: five `M12 step N` plus one `M12:` CLAUDE.md context-artifact
commit).
