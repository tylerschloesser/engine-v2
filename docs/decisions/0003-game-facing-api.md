# 0003: The game-facing API

Status: Accepted (2026-09-19)

## Context

A game author writes Rust for data, worldgen, actions and tick rules, and TypeScript for bootstrapping and DOM UI ([`../spec/overview.md`](../spec/overview.md)). The same rules must run on the host, in replay, and on a client that holds only part of the world. `spikes/prediction-api` proved one shape for this in running code; this ADR reconciles it with the sketch in research and fixes what crosses into TypeScript. The main thread runs no WASM and the ABI passes numbers only ([0014](0014-js-wasm-boundary.md), [0015](0015-threads-memory-and-topology.md)).

## Decision

```rust
pub struct Unknown;                        // a read hit state this replica does not hold

pub trait Game: Sized + 'static {
    const SCHEMA_VERSION: u32;             // bump when a replicated type's layout changes (0005)
    const TICK_RATE: TickRate = TickRate::HZ_20;                       // 0006, 0010
    const CHUNK_BITS: u32 = 5;             // 4, 5 or 6: chunk edge 16, 32 or 64 tiles (0007)
    type Worldgen: Worldgen;               // pure per-chunk generator + its Params: defined in 0008, not here
    type Action:   Codec + TS;             // plain data: no Vec, String or Box (0011)
    type Reject:   Codec + TS + From<Unknown>;
    type Entity:   Codec + Clone + PartialEq;                          // replicated whole-value; plain data, no Vec
    type Player:   Codec + Clone + PartialEq;                          // private per-player state; plain data
    type Global:   Codec + Clone + PartialEq;                          // one value for every client; the engine roster rides the same scope (0011)
    type Presence: Presence;               // ephemeral, unlogged (0001); `()` if unused
    type Ui:       serde::Serialize + TS + PartialEq + Default;        // what the DOM overlay observes
    type Client:   ClientSide<Self>;       // per-client, never replicated, hashed or replayed

    fn register(r: &mut Registry);         // at init: trait tables + entity prototypes (TraitSet, footprint), 0007
    fn prototype(e: &Self::Entity) -> PrototypeId;     // engine derives occupancy and delta scope from it

    fn genesis(w: &mut dyn WorldWrite<Self>);          // once, at tick 0 of a new world
    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent); // Joined|Connected|Disconnected, logged
    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, a: &Self::Action) -> Result<(), Self::Reject>;
    fn predict(_a: &Self::Action) -> bool { true }     // per-action opt-out for actions that cascade (0012)
    fn tick(cx: &mut TickCx<Self>);        // HOST ONLY. TickCx is a WorldWrite: same recording write path
    fn admit(_w: &dyn WorldRead<Self>, _p: &PresenceTable<Self>, _who: PlayerId, _a: &Self::Action)
        -> Result<(), Self::Reject> { Ok(()) }         // HOST ONLY, never replayed (0001, 0004)
    fn migrate(_from_schema: u32, _old: &mut OldStore, _w: &mut dyn WorldWrite<Self>)
        -> Result<(), SaveIncompatible> { Err(SaveIncompatible) }          // 0005
}

pub trait WorldRead<G: Game> {             // object-safe
    fn tick(&self) -> Tick;                // under prediction: frozen per pending action (0012)
    fn tile(&self, p: TilePos) -> Result<Tile, Unknown>;               // total on the host; Unknown outside a client's subscription (0007)
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown>;      // provided
    fn entity_at(&self, p: TilePos) -> Result<Option<EntityId>, Unknown>;
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown>;
    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown>;
    fn global(&self) -> &G::Global;
}
pub trait WorldWrite<G: Game>: WorldRead<G> {          // every method is one whole-value put == one Delta
    fn set_tile(&mut self, p: TilePos, t: Tile);
    fn spawn(&mut self, e: G::Entity) -> EntityId;
    fn put_entity(&mut self, id: EntityId, e: G::Entity);
    fn despawn(&mut self, id: EntityId);
    fn put_player(&mut self, who: PlayerId, p: G::Player);
    fn put_global(&mut self, g: G::Global);
    fn rng(&mut self) -> Result<&mut SimRng, Unknown>; // host only; Unknown under prediction => NotPredictable
}
pub trait ClientSide<G: Game>: Default {               // client-role instance only; ordinary floats allowed
    fn frame(&mut self, cx: &mut FrameCx<G>, presence: &mut G::Presence); // reads the camera block (the spring) and input events; `cx.follow(..)` (0019)
    fn extract(&self, view: &FrameView<G>, out: &mut DrawList);        // 0018
    fn tile_visual(t: Tile) -> TileTexel { TileTexel::from_tables(t) }  // per tile on chunk load/patch, never per frame (0018)
    fn ui(&self, view: &FrameView<G>, out: &mut G::Ui);                // FrameView: WorldRead + clocks + presences
}
engine::export_game!(MyGame);              // emits the extern "C" exports for every role (0014)
```

- **Contexts.** The core sees the world only through `WorldRead`/`WorldWrite`. Three engine implementors: `Authority` (host; reads never `Unknown`; a write applies, records the delta, and derives its scope from footprint or player), `Predicting` (client; reads overlay then replica; writes go to the overlay), and read-only `View` (renderer, `ui`, and shared rule helpers such as `can_place(&dyn WorldRead, ..)`). `TickCx` is `Authority` plus iteration over active entities ([0007](0007-world-model.md)). `dyn` is deliberate: handlers compile once; it relies on trait-object upcasting (stable since Rust 1.86).
- **Deltas are engine-defined** and the puts cover every replicated scope of [0011](0011-wire-format-and-deltas.md): `set_tile`/`spawn`/`put_entity`/`despawn` are chunk-scoped, `put_player` is private to that player, `put_global` goes to everyone (presence is not a put: [0001](0001-camera-and-presence.md)). Games write no delta types, no `apply_delta`, no second per-action prediction rule (`Game::predict` above is only an opt-out flag), no `save`/`load`: the engine serializes its `Store`, whose only mutator is "apply a delta" ([0011](0011-wire-format-and-deltas.md), [0005](0005-persistence-and-recovery.md)). The author's rules: validate first, write after; copy-modify-put; add a `?` to each read and `impl From<Unknown> for Reject`.
- **Outside the deterministic core**, unreachable from `apply`/`tick`, unsnapshotted, unhashed: subscriptions and camera reports, presence, the session table, pacing, storage, `admit`, and everything in `ClientSide`.
- **`Codec`** = `serde::Serialize + DeserializeOwned` encoded with postcard, floats canonicalized ([0002](0002-determinism-same-wasm-everywhere.md)); every game-typed value on the wire, in the log and in snapshots is these bytes ([0011](0011-wire-format-and-deltas.md)). Action `seq` is `u32` ([0004](0004-action-timing-and-rejection.md)). `Tick` and `EntityId` are `u32`; `PlayerId` is a small integer assigned at first join (token mapping: [0013](0013-sessions-and-integrity.md)); TS-facing types avoid `u64` (JSON has no `bigint`).
- **TypeScript types**: `#[derive(TS)]` (`ts-rs`, build-time only) on `Worldgen::Params`, `Action`, `Reject`, `Ui`; a native `cargo test` step wrapped by the engine's build tooling writes `bindings/*.ts` into the game package ([0017](0017-packaging-and-build.md)).
- **Actions across the boundary.** `client.dispatch(action: Action): number` (returns `seq`) JSON-encodes the typed object as UTF-8 into a SAB ring. `client` is the object returned by `createClient` ([0017](0017-packaging-and-build.md)); its camera, input and overlay members are in [0019](0019-camera-input-and-overlay.md). The main-thread entrypoint assigns `seq` itself, from a counter seeded by `Welcome.last_processed_action_seq` ([0013](0013-sessions-and-integrity.md)) and never reset while the page lives, and writes it into the ring record; that is what lets `dispatch` return it synchronously although the worker is a ring away ([0004](0004-action-timing-and-rejection.md)). The client-role WASM parses it into `G::Action`, runs prediction, and emits the postcard bytes used on the wire and in the log. The host never sees JSON. This adds one runtime crate beyond the approved `serde` + `postcard`: **`serde_json` 1.x, `default-features = false, features = ["alloc"]`** (1.0.151, 2026-07-20; by serde's author; runtime deps `itoa`, `memchr`, `zmij`, `serde`). Justification: `ts-rs` emits types, not encoders; JSON is the only encoding the main thread produces natively, and `serde_json` follows exactly the serde attributes `ts-rs` reads, so the TS type and the parser cannot disagree. It runs only on UI-driven paths, which are exempt from the zero-allocation rule ([0016](0016-zero-gc-definition.md)).
- **How the UI observes state.** When the replica or overlay changes, the engine calls `ClientSide::ui` into a reused `G::Ui`; if it differs from the previous value (`PartialEq`), the engine writes its JSON to a SAB ring and bumps a version counter. The main-thread entrypoint polls the counter in rAF and calls `client.onUi((ui: Ui) => ..)` only on change: no garbage while nothing changes, one parse per change. Per-frame values never travel this way: anchors come from an engine-filled `Float32Array` ([0019](0019-camera-input-and-overlay.md)); progress bars are derived from a `done_at` tick in `Ui` and `client.clock()` (authoritative tick, predicted tick, ticks per second). Action outcomes arrive via `client.onActionResult(seq, Confirmed | Rejected(reason))`; a declined prediction is reported as `NotPredictable` at dispatch ([0012](0012-prediction-and-reconciliation.md)).

## Alternatives rejected

- **Generated TypeScript postcard encoders** (no JSON crate). A codegen project that must reproduce postcard's varint, zigzag and enum-index rules for every serde shape and attribute, with a silent-corruption failure mode, to save a parse at human input rate. It can be added later without touching wire or log, since JSON never leaves the client.
- **`serde-json-core`** (no-alloc, 0.6.0, last release 2024-08): fixed-capacity `heapless` types leak into `G::Action`, and the zero-allocation property is not needed on this path.
- **tsify / wasm-bindgen object passing**: needs wasm-bindgen's allocating ABI ([0014](0014-js-wasm-boundary.md)). **Schema-first IDL**: Rust stops being the source of truth. **Hand-written TS types**: drift.
- **Game-written `Protocol::{build_deltas, apply_delta, predict}` and `SimState::{save, load}`** (research sketch): the spike showed all five are derivable once writes are whole-value puts; two implementations of each rule would drift.
- **Per-tile `pristine()` and per-call `tile_traits`/`entity_traits`/`footprint` functions** (the spike's shape): replaced by the per-chunk `Worldgen` of [0008](0008-chunk-generation.md) and the registered tables of [0007](0007-world-model.md), which avoid a call per tile.
- **One `WorldAccess` trait**: the read/write split lets UI and ghost checks share rule code through a read-only view.
- **A fixed-layout UI-state block with generated accessors** (client research): needs a layout generator that `ts-rs` does not provide; revisit only if profiling shows `Ui` JSON at state-change rate matters.

## Consequences

- Whole-value puts cost bandwidth (one changed furnace field resends 12 bytes). Entities must be plain data or copy-modify-put allocates.
- The spike was native, std-only, with no byte encoding; `Global`, `rng`, `predict`, `admit`, `ClientSide` and `migrate` were not exercised by it and are first built in Phase 3.
- **Reference-game feature coverage** (closes the item in [`../spec/reference-game.md`](../spec/reference-game.md)): gameplay covers worldgen, streaming, tile overlays (depletion), trait queries, engine and game actions, prediction and rollback of discrete actions, presence, per-player, global (roster) and off-screen state, persistence, anchoring, picking, ghost, time units, reconnect. Reached only by luck, so pinned by scripted tests rather than new mechanics ([0020](0020-testing-strategy.md)): a furnace spanning a chunk border; rejection races (last unit, same spot, same ingots); an action at the subscription edge (`NotPredictable`); the state budget when full ([0007](0007-world-model.md)); panic recovery, `SaveIncompatible`, export/import ([0005](0005-persistence-and-recovery.md)). Keyboard focus is covered by an engine test page. Accepted gaps: no sim-owned moving entity and no continuous prediction ([0001](0001-camera-and-presence.md)).
- Deferred to Phase 2 (the spike's open problems; each needs a design choice the spike did not make): (1) provisional ids for predicted entities: address by stable key (tile, as the spike did) or engine-side id rewriting; (2) a `NotPredictable` pending action makes later pending actions mispredict: likely taint all later ones; (3) the renderer needs a per-frame overlay change list and a "predicted" flag, since the overlay is rebuilt every frame; (4) host-side atomicity of `apply` is only asserted: enforcing it needs an undo journal; (5) the own-timer completion gap of one RTT; (6) iterating/range reads through an object-safe trait; (7) the exact `TickCx`, `FrameCx`, `FrameView` and `OldStore` shapes; (8) `entity(id)` cannot tell "gone" from "unsubscribed" on a client.

## Sources

- Spike: [`../../spikes/prediction-api/RESULT.md`](../../spikes/prediction-api/RESULT.md) (signatures, 10 tests, 0 allocations over 190 replay frames x 4 pending actions)
- [`../research/simulation.md`](../research/simulation.md) 3.1, 1.4, 1.5; [`../research/sync.md`](../research/sync.md) 3.5-3.7; [`../research/client.md`](../research/client.md) 3.5, 3.6, 4; [`../research/reference-game.md`](../research/reference-game.md) 3.2
- ts-rs 12.0.1: https://lib.rs/crates/ts-rs ; serde_json: https://crates.io/crates/serde_json ; serde-json-core: https://crates.io/crates/serde-json-core ; postcard wire format: https://postcard.jamesmunns.com/ (all checked 2026-09-19)
- Prior art: GGRS https://docs.rs/ggrs/latest/ggrs/ ; lightyear https://docs.rs/lightyear/latest/lightyear/ ; bevy_replicon https://docs.rs/bevy_replicon/latest/bevy_replicon/
