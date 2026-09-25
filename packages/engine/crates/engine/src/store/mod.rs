//! `Store<G>` (docs/decisions/0011-wire-format-and-deltas.md, 0022 §3-4, 0005 "Snapshot"): the
//! replicated state both the host and every client replica hold, mutated only by
//! [`Store::apply`]. Tile overlays are M07's `TerrainStore`; entities and players are ordered maps
//! keyed by id (0022 §3: "the same type on the host and in the replica", no reused ids, no layout
//! encoded); `Global` is one game-defined value plus the engine roster's online bits (0011,
//! `Delta::Roster`, 0024 §8).
//!
//! Canonical order (docs/plan/12-store-and-game-trait.md Scope "in the order 0005 'Snapshot'
//! lists for the engine section"): player table, id counters, `Global`, terrain
//! (`TerrainStore::write_canonical`), entities. `Tick` and `SimRng` are not fields here -- 0005's
//! engine section lists them before the player table, but they are the host driver's state
//! (`Authority`, M12b), not the replicated `Store` the Goal of this milestone names ("tile
//! overlays, entities, players, global"); M22 stitches the full snapshot together. Placing
//! `Global` is this module's own choice, recorded in docs/plan/12-store-and-game-trait.md
//! Deviations: 0005 does not name where the single `Global` value sits among "player table, id
//! counters, overlays, entities", so it goes beside the player table it is broadcast alongside
//! (0011 "Scopes": `Global` and `Player` are both "sent in full on every connect").

mod index;

use std::collections::BTreeMap;

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::{Codec, CodecError, decode_canonical, encode_to, encoded_len};
use crate::delta::Delta;
use crate::game::{EntityId, Game, PlayerId, Unknown};
use crate::hash::{Fnv64, StateHash};
use crate::world::{ChunkCoord, ChunkDims, Footprint, Registry, TerrainStore, TilePos, TileRect};

use index::ChunkIndex;

/// The chunks (and each chunk-local tile index) a footprint anchored at `anchor` overlaps, under
/// `dims` (0007 §5: at most 4, since `Registry::add_prototype` asserts footprint <= chunk edge).
/// Always driven by the `Store`'s own `TerrainStore::dims()` rather than a separately derived
/// `ChunkDims::new(G::CHUNK_BITS)` (docs/plan/21-entities-and-timers.md Deviations "One dims,
/// always the terrain's own"): a handful of this crate's own pre-M21 unit tests build a
/// `TerrainStore` at a different `ChunkDims` than their test `Game::CHUNK_BITS` default, which
/// never mattered before `ChunkIndex`'s fixed-size bitset existed to index out of bounds over it.
fn footprint_tiles(
    dims: ChunkDims,
    anchor: TilePos,
    footprint: Footprint,
    mut f: impl FnMut(ChunkCoord, u16),
) {
    for dy in 0..footprint.h as i32 {
        for dx in 0..footprint.w as i32 {
            let pos = TilePos::new(anchor.x + dx, anchor.y + dy);
            f(dims.chunk_of(pos), dims.local_index(pos));
        }
    }
}

/// The inclusive tile rectangle a footprint anchored at `anchor` covers (min corner = anchor,
/// 0007 §5). Shared by `Store::entities_in` (footprint/rect intersection) and
/// `Authority::entity_scopes` (M21 widening: every overlapped chunk, not just the anchor's).
pub(crate) fn footprint_rect(anchor: TilePos, footprint: Footprint) -> TileRect {
    TileRect::new(
        anchor,
        TilePos::new(
            anchor.x + footprint.w as i32 - 1,
            anchor.y + footprint.h as i32 - 1,
        ),
    )
}

/// One player's replicated state (docs/plan/12-store-and-game-trait.md Planning decisions):
/// `last_seq` is sim state (0004) and `online` is the engine roster bit (`Delta::Roster`, 0024
/// §8), so both are encoded and hashed alongside the game-defined `state`.
pub struct PlayerSlot<G: Game> {
    pub state: G::Player,
    pub last_seq: u32,
    pub online: bool,
}

/// The replicated state (Goal of docs/plan/12-store-and-game-trait.md): tile overlays, entities,
/// players, global. `Store::apply` is its only mutator, on both the host and every client replica
/// (0011).
pub struct Store<G: Game> {
    terrain: TerrainStore,
    entities: BTreeMap<EntityId, G::Entity>,
    /// 0022 §1: entity ids are allocated only by the host's `spawn` (M12b), starting at 1,
    /// monotonic, never reused. `apply` keeps this field correct without knowing which
    /// `EntityPut`s were fresh spawns: it is always `max(current, id + 1)` over every applied id,
    /// which is idempotent and order-independent, like every other effect of `apply` (0022 §3:
    /// "nothing about layout encoded" -- this is the one counter that *is* state).
    next_entity_id: u32,
    players: BTreeMap<PlayerId, PlayerSlot<G>>,
    global: G::Global,
    /// Trait tables + entity prototypes (0007 §6, §5), built once by `Game::register` at
    /// construction (M21, docs/plan/21-entities-and-timers.md Deviations: moved here from
    /// `Authority`/`Replica`, which each built and held their own copy before this milestone, so
    /// `Store::apply` can consult footprints for `ChunkIndex` maintenance without `apply`'s own
    /// signature growing a `&Registry` parameter -- a `Provides`-changing rename this milestone
    /// does not make). Never encoded or hashed: derived from `G::register`, identical on every
    /// build (0007 §6's own "the same tables exist in the client-role instance").
    registry: Registry,
    /// 0007 §5: derived from `entities`, rebuilt on load (`Store::rebuild_indexes`); never encoded
    /// or hashed. Only chunks with at least one overlapping entity have an entry.
    chunk_index: BTreeMap<ChunkCoord, ChunkIndex>,
    /// Diagnostic only (Budgets: "occupancy maintenance is O(footprint), asserted by a counter
    /// `index_ops_per_put <= footprint area + 4`"): bumped once per `ChunkIndex::add`/`remove`
    /// call, i.e. once per covered tile, by `Store::add_to_index`/`remove_from_index`. Never
    /// encoded, hashed, or reset automatically; a test reads the delta across one put.
    index_ops: u64,
}

/// Length-prefixed `Codec` value: a varint byte count, then the value's canonical bytes. Lets
/// [`Store::write_canonical`] and [`Store::decode`] embed a game-typed value inside the engine's
/// hand-written framing without knowing its width up front (mirrors `TerrainStore`'s own
/// length-prefixed overlay entries).
fn write_sized<T: Codec>(value: &T, sink: &mut impl ByteSink) {
    sink.put_varint(encoded_len(value) as u64);
    encode_to(value, sink).expect("encoding into a ByteSink cannot fail");
}

/// The other half of [`write_sized`]. Goes through [`decode_canonical`]
/// (`.claude/rules/determinism.md`: "untrusted bytes go through `codec::decode_canonical`, never
/// plain `decode`") since a `Store` may be decoded from a snapshot on disk.
fn read_sized<T: Codec>(reader: &mut ByteReader) -> Result<T, CodecError> {
    let len = reader.varint()? as usize;
    let bytes = reader.bytes(len)?;
    decode_canonical(bytes)
}

impl<G: Game> Store<G> {
    /// `terrain` is already constructed (dims, pristine source, cache capacity: M07/M08 own that);
    /// `global` is the value before `Game::genesis` runs (M12b), since `G::Global` has no `Default`
    /// bound (0003).
    pub fn new(terrain: TerrainStore, global: G::Global) -> Self {
        let mut registry = Registry::new();
        registry.set_chunk_edge(terrain.dims().edge());
        G::register(&mut registry);
        Store {
            terrain,
            entities: BTreeMap::new(),
            next_entity_id: 1,
            players: BTreeMap::new(),
            global,
            registry,
            chunk_index: BTreeMap::new(),
            index_ops: 0,
        }
    }

    /// The only mutator of replicated state, on both sides of the wire (0011). Idempotent:
    /// applying the same `Delta` again leaves the store exactly as it was (`store_apply_is_
    /// idempotent`).
    pub fn apply(&mut self, d: &Delta<G>) {
        match d {
            Delta::Tile { pos, tile } => {
                let _ = self.terrain.set_tile(*pos, *tile);
            }
            Delta::EntityPut { id, entity } => {
                let old_info: Option<(TilePos, Footprint)> = match self.entities.get(id) {
                    Some(old) => Some((G::anchor(old), self.registry.footprint(G::prototype(old)))),
                    None => None,
                };
                if let Some((old_anchor, old_fp)) = old_info {
                    self.remove_from_index(*id, old_anchor, old_fp);
                }
                let new_anchor = G::anchor(entity);
                let new_fp = self.registry.footprint(G::prototype(entity));
                self.entities.insert(*id, entity.clone());
                self.next_entity_id = self.next_entity_id.max(id.0.wrapping_add(1));
                self.add_to_index(*id, new_anchor, new_fp);
            }
            Delta::EntityGone { id } => {
                if let Some(old) = self.entities.remove(id) {
                    let old_anchor = G::anchor(&old);
                    let old_fp = self.registry.footprint(G::prototype(&old));
                    self.remove_from_index(*id, old_anchor, old_fp);
                }
            }
            Delta::Player { who, state } => match self.players.get_mut(who) {
                Some(slot) => slot.state = state.clone(),
                None => {
                    self.players.insert(
                        *who,
                        PlayerSlot {
                            state: state.clone(),
                            last_seq: 0,
                            online: false,
                        },
                    );
                }
            },
            Delta::Global { state } => {
                self.global = state.clone();
            }
            Delta::Roster { who, online } => {
                // No slot: 0024 §8's roster changes only through logged connection events, and
                // `on_player(.., Joined)` always `put_player`s first (docs/plan/12-store-and-
                // game-trait.md Planning decisions -- M12b asserts this), so a missing slot here
                // means the event stream itself is malformed. `apply` never fails (0003: it is
                // infallible, unlike `Game::apply`), so this is a harmless, idempotent no-op
                // rather than a panic.
                if let Some(slot) = self.players.get_mut(who) {
                    slot.online = *online;
                }
            }
            Delta::Ack { who, seq } => {
                // Same no-slot convention as `Roster` (docs/plan/12b-world-access-and-sim-
                // driver.md Deviations): `apply` never fails, so a missing slot is a harmless,
                // idempotent no-op rather than a panic.
                if let Some(slot) = self.players.get_mut(who) {
                    slot.last_seq = *seq;
                }
            }
        }
    }

    /// Read access to the embedded terrain (M07): `WorldRead::tile`/`traits_at` (M12b) read
    /// through this; writes go through [`Store::apply`] only.
    pub fn terrain(&self) -> &TerrainStore {
        &self.terrain
    }

    /// Mutable terrain access, additive beyond [`Store::apply`] (docs/plan/
    /// 15-connection-and-subscriptions.md Deviations): a client replica applies a chunk snapshot
    /// or leave through `TerrainStore::{replace_overlay, clear_overlay}` directly, and a
    /// `ChunkDeltas` tile through `TerrainStore::set_tile` -- none of these is a `Delta<G>` variant
    /// (a snapshot/leave is 0011's own mechanism, distinct from the puts a `Delta` records), so
    /// `Store::apply` is not the seam for them. Every *replicated* (`Delta`-carried) mutation still
    /// goes only through `Store::apply` on both sides of the wire, exactly as before.
    pub fn terrain_mut(&mut self) -> &mut TerrainStore {
        &mut self.terrain
    }

    pub fn entity_count(&self) -> u32 {
        self.entities.len() as u32
    }

    /// Delegates to `TerrainStore::modified_tiles` (M21 consumes both counts against the state
    /// budget, 0007 §8).
    pub fn modified_tile_count(&self) -> u32 {
        self.terrain.modified_tiles()
    }

    /// The next id `WorldWrite::spawn` (M12b) would allocate.
    pub fn next_entity_id(&self) -> u32 {
        self.next_entity_id
    }

    pub fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown> {
        self.players.get(&who).map(|s| &s.state).ok_or(Unknown)
    }

    /// The whole slot (state, `last_seq`, `online`): `WorldRead::player` (M12b) only needs
    /// `state`, but the host's ack/roster paths need the rest.
    pub fn player_slot(&self, who: PlayerId) -> Result<&PlayerSlot<G>, Unknown> {
        self.players.get(&who).ok_or(Unknown)
    }

    /// `TickCx::player_count` (M12b): the player table's size, for index-based iteration (Planning
    /// decisions of docs/plan/12b-world-access-and-sim-driver.md: "index-based so rules can write
    /// while iterating").
    pub fn player_count(&self) -> usize {
        self.players.len()
    }

    /// `TickCx::player_id_at` (M12b): the `i`th player in ascending `PlayerId` order (`BTreeMap`'s
    /// own iteration order, matching 0022 §1's `Ord`). The player table holds tens of rows
    /// (Planning decisions: "no wheel... `tick` scans it"), so this linear scan is not a budget
    /// concern.
    pub fn player_id_at(&self, i: usize) -> Option<PlayerId> {
        self.players.keys().nth(i).copied()
    }

    pub fn entity(&self, id: EntityId) -> Option<&G::Entity> {
        self.entities.get(&id)
    }

    /// Every entity in ascending id order (`BTreeMap`'s own iteration order, 0022 §1's `Ord`).
    /// Additive accessor beyond M12's own Provides list, like `terrain()`/`next_entity_id()`
    /// (docs/plan/12-store-and-game-trait.md Deviations): nothing needed to enumerate every entity
    /// before `wire::encode_chunk_snapshot` (M14), which scans them to find those anchored to one
    /// chunk.
    pub fn entities(&self) -> impl Iterator<Item = (EntityId, &G::Entity)> + '_ {
        self.entities.iter().map(|(&id, e)| (id, e))
    }

    /// The entity table itself, ascending `EntityId` order (docs/plan/17-drawlist-and-sprites.md
    /// Seams: `FrameView::entities()`/`EntityIter` need a concrete, nameable iterator type over a
    /// borrow that outlives one method call -- `Self::entities`'s `impl Iterator` return cannot be
    /// named as a struct field, so `client::frame_view::EntityIter` wraps `BTreeMap::iter` taken
    /// straight from here instead of re-deriving it from the opaque iterator above.
    pub(crate) fn entities_map(&self) -> &BTreeMap<EntityId, G::Entity> {
        &self.entities
    }

    /// The trait tables + prototype table `Game::register` filled at construction (M21): every
    /// `WorldRead` implementor's `traits_at`/`entities_in` reads through this instead of holding a
    /// second copy (docs/plan/21-entities-and-timers.md Deviations "moved here from Authority/
    /// Replica").
    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// Adds `id`'s footprint (anchored at `anchor`) to every overlapped chunk's [`ChunkIndex`],
    /// creating an index for a chunk that had none. `pub(crate)`: `Store::apply` is the only
    /// production caller; `rebuild_indexes` is the other.
    fn add_to_index(&mut self, id: EntityId, anchor: TilePos, footprint: Footprint) {
        let dims = self.terrain.dims();
        let Store {
            chunk_index,
            index_ops,
            ..
        } = self;
        footprint_tiles(dims, anchor, footprint, |chunk, local| {
            chunk_index
                .entry(chunk)
                .or_insert_with(|| ChunkIndex::new(dims))
                .add(local, id);
            *index_ops += 1;
        });
    }

    /// Removes `id`'s footprint (anchored at `anchor`) from every overlapped chunk's
    /// [`ChunkIndex`], dropping a chunk's index entirely once it holds no more entities (0007 §5:
    /// "only for chunks with entities").
    fn remove_from_index(&mut self, id: EntityId, anchor: TilePos, footprint: Footprint) {
        let dims = self.terrain.dims();
        let Store {
            chunk_index,
            index_ops,
            ..
        } = self;
        footprint_tiles(dims, anchor, footprint, |chunk, local| {
            if let Some(idx) = chunk_index.get_mut(&chunk) {
                idx.remove(local, id);
                *index_ops += 1;
                if idx.is_empty() {
                    chunk_index.remove(&chunk);
                }
            }
        });
    }

    /// Every entity id whose footprint overlaps `chunk` at all, ascending (0007 §5): empty if
    /// `chunk` holds no `ChunkIndex` (no entity has ever overlapped it).
    pub(crate) fn chunk_overlapping(&self, chunk: ChunkCoord) -> &[EntityId] {
        self.chunk_index
            .get(&chunk)
            .map_or(&[][..], |idx| idx.overlapping())
    }

    /// `WorldRead::entity_at` (0007 §5-§6): the lowest-id occupant of `pos`'s tile, or `None`.
    /// Total -- a `Store` has no notion of "not held" of its own; that gate belongs to whichever
    /// `WorldRead` implementor wraps it (`Replica` outside its subscription, 0007 §1).
    pub fn entity_at(&self, pos: TilePos) -> Option<EntityId> {
        let dims = self.terrain.dims();
        let chunk = dims.chunk_of(pos);
        let index = dims.local_index(pos);
        self.chunk_index
            .get(&chunk)
            .and_then(|idx| idx.entity_at(index))
    }

    /// `WorldRead::entities_in` (0007 §5, M21 Provides): every entity whose footprint intersects
    /// `rect`, ascending `EntityId`, each visited once. `scratch` is the caller's own reused
    /// candidate buffer (`.claude/rules/hot-paths.md`: no allocation once its capacity has settled)
    /// -- gathered from every touched chunk's `ChunkIndex::overlapping` (a superset: a chunk's
    /// index lists every entity that overlaps that chunk at all, not only the part of its footprint
    /// inside `rect`), deduplicated, then filtered down to a real intersection before `f` runs.
    /// Total, like [`Store::entity_at`]: the "not held" gate is the caller's.
    pub fn entities_in(
        &self,
        rect: TileRect,
        scratch: &mut Vec<EntityId>,
        f: &mut dyn FnMut(EntityId, &G::Entity),
    ) {
        scratch.clear();
        let dims = self.terrain.dims();
        for chunk in rect.chunks(&dims).iter() {
            for &id in self.chunk_overlapping(chunk) {
                if let Err(pos) = scratch.binary_search(&id) {
                    scratch.insert(pos, id);
                }
            }
        }
        for &id in scratch.iter() {
            let Some(entity) = self.entity(id) else {
                continue;
            };
            let anchor = G::anchor(entity);
            let footprint = self.registry.footprint(G::prototype(entity));
            if footprint_rect(anchor, footprint).intersects(&rect) {
                f(id, entity);
            }
        }
    }

    /// Rebuilds every [`ChunkIndex`] from the entity table (0007 §5: "rebuilt on load"). Called by
    /// [`Store::decode`] so a decoded `Store` is never observed with a stale or absent index; also
    /// callable directly (`index_rebuild_equals_incremental`) to prove it reaches exactly the state
    /// incremental maintenance (`Store::apply`) would have.
    pub fn rebuild_indexes(&mut self) {
        self.chunk_index.clear();
        let entries: Vec<(EntityId, TilePos, Footprint)> = self
            .entities
            .iter()
            .map(|(&id, e)| (id, G::anchor(e), self.registry.footprint(G::prototype(e))))
            .collect();
        for (id, anchor, footprint) in entries {
            self.add_to_index(id, anchor, footprint);
        }
    }

    /// Diagnostic counter (Budgets: "occupancy maintenance is O(footprint), asserted by a counter
    /// `index_ops_per_put <= footprint area + 4`"). `#[cfg(any(test, feature = "testing"))]`-free:
    /// an 8-byte field with no runtime cost worth gating (host/mod's own `ConnCounters` follows the
    /// same "always compiled" convention).
    pub fn debug_index_ops(&self) -> u64 {
        self.index_ops
    }

    pub fn global(&self) -> &G::Global {
        &self.global
    }

    /// The one host-side `Err(Unknown)` for a missing player (docs/plan/12-store-and-game-trait.md
    /// Planning decisions "Missing player").
    pub fn last_seq(&self, who: PlayerId) -> Result<u32, Unknown> {
        self.player_slot(who).map(|s| s.last_seq)
    }

    /// Canonical bytes: see the module doc comment for the field order. Shared by [`Store::encode`]
    /// and [`StateHash::hash_state`] (hashing is encoding into a sink that has no buffer,
    /// `crate::hash`).
    fn write_canonical(&self, sink: &mut impl ByteSink) {
        sink.put_u32(self.players.len() as u32);
        for (who, slot) in &self.players {
            sink.put_u32(who.0);
            sink.put_u32(slot.last_seq);
            sink.put_u8(u8::from(slot.online));
            write_sized(&slot.state, sink);
        }

        sink.put_u32(self.next_entity_id);

        write_sized(&self.global, sink);

        self.terrain.write_canonical(sink);

        sink.put_u32(self.entities.len() as u32);
        for (id, entity) in &self.entities {
            sink.put_u32(id.0);
            write_sized(entity, sink);
        }
    }

    pub fn encode(&self, sink: &mut impl ByteSink) {
        self.write_canonical(sink);
    }

    /// Replaces every field from canonical bytes written by [`Store::encode`]. `self.terrain` is
    /// mutated in place through `TerrainStore::read_canonical` (already constructed with its
    /// pristine source, dims and cache capacity -- those are not part of the byte stream, mirroring
    /// `TerrainStore::read_canonical` itself).
    pub fn decode(&mut self, reader: &mut ByteReader) -> Result<(), CodecError> {
        let player_count = reader.u32()?;
        let mut players = BTreeMap::new();
        for _ in 0..player_count {
            let who = PlayerId(reader.u32()?);
            let last_seq = reader.u32()?;
            let online = reader.u8()? != 0;
            let state: G::Player = read_sized(reader)?;
            players.insert(
                who,
                PlayerSlot {
                    state,
                    last_seq,
                    online,
                },
            );
        }

        let next_entity_id = reader.u32()?;
        let global: G::Global = read_sized(reader)?;
        self.terrain.read_canonical(reader)?;

        let entity_count = reader.u32()?;
        let mut entities = BTreeMap::new();
        for _ in 0..entity_count {
            let id = EntityId(reader.u32()?);
            let entity: G::Entity = read_sized(reader)?;
            entities.insert(id, entity);
        }

        self.players = players;
        self.next_entity_id = next_entity_id;
        self.global = global;
        self.entities = entities;
        // 0007 §5 "rebuilt on load": a decoded `Store` must never be observed with a stale or
        // absent `ChunkIndex` (docs/plan/21-entities-and-timers.md Provides "rebuilt by
        // Store::rebuild_indexes() after decode").
        self.rebuild_indexes();
        Ok(())
    }

    /// Convenience over `impl StateHash for Store<G>` (M05).
    pub fn state_hash(&self) -> u64 {
        let mut h = Fnv64::new();
        self.hash_state(&mut h);
        h.finish()
    }
}

impl<G: Game> StateHash for Store<G> {
    fn hash_state(&self, h: &mut Fnv64) {
        self.write_canonical(h);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{PlayerEvent, TickCx, WorldWrite};
    use crate::world::{
        CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos,
    };
    use crate::worldgen::Worldgen;

    struct ZeroSource;
    impl PristineSource for ZeroSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    fn terrain() -> TerrainStore {
        TerrainStore::new(
            ChunkDims::new(4),
            Box::new(ZeroSource),
            CacheCapacity::Chunks(8),
        )
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TEntity {
        hp: u32,
        variant: u16,
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TPlayer {
        score: u32,
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TGlobal {
        day: u32,
    }

    struct TGen;
    impl Worldgen for TGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct TReject;
    impl From<Unknown> for TReject {
        fn from(_: Unknown) -> Self {
            TReject
        }
    }

    struct TestGame;
    impl Game for TestGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = TGen;
        type Action = ();
        type Reject = TReject;
        type Entity = TEntity;
        type Player = TPlayer;
        type Global = TGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();

        fn register(_r: &mut Registry) {}
        fn prototype(_e: &TEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &TEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), TReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn store() -> Store<TestGame> {
        Store::new(terrain(), TGlobal { day: 0 })
    }

    struct VecSink<'a>(&'a mut Vec<u8>);
    impl ByteSink for VecSink<'_> {
        fn put(&mut self, bytes: &[u8]) {
            self.0.extend_from_slice(bytes);
        }
    }

    fn encoded(s: &Store<TestGame>) -> Vec<u8> {
        let mut buf = Vec::new();
        s.encode(&mut VecSink(&mut buf));
        buf
    }

    fn some_deltas() -> Vec<Delta<TestGame>> {
        vec![
            Delta::Tile {
                pos: TilePos::new(3, 3),
                tile: Tile::new(1, 2, 3),
            },
            Delta::EntityPut {
                id: EntityId(1),
                entity: TEntity { hp: 10, variant: 2 },
            },
            Delta::EntityPut {
                id: EntityId(2),
                entity: TEntity { hp: 20, variant: 1 },
            },
            Delta::Player {
                who: PlayerId(1),
                state: TPlayer { score: 5 },
            },
            Delta::Roster {
                who: PlayerId(1),
                online: true,
            },
            Delta::Global {
                state: TGlobal { day: 7 },
            },
        ]
    }

    #[test]
    fn store_apply_is_idempotent() {
        let mut a = store();
        for d in &some_deltas() {
            a.apply(d);
        }
        let once = encoded(&a);
        for d in &some_deltas() {
            a.apply(d);
        }
        let twice = encoded(&a);
        assert_eq!(once, twice);
        assert_eq!(a.state_hash(), {
            let mut h = Fnv64::new();
            a.hash_state(&mut h);
            h.finish()
        });
    }

    #[test]
    fn store_apply_entity_gone_then_again_is_idempotent() {
        let mut a = store();
        a.apply(&Delta::EntityPut {
            id: EntityId(5),
            entity: TEntity { hp: 1, variant: 0 },
        });
        a.apply(&Delta::EntityGone { id: EntityId(5) });
        let once = encoded(&a);
        a.apply(&Delta::EntityGone { id: EntityId(5) });
        assert_eq!(once, encoded(&a));
        assert!(a.entity(EntityId(5)).is_none());
    }

    #[test]
    fn store_roundtrip_bytes_equal() {
        let mut a = store();
        for d in &some_deltas() {
            a.apply(d);
        }
        let bytes = encoded(&a);

        let mut b = store();
        let mut reader = ByteReader::new(&bytes);
        b.decode(&mut reader).unwrap();
        assert_eq!(bytes, encoded(&b));
        assert_eq!(a.state_hash(), b.state_hash());
    }

    #[test]
    fn store_hash_ignores_insertion_order() {
        // A reordering that reaches the same final state: `Roster` depends on `Player` having
        // put a slot first (Planning decisions "Missing player"), so the two permutations below
        // keep that one causal edge and shuffle everything independent of it -- proving the
        // *storage* (`BTreeMap`) does not leak insertion order into the canonical bytes/hash, not
        // that any reordering of causally dependent deltas is equivalent.
        let a_order = some_deltas();
        let b_order = vec![
            a_order[3].clone(), // Player
            a_order[2].clone(), // EntityPut(2)
            a_order[1].clone(), // EntityPut(1)
            a_order[5].clone(), // Global
            a_order[0].clone(), // Tile
            a_order[4].clone(), // Roster
        ];

        let mut a = store();
        for d in &a_order {
            a.apply(d);
        }
        let mut b = store();
        for d in &b_order {
            b.apply(d);
        }
        assert_eq!(a.state_hash(), b.state_hash());
        assert_eq!(encoded(&a), encoded(&b));
    }

    // Feature `testing`, like every `assert_golden_bytes!` caller (`crate::testing::golden_bytes`,
    // dev-dependency only). Unlike the crate's own external `tests/*.rs` files, an inline
    // `#[cfg(test)]` module has no `required-features` escape hatch, so only this one test is
    // gated -- the rest of the module still runs on a bare `cargo test -p engine`.
    #[cfg(feature = "testing")]
    #[test]
    fn store_golden_bytes() {
        let mut s = store();
        for d in &some_deltas() {
            s.apply(d);
        }
        crate::assert_golden_bytes!("store_golden_bytes", &encoded(&s));
    }

    #[test]
    fn entity_id_policy_next_entity_id_tracks_the_max_applied() {
        let mut s = store();
        assert_eq!(s.next_entity_id(), 1);
        s.apply(&Delta::EntityPut {
            id: EntityId(5),
            entity: TEntity::default(),
        });
        assert_eq!(s.next_entity_id(), 6);
        // A lower id does not move the counter backwards.
        s.apply(&Delta::EntityPut {
            id: EntityId(2),
            entity: TEntity::default(),
        });
        assert_eq!(s.next_entity_id(), 6);
    }

    #[test]
    fn entity_id_policy_zero_never_allocated_by_new() {
        let s = store();
        assert_eq!(s.next_entity_id(), 1, "0022 §1: ids start at 1, 0 = none");
    }

    #[test]
    fn missing_player_is_unknown() {
        let s = store();
        assert_eq!(s.player(PlayerId(9)), Err(Unknown));
        assert_eq!(s.last_seq(PlayerId(9)), Err(Unknown));
    }

    #[test]
    fn roster_delta_is_a_noop_without_a_slot() {
        let mut s = store();
        s.apply(&Delta::Roster {
            who: PlayerId(1),
            online: true,
        });
        assert_eq!(s.player(PlayerId(1)), Err(Unknown));
    }

    #[test]
    fn roster_delta_sets_online_on_an_existing_slot() {
        let mut s = store();
        s.apply(&Delta::Player {
            who: PlayerId(1),
            state: TPlayer { score: 0 },
        });
        assert!(!s.player_slot(PlayerId(1)).unwrap().online);
        s.apply(&Delta::Roster {
            who: PlayerId(1),
            online: true,
        });
        assert!(s.player_slot(PlayerId(1)).unwrap().online);
    }

    #[test]
    fn counts_match_terrain_and_entities() {
        let mut s = store();
        s.apply(&Delta::EntityPut {
            id: EntityId(1),
            entity: TEntity::default(),
        });
        s.apply(&Delta::EntityPut {
            id: EntityId(2),
            entity: TEntity::default(),
        });
        s.apply(&Delta::Tile {
            pos: TilePos::new(1, 1),
            tile: Tile::new(9, 0, 0),
        });
        assert_eq!(s.entity_count(), 2);
        assert_eq!(s.modified_tile_count(), s.terrain().modified_tiles());
        assert_eq!(s.modified_tile_count(), 1);
    }

    // -- M21 footprint/`ChunkIndex` tests (docs/plan/21-entities-and-timers.md Tests added) -------
    // A dedicated small game: `FpEntity` carries its own position and a `wide` flag selecting
    // between a 1x1 prototype (id 0) and a 3x3 one (id 1), so a single footprint can be made to
    // straddle up to 4 of `terrain()`'s edge-16 chunks (anchor near a multiple of 16).

    use crate::world::{Footprint, TileRect, TraitSet};

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct FpEntity {
        x: i32,
        y: i32,
        wide: bool,
    }

    struct FpGame;
    impl Game for FpGame {
        const SCHEMA_VERSION: u32 = 1;
        const CHUNK_BITS: u32 = 4; // edge 16, matches this module's own `terrain()`
        type Worldgen = TGen;
        type Action = ();
        type Reject = TReject;
        type Entity = FpEntity;
        type Player = TPlayer;
        type Global = TGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();

        fn register(r: &mut Registry) {
            r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 }); // id 0: ordinary
            r.add_prototype(TraitSet::EMPTY, Footprint { w: 3, h: 3 }); // id 1: wide
        }
        fn prototype(e: &FpEntity) -> PrototypeId {
            if e.wide {
                PrototypeId(1)
            } else {
                PrototypeId(0)
            }
        }
        fn anchor(e: &FpEntity) -> TilePos {
            TilePos::new(e.x, e.y)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), TReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn fp_store() -> Store<FpGame> {
        Store::new(terrain(), TGlobal { day: 0 })
    }

    /// Anchored at `(14, 14)` with a 3x3 footprint (edge-16 chunks): covers x/y in `14..=16`,
    /// straddling all 4 chunks `(0,0)`, `(1,0)`, `(0,1)`, `(1,1)`.
    const STRADDLE_CHUNKS: [(i32, i32); 4] = [(0, 0), (1, 0), (0, 1), (1, 1)];

    #[test]
    fn footprint_sets_every_overlapped_chunk() {
        let mut s = fp_store();
        s.apply(&Delta::EntityPut {
            id: EntityId(1),
            entity: FpEntity {
                x: 14,
                y: 14,
                wide: true,
            },
        });
        for (x, y) in STRADDLE_CHUNKS {
            assert_eq!(
                s.chunk_overlapping(ChunkCoord::new(x, y)),
                &[EntityId(1)],
                "chunk ({x},{y}) should overlap the footprint"
            );
        }
        assert!(
            s.chunk_overlapping(ChunkCoord::new(2, 2)).is_empty(),
            "a chunk outside the footprint must not list it"
        );
    }

    #[test]
    fn despawn_clears_all_chunks() {
        let mut s = fp_store();
        s.apply(&Delta::EntityPut {
            id: EntityId(1),
            entity: FpEntity {
                x: 14,
                y: 14,
                wide: true,
            },
        });
        s.apply(&Delta::EntityGone { id: EntityId(1) });
        for (x, y) in STRADDLE_CHUNKS {
            assert!(
                s.chunk_overlapping(ChunkCoord::new(x, y)).is_empty(),
                "chunk ({x},{y}) must be cleared after despawn"
            );
        }
        assert_eq!(s.entity_at(TilePos::new(14, 14)), None);
    }

    #[test]
    fn move_updates_old_and_new() {
        let mut s = fp_store();
        s.apply(&Delta::EntityPut {
            id: EntityId(1),
            entity: FpEntity {
                x: 14,
                y: 14,
                wide: true,
            },
        });
        // Moved to a position whose 3x3 footprint sits entirely inside chunk (6,6) (tiles
        // 100..=102 are inside 96..=111): no straddle, single-chunk case.
        s.apply(&Delta::EntityPut {
            id: EntityId(1),
            entity: FpEntity {
                x: 100,
                y: 100,
                wide: true,
            },
        });
        for (x, y) in STRADDLE_CHUNKS {
            assert!(
                s.chunk_overlapping(ChunkCoord::new(x, y)).is_empty(),
                "old chunk ({x},{y}) must be cleared after the move"
            );
        }
        assert_eq!(
            s.chunk_overlapping(ChunkCoord::new(6, 6)),
            &[EntityId(1)],
            "new chunk must hold the moved entity"
        );
        assert_eq!(s.entity_at(TilePos::new(100, 100)), Some(EntityId(1)));
        assert_eq!(s.entity_at(TilePos::new(14, 14)), None);
    }

    #[test]
    fn entity_at_any_covered_tile() {
        let mut s = fp_store();
        s.apply(&Delta::EntityPut {
            id: EntityId(1),
            entity: FpEntity {
                x: 14,
                y: 14,
                wide: true,
            },
        });
        for dx in 0..3 {
            for dy in 0..3 {
                assert_eq!(
                    s.entity_at(TilePos::new(14 + dx, 14 + dy)),
                    Some(EntityId(1)),
                    "tile ({}, {}) should be covered",
                    14 + dx,
                    14 + dy
                );
            }
        }
        assert_eq!(s.entity_at(TilePos::new(17, 17)), None);
        assert_eq!(s.entity_at(TilePos::new(13, 13)), None);
    }

    #[test]
    fn entities_in_visits_each_once_in_id_order() {
        let mut s = fp_store();
        // A wide entity straddling chunks (0,0)/(1,0)/(0,1)/(1,1), and an ordinary one anchored
        // well inside chunk (1,0) alone -- both overlap the query rect below.
        s.apply(&Delta::EntityPut {
            id: EntityId(2),
            entity: FpEntity {
                x: 14,
                y: 14,
                wide: true,
            },
        });
        s.apply(&Delta::EntityPut {
            id: EntityId(1),
            entity: FpEntity {
                x: 20,
                y: 2,
                wide: false,
            },
        });
        // An entity entirely outside the rect: must not be visited.
        s.apply(&Delta::EntityPut {
            id: EntityId(3),
            entity: FpEntity {
                x: 200,
                y: 200,
                wide: false,
            },
        });

        // The rect covers chunks (0,0) and (1,0) only (x: 0..=20, y: 0..=15) -- it intersects the
        // wide entity's footprint (which also reaches chunks (0,1)/(1,1), outside the rect) and
        // fully contains the ordinary one.
        let rect = TileRect::new(TilePos::new(0, 0), TilePos::new(20, 15));
        let mut scratch = Vec::new();
        let mut seen = Vec::new();
        s.entities_in(rect, &mut scratch, &mut |id, _e| seen.push(id));
        assert_eq!(
            seen,
            vec![EntityId(1), EntityId(2)],
            "ascending id order, each entity visited exactly once"
        );
    }

    #[test]
    fn index_rebuild_equals_incremental() {
        let mut a = fp_store();
        a.apply(&Delta::EntityPut {
            id: EntityId(1),
            entity: FpEntity {
                x: 14,
                y: 14,
                wide: true,
            },
        });
        a.apply(&Delta::EntityPut {
            id: EntityId(2),
            entity: FpEntity {
                x: 20,
                y: 2,
                wide: false,
            },
        });
        // A move, to prove the rebuild reaches the *current* state, not merely "every id ever
        // put": the entity's original chunks must be absent from the rebuilt index too.
        a.apply(&Delta::EntityPut {
            id: EntityId(2),
            entity: FpEntity {
                x: 100,
                y: 100,
                wide: false,
            },
        });

        let mut bytes = Vec::new();
        a.encode(&mut VecSink(&mut bytes));
        let mut b = fp_store();
        b.decode(&mut ByteReader::new(&bytes)).unwrap(); // calls rebuild_indexes internally

        let probe_chunks = [(0, 0), (1, 0), (0, 1), (1, 1), (1, 0), (6, 6), (9, 9)];
        for (x, y) in probe_chunks {
            let c = ChunkCoord::new(x, y);
            assert_eq!(
                a.chunk_overlapping(c),
                b.chunk_overlapping(c),
                "chunk ({x},{y}) index mismatch after rebuild"
            );
        }
        for (x, y) in [(14, 14), (16, 16), (20, 2), (100, 100)] {
            assert_eq!(
                a.entity_at(TilePos::new(x, y)),
                b.entity_at(TilePos::new(x, y)),
                "entity_at({x},{y}) mismatch after rebuild"
            );
        }
    }
}
