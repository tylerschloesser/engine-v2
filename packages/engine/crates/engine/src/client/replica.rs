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

/// 0015 §5's client-role arena line: "4 MiB dense cache, replica entities and overlays for <= 128
/// subscribed chunks" -- the terrain cache's own slice of the 48 MiB client budget (entity/overlay
/// memory is bounded by M21's state budget, Non-scope here: nothing caps entity count yet, so
/// nothing about it can be asserted at construction).
pub const CLIENT_CACHE_BUDGET_BYTES: usize = 4 * 1024 * 1024;

/// One entry of [`Replica::dirty`] (docs/plan/15b-ring-connection-and-replica-rendering.md, Scope
/// "Replica -> renderer"): a whole-chunk change (pristine enter, snapshot enter, leave) or a
/// single tile delta, carrying enough to drive `Uploader::enqueue_chunk`/`patch_tile` respectively
/// -- the *same* queue `drain_dirty`'s existing `ChunkCoord`-only signature (M15's landed seam)
/// already bounds, not a second, parallel one: a second queue populated at the same call sites but
/// drained only by a *different* caller than `drain_dirty`'s own caller grows without bound
/// whenever a native test (or anything else) calls `drain_dirty` alone to keep memory in check
/// (`no_alloc_connection.rs`'s own `client.drain_dirty(|_| {})") -- caught by
/// `host_and_client_bounded_camera_no_alloc`/`host_and_client_steady_state_no_alloc` the first time
/// this milestone tried a separate pair of vectors instead (Deviations).
#[derive(Clone, Copy, Debug)]
pub(crate) enum DirtyEvent {
    Whole(ChunkCoord),
    Tile(TilePos, Tile),
}

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
    /// One queue, one bound (see [`DirtyEvent`]'s own doc comment): `drain_dirty` (M15's landed,
    /// `ChunkCoord`-only seam) and [`Self::drain_dirty_for_upload`] (this milestone's own richer
    /// draining, `game_instance.rs`'s `on_frame`) both drain *this* `Vec`, never a copy of it --
    /// whichever one a caller uses keeps memory bounded, since nothing is ever double-buffered.
    dirty: Vec<DirtyEvent>,
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
        if let CacheCapacity::Chunks(n) = cache {
            assert!(
                n as usize >= crate::host::subs::CAP_CHUNKS,
                "Replica cache capacity ({n} chunks) is smaller than the 128-chunk subscription \
                 cap (0010): every held chunk must stay cached, or held chunks would evict each \
                 other out from under the subscription"
            );
        }
        let terrain = TerrainStore::new(dims, source, cache);
        assert!(
            terrain.memory_bytes() <= CLIENT_CACHE_BUDGET_BYTES,
            "Replica's terrain cache is {} B, over the 0015 \u{a7}5 client arena's {} B \
             dense-cache share (docs/plan/15-connection-and-subscriptions.md Budgets: \
             'replica for the chunk cap fits the client arena share of 0015 \u{a7}5')",
            terrain.memory_bytes(),
            CLIENT_CACHE_BUDGET_BYTES
        );
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

    /// The terrain overlay map's own entry count (distinct chunks holding a non-empty overlay),
    /// separate from `held_count` (every held chunk, pristine or not): M15 fix round 2's scaling
    /// measurement compares the two to see which map, if either, grows without bound under
    /// continuous panning.
    #[cfg(any(test, feature = "testing"))]
    pub fn debug_overlay_chunk_count(&self) -> usize {
        self.store.terrain().overlay_chunks().count()
    }

    pub fn held_count(&self) -> usize {
        self.held.len()
    }

    pub fn held_chunks(&self) -> impl Iterator<Item = ChunkCoord> + '_ {
        self.held.keys().copied()
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md: the one `TerrainStore` this
    /// replica's `Store<G>` owns, shared with `client::TerrainFeed`/`client::Uploader` (both take
    /// `&TerrainStore`/build off `TerrainStore::copy_chunk`) so a client-role instance needs only
    /// one store, not a `Replica`-owned one plus a second standalone one the way `game_instance.rs`
    /// built it before this milestone. `pub(crate)`, not `pub`: the seam `ClientCore`/`Replica`
    /// give the rest of the crate is these two accessors plus the `apply_*`/`drain_dirty` methods
    /// already `pub(crate)` above, not the `Store<G>` itself.
    pub(crate) fn terrain(&self) -> &TerrainStore {
        self.store.terrain()
    }

    /// Mutable counterpart of [`Self::terrain`] (`TerrainFeed::deliver`'s own `&mut TerrainStore`
    /// parameter, `game_instance.rs`'s `gen_deliver`).
    pub(crate) fn terrain_mut(&mut self) -> &mut TerrainStore {
        self.store.terrain_mut()
    }

    /// docs/plan/17-drawlist-and-sprites.md Seams: the replica's own entity table, for
    /// `client::frame_view::EntityIter` (`FrameView::entities()`). `pub`, not `pub(crate)` like
    /// `terrain`/`terrain_mut` above: a fixture's own native test (`fixtures/drawables`, a
    /// different crate) builds a `FrameView` directly to prove `drawlist.fixture_hash_golden` is a
    /// pure function of replica + camera, and `FrameView::new` needs this and `registry()` from
    /// outside the engine crate to do that -- read-only, so the visibility bump carries no
    /// mutation risk (`terrain_mut` stays `pub(crate)`).
    pub fn entities_map(&self) -> &BTreeMap<EntityId, G::Entity> {
        self.store.entities_map()
    }

    /// The prototype/footprint table `G::register` filled at construction (module doc comment):
    /// `EntityIter` needs it to derive each entity's footprint rectangle from `G::prototype`. `pub`
    /// for the same reason as `entities_map`, above.
    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// Every chunk whose effective tiles changed since the last [`Replica::drain_dirty`] call
    /// (pristine/snapshot enters, tile deltas, and leaves -- docs/plan/
    /// 15-connection-and-subscriptions.md Deviations left leave out, deferring the decision to
    /// 15b's own texel upload path, which is the one thing that reads this: a leave clears the
    /// chunk's overlay (`apply_leave`, below), which changes its *effective* tiles back to
    /// pristine even though the chunk itself may still be GPU-resident from before this replica
    /// stopped holding it -- `Uploader::enqueue_chunk` is 15b's own way to re-stage that reverted
    /// slab, Scope: "a snapshot or a leave becomes `Uploader::enqueue_chunk`").
    pub fn drain_dirty(&mut self, mut f: impl FnMut(ChunkCoord)) {
        for e in self.dirty.drain(..) {
            f(match e {
                DirtyEvent::Whole(c) => c,
                DirtyEvent::Tile(pos, _) => self.dims.chunk_of(pos),
            });
        }
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md, Scope "Replica -> renderer": the
    /// same queue [`Self::drain_dirty`] drains, handed to `f` one [`DirtyEvent`] at a time instead
    /// of coalesced to a bare `ChunkCoord` -- one closure, not two (`DirtyEvent::Whole`/`Tile`
    /// need to become `Uploader::enqueue_chunk`/`patch_tile` calls on the *same* `Uploader`, which
    /// two separate `FnMut`s cannot both borrow at once). `game_instance.rs`'s `on_frame` calls
    /// this instead of `drain_dirty` when it wants the distinction; a caller that wants only
    /// "which chunks changed" still has `drain_dirty` itself. Draining twice after one frame would
    /// find the second call empty (see [`DirtyEvent`]'s own doc comment: one queue, drained once).
    pub(crate) fn drain_dirty_for_upload(&mut self, mut f: impl FnMut(DirtyEvent)) {
        for e in self.dirty.drain(..) {
            f(e);
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
        self.dirty.push(DirtyEvent::Whole(chunk));
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
        self.dirty.push(DirtyEvent::Whole(chunk));
    }

    pub(crate) fn apply_snapshot_entity(&mut self, id: EntityId, entity: G::Entity) {
        self.store.apply(&Delta::EntityPut { id, entity });
    }

    /// A chunk leave (0011): frees the overlay (pristine cache survives, M08b) and every entity no
    /// longer overlapping a held chunk.
    pub(crate) fn apply_leave(&mut self, chunk: ChunkCoord) {
        self.store.terrain_mut().clear_overlay(chunk);
        self.held.remove(&chunk);
        self.dirty.push(DirtyEvent::Whole(chunk));
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
        self.dirty.push(DirtyEvent::Tile(pos, tile));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{PlayerEvent, TickCx, WorldWrite};
    use crate::world::PrototypeId;
    use crate::worldgen::Worldgen;

    struct ZeroSource;
    impl PristineSource for ZeroSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct RGlobal;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct RPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct REntity;
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct RReject;
    impl From<Unknown> for RReject {
        fn from(_: Unknown) -> Self {
            RReject
        }
    }
    struct RGen;
    impl Worldgen for RGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    struct RGame;
    impl Game for RGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = RGen;
        type Action = ();
        type Reject = RReject;
        type Entity = REntity;
        type Player = RPlayer;
        type Global = RGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &REntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &REntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), RReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    #[test]
    #[should_panic(expected = "smaller than the 128-chunk subscription cap")]
    fn cache_below_the_subscription_cap_panics() {
        Replica::<RGame>::new(
            ChunkDims::new(5),
            Box::new(ZeroSource),
            CacheCapacity::Chunks(64),
            PlayerId(1),
        );
    }

    #[test]
    #[should_panic(expected = "over the 0015 §5 client arena")]
    fn cache_over_the_client_budget_panics() {
        Replica::<RGame>::new(
            ChunkDims::new(5),
            Box::new(ZeroSource),
            CacheCapacity::Chunks(4096), // 16 MiB at edge 32, over the 4 MiB budget
            PlayerId(1),
        );
    }

    #[test]
    fn cache_at_the_cap_fits_the_budget() {
        // 128 chunks at edge 32 (4096 B/chunk) = 512 KiB, comfortably under 4 MiB.
        let _ = Replica::<RGame>::new(
            ChunkDims::new(5),
            Box::new(ZeroSource),
            CacheCapacity::Chunks(128),
            PlayerId(1),
        );
    }
}
