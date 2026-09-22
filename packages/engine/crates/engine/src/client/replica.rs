//! `Replica<G>` (docs/plan/15-connection-and-subscriptions.md Scope): the client-side replicated
//! state a [`super::core::ClientCore`] applies frames into. A `Store<G>` whose `TerrainStore` is
//! the client's own pristine cache (M08b: clients regenerate pristine terrain themselves, 0011)
//! plus a held-chunk set with each held chunk's version (0011 "Versions instead of acks").
//!
//! `WorldRead<G>` is implemented directly on `Replica<G>` (mirroring `Authority`'s own impl, not
//! `world_access::View`'s borrowed-closure shape, which cannot outlive a method call that returns
//! it): `tile`/`traits_at` are `Unknown` outside the held set (0007 §1); `entity`/`player`/`global`
//! are total, exactly like `View`'s own impl, since neither is gated by chunk membership there
//! either.

use std::collections::BTreeMap;

use crate::delta::Delta;
use crate::game::{EntityId, Game, PlayerId, Unknown};
use crate::hash::Fnv64;
use crate::store::Store;
use crate::time::Tick;
use crate::wire::encode_chunk_snapshot;
use crate::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Registry, TerrainStore, Tile, TilePos,
    TraitSet,
};
use crate::world_access::{WorldRead, chunk_of};

/// One replica's held chunk set: `ChunkCoord -> version` (the tick of that chunk's last replicated
/// change, or `0` while it has never changed since it was subscribed -- the same convention the
/// host side uses, `host::mod` Deviations).
pub struct Replica<G: Game> {
    store: Store<G>,
    registry: Registry,
    dims: ChunkDims,
    /// This connection's own player id (0011 "OwnPlayer"), fixed at construction: a real
    /// connection learns it out of band, from `Host::connect`'s return value (docs/plan/
    /// 15-connection-and-subscriptions.md Deviations).
    own_player: PlayerId,
    held: BTreeMap<ChunkCoord, u32>,
    dirty: Vec<ChunkCoord>,
    tick: Tick,
}

impl<G: Game> Replica<G> {
    pub fn new(
        dims: ChunkDims,
        source: Box<dyn PristineSource>,
        cache: CacheCapacity,
        own_player: PlayerId,
    ) -> Self
    where
        G::Global: Default,
    {
        let terrain = TerrainStore::new(dims, source, cache);
        let mut registry = Registry::new();
        G::register(&mut registry);
        Replica {
            store: Store::new(terrain, G::Global::default()),
            registry,
            dims,
            own_player,
            held: BTreeMap::new(),
            dirty: Vec::new(),
            tick: Tick(0),
        }
    }

    pub fn own_player(&self) -> PlayerId {
        self.own_player
    }

    pub fn tick(&self) -> Tick {
        self.tick
    }

    pub fn is_held(&self, chunk: ChunkCoord) -> bool {
        self.held.contains_key(&chunk)
    }

    #[cfg(any(test, feature = "testing"))]
    pub fn debug_version(&self, chunk: ChunkCoord) -> u32 {
        self.held.get(&chunk).copied().unwrap_or(0)
    }

    pub fn held_count(&self) -> usize {
        self.held.len()
    }

    pub fn held_chunks(&self) -> impl Iterator<Item = ChunkCoord> + '_ {
        self.held.keys().copied()
    }

    /// Every chunk whose effective tiles changed since the last [`Replica::drain_dirty`] call
    /// (pristine/snapshot enters and tile deltas; not a plain leave -- docs/plan/
    /// 15-connection-and-subscriptions.md Deviations): for 15b's texel upload path.
    pub fn drain_dirty(&mut self, mut f: impl FnMut(ChunkCoord)) {
        for c in self.dirty.drain(..) {
            f(c);
        }
    }

    pub(crate) fn set_tick(&mut self, tick: Tick) {
        self.tick = tick;
    }

    pub(crate) fn apply_roster(&mut self, who: PlayerId, online: bool) {
        self.store.apply(&Delta::Roster { who, online });
    }

    pub(crate) fn apply_global(&mut self, state: G::Global) {
        self.store.apply(&Delta::Global { state });
    }

    pub(crate) fn apply_own_player(&mut self, who: PlayerId, state: G::Player) {
        self.store.apply(&Delta::Player { who, state });
    }

    /// A pristine chunk enter (0011: "no overlay, no entities"). Held from version 0 (never
    /// changed since replicated -- the same default the host uses for a chunk it has never
    /// modified, `host::mod` Deviations).
    pub(crate) fn apply_enter_pristine(&mut self, chunk: ChunkCoord) {
        self.held.insert(chunk, 0);
        self.dirty.push(chunk);
    }

    /// A chunk snapshot: replaces `chunk`'s overlay wholesale and applies every entity put
    /// (0011: "the same puts emitted from empty").
    pub(crate) fn apply_snapshot_overlay(
        &mut self,
        chunk: ChunkCoord,
        version: u32,
        entries: &[(u16, Tile)],
    ) {
        self.store.terrain_mut().replace_overlay(chunk, entries);
        self.held.insert(chunk, version);
        self.dirty.push(chunk);
    }

    pub(crate) fn apply_snapshot_entity(&mut self, id: EntityId, entity: G::Entity) {
        self.store.apply(&Delta::EntityPut { id, entity });
    }

    /// A chunk leave (0011): frees the overlay (pristine cache survives, M08b) and every entity no
    /// longer overlapping a held chunk.
    pub(crate) fn apply_leave(&mut self, chunk: ChunkCoord) {
        self.store.terrain_mut().clear_overlay(chunk);
        self.held.remove(&chunk);
        let gone: Vec<EntityId> = self
            .store
            .entities()
            .filter(|(_, e)| chunk_of::<G>(G::anchor(e)) == chunk)
            .map(|(id, _)| id)
            .collect();
        for id in gone {
            self.store.apply(&Delta::EntityGone { id });
        }
    }

    pub(crate) fn apply_tile_delta(&mut self, chunk: ChunkCoord, index: u16, tile: Tile) {
        let pos = self.dims.tile_at(chunk, index);
        let _ = self.store.terrain_mut().set_tile(pos, tile);
        self.bump_version(chunk);
        self.dirty.push(chunk);
    }

    pub(crate) fn apply_entity_put(&mut self, id: EntityId, entity: G::Entity) {
        let chunk = chunk_of::<G>(G::anchor(&entity));
        self.store.apply(&Delta::EntityPut { id, entity });
        self.bump_version(chunk);
    }

    /// `old_anchor` is looked up before removal (the wire carries no anchor for a `Gone` op,
    /// 0011): `None` if this replica never held the entity (nothing to bump).
    pub(crate) fn apply_entity_gone(&mut self, id: EntityId) {
        let old_chunk = self.store.entity(id).map(|e| chunk_of::<G>(G::anchor(e)));
        self.store.apply(&Delta::EntityGone { id });
        if let Some(chunk) = old_chunk {
            self.bump_version(chunk);
        }
    }

    fn bump_version(&mut self, chunk: ChunkCoord) {
        if let Some(v) = self.held.get_mut(&chunk) {
            *v = self.tick.0;
        }
    }

    /// M05 state hash over `encode_chunk_snapshot` of each held chunk (ordered by coord, the
    /// ordering key only -- not part of the hashed bytes, M14 Deviations), plus `Global` and
    /// `OwnPlayer` (docs/plan/15-connection-and-subscriptions.md Scope "region_hash"). Matches
    /// `host::Host::region_hash` byte for byte when the two sides agree.
    pub fn region_hash(&self) -> u64 {
        let mut h = Fnv64::new();
        // `self.held`'s `BTreeMap<ChunkCoord, _>` sorts by `ChunkCoord`'s derived `Ord`, which is
        // `(x, y)` (field declaration order) -- `host::Host::region_hash`'s own ordering is
        // `(cy, cx)` (the wire's own coordinate-list convention), so the two must be re-sorted the
        // same way here rather than trusting the map's natural iteration order (host/mod
        // Deviations; this was a real bug, caught by `replica_hash_equals_host_region_hash`: same
        // chunk set, same per-chunk bytes, different hash, because the two sides fed
        // `encode_chunk_snapshot` calls to `Fnv64` in different orders).
        let mut chunks: Vec<(ChunkCoord, u32)> = self.held.iter().map(|(&c, &v)| (c, v)).collect();
        chunks.sort_by_key(|(c, _)| (c.y, c.x));
        for (chunk, version) in chunks {
            encode_chunk_snapshot(&self.store, chunk, version, &mut h);
        }
        crate::codec::encode_to(self.store.global(), &mut h)
            .expect("hashing G::Global cannot fail");
        if let Ok(player) = self.store.player(self.own_player) {
            crate::codec::encode_to(player, &mut h).expect("hashing G::Player cannot fail");
        }
        h.finish()
    }
}

impl<G: Game> WorldRead<G> for Replica<G> {
    fn tick(&self) -> Tick {
        self.tick
    }

    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        if !self.held.contains_key(&chunk_of::<G>(p)) {
            return Err(Unknown);
        }
        Ok(self.store.terrain().tile(p))
    }

    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        Ok(self.registry.tile_traits(self.tile(p)?))
    }

    fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
        Ok(None)
    }

    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown> {
        Ok(self.store.entity(id))
    }

    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown> {
        self.store.player(who)
    }

    fn global(&self) -> &G::Global {
        self.store.global()
    }
}
