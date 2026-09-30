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

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::delta::Delta;
use crate::game::{EntityId, Game, PlayerId, Unknown};
use crate::hash::Fnv64;
use crate::store::Store;
use crate::time::Tick;
use crate::wire::encode_chunk_snapshot;

use super::remote_presence::RemotePresences;
use crate::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Registry, TerrainStore, Tile, TilePos,
    TileRect, TraitSet,
};
use crate::world_access::{WorldRead, chunk_of, touches_unheld};

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
    /// docs/plan/19-presence-channel.md steps 4-6: the newest presence sample per remote player,
    /// applied from the wire's `Presence` section (`apply_presence_sample`/`apply_presence_gone`),
    /// read by `FrameView::presences()`.
    remote_presences: RemotePresences<G>,
    /// Every player's online bit from the wire's `Global` roster. The `Store` holds a slot only
    /// for this client's own player (`Delta::Roster` for anyone else is a no-op there), so the
    /// other players live here. Never encoded or hashed.
    roster: BTreeMap<PlayerId, bool>,
    /// Reused across `entities_in` calls (`.claude/rules/hot-paths.md`): a `RefCell` since
    /// `WorldRead::entities_in` takes `&self`.
    entities_in_scratch: RefCell<Vec<EntityId>>,
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
        Self::with_source(dims, Some(source), cache, own_player)
    }

    /// [`Self::new`] with the pristine source optional: `None` is a remote client that has not seen
    /// its `Welcome` yet (docs/plan/33f-client-world-config-from-welcome.md), whose terrain answers
    /// `Unknown` for every read until [`TerrainStore::set_source`] installs one.
    pub fn with_source(
        dims: ChunkDims,
        source: Option<Box<dyn PristineSource>>,
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
        let terrain = match source {
            Some(source) => TerrainStore::new(dims, source, cache),
            None => TerrainStore::new_unconfigured(dims, cache),
        };
        assert!(
            terrain.memory_bytes() <= CLIENT_CACHE_BUDGET_BYTES,
            "Replica's terrain cache is {} B, over the 0015 \u{a7}5 client arena's {} B \
             dense-cache share (docs/plan/15-connection-and-subscriptions.md Budgets: \
             'replica for the chunk cap fits the client arena share of 0015 \u{a7}5')",
            terrain.memory_bytes(),
            CLIENT_CACHE_BUDGET_BYTES
        );
        Replica {
            store: Store::new(terrain, G::Global::default()),
            dims,
            own_player,
            held: BTreeMap::new(),
            dirty: Vec::new(),
            tick: Tick(0),
            remote_presences: RemotePresences::new(),
            roster: BTreeMap::new(),
            entities_in_scratch: RefCell::new(Vec::new()),
        }
    }

    pub fn own_player(&self) -> PlayerId {
        self.own_player
    }

    /// docs/plan/28-sessions-and-reconnect.md: `own_player` is learned for real from `Welcome`,
    /// not fixed at construction any more (`ClientInstance::init`'s own doc comment on why `Replica
    /// ::new` is still called with a placeholder `PlayerId` before any handshake has happened) --
    /// `ClientCore::apply_welcome` is the one production caller.
    pub(crate) fn set_own_player(&mut self, who: PlayerId) {
        self.own_player = who;
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

    /// docs/plan/28b-reconnect-and-lifecycle.md step 5: [`Self::held_chunks`] paired with each
    /// chunk's own version (0011 "Versions instead of acks") -- `client_hello`'s own source for
    /// `session::build_resume_hint`'s `held` parameter. A production counterpart of
    /// [`Self::debug_version`] (that one stays test-only): human-rate/one-off, not a per-frame
    /// path (`client_hello` is sent once per connection, `.claude/rules/hot-paths.md`'s own
    /// "one-time setup" exemption), so the borrowed-iterator shape costs nothing worth avoiding.
    pub fn held_chunks_with_versions(&self) -> impl Iterator<Item = (ChunkCoord, u32)> + '_ {
        self.held.iter().map(|(&c, &v)| (c, v))
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

    /// docs/plan/25-prediction-core.md testkit seam (`testing::testkit::Loopback::visible`): the
    /// one `Store<G>` this replica's own `WorldRead` impl already reads through, exposed so a
    /// read-only `world_access::View` can be built over it with a prediction overlay layered on
    /// top. `pub(crate)`, mirroring [`Self::terrain`]'s own visibility: not part of the
    /// game-facing surface. `#[cfg(...)]`-gated like [`Self::debug_version`] just above: its only
    /// caller is `testing::testkit` (feature `testing`), so a build without that feature never
    /// reaches it and `cargo clippy`'s default (no-features) pass would otherwise flag it dead.
    #[cfg(any(test, feature = "testing"))]
    pub(crate) fn store(&self) -> &Store<G> {
        &self.store
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
        self.store.registry()
    }

    /// docs/plan/19-presence-channel.md steps 4-6: `FrameView::presences()`'s source, `pub` for
    /// the same reason `entities_map`/`registry` are (`game_instance.rs`'s own `FrameView::new`
    /// call sites, outside this module).
    pub fn remote_presences(&self) -> &RemotePresences<G> {
        &self.remote_presences
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

    /// M26 (docs/plan/26-prediction-rendering-and-clocks.md Provides): marks `chunk` dirty for the
    /// upload path directly, with no replica delta behind it -- a predicted tile's own effective
    /// value changed (`OverlayDiff`). Shares the exact same queue [`Self::drain_dirty`]/
    /// [`Self::drain_dirty_for_upload`] already drain (`DirtyEvent`'s own doc comment: "one queue,
    /// one bound").
    pub(crate) fn mark_dirty(&mut self, chunk: ChunkCoord) {
        self.dirty.push(DirtyEvent::Whole(chunk));
    }

    /// Whether `self.dirty` already carries an event implying `chunk`, pushed earlier in the same
    /// call (docs/plan/26-prediction-rendering-and-clocks.md Planning decisions "One resolution
    /// point": a chunk a wire delta already dirtied this frame needs no second, whole-chunk mark
    /// from `OverlayDiff` -- that delta's own re-stage already reads the reconciled overlay content
    /// fresh at stage time, so a second mark would only be "never two uploads of a chunk in one
    /// frame"'s own violation). A plain scan: `self.dirty` holds at most a handful of entries per
    /// frame in practice (one per chunk enter/leave/tile-delta/`Self::mark_dirty` call).
    pub(crate) fn dirty_contains_chunk(&self, chunk: ChunkCoord) -> bool {
        self.dirty.iter().any(|e| match *e {
            DirtyEvent::Whole(c) => c == chunk,
            DirtyEvent::Tile(pos, _) => self.dims.chunk_of(pos) == chunk,
        })
    }

    pub(crate) fn set_tick(&mut self, tick: Tick) {
        self.tick = tick;
    }

    pub(crate) fn apply_roster(&mut self, who: PlayerId, online: bool) {
        self.roster.insert(who, online);
        self.store.apply(&Delta::Roster { who, online });
    }

    pub(crate) fn apply_global(&mut self, state: G::Global) {
        self.store.apply(&Delta::Global { state });
    }

    pub(crate) fn apply_own_player(&mut self, who: PlayerId, state: G::Player) {
        self.store.apply(&Delta::Player { who, state });
    }

    /// docs/plan/19-presence-channel.md steps 4-6: a decoded `Presence` section `Sample` entry
    /// (`ClientCore::apply`'s own `SectionId::Presence` arm) -- never touches `self.store` (0001:
    /// "presence never enters `Store`, the log or a hash").
    pub(crate) fn apply_presence_sample(
        &mut self,
        who: PlayerId,
        sample: G::Presence,
        sample_tick: Tick,
    ) {
        self.remote_presences.apply_sample(who, sample, sample_tick);
    }

    /// docs/plan/30-interpolation.md: the frame at `frame_tick` carried `who`'s sample.
    pub(crate) fn refresh_presence(&mut self, who: PlayerId, frame_tick: Tick) {
        self.remote_presences.refresh(who, frame_tick);
    }

    pub(crate) fn remote_presences_mut(&mut self) -> &mut RemotePresences<G> {
        &mut self.remote_presences
    }

    /// docs/plan/19-presence-channel.md steps 4-6: a decoded `Presence` section `Gone` entry.
    pub(crate) fn apply_presence_gone(&mut self, who: PlayerId) {
        self.remote_presences.apply_gone(who);
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

    /// Before a snapshot of an already-held chunk is applied: removes every entity overlapping
    /// `chunk` that `named` (the snapshot's own entity ids) does not list. A no-op for a chunk not
    /// held yet (a first enter has nothing to drop).
    pub(crate) fn drop_unnamed_entities(&mut self, chunk: ChunkCoord, named: &[EntityId]) {
        if !self.held.contains_key(&chunk) {
            return;
        }
        let stale: Vec<EntityId> = self
            .store
            .chunk_overlapping(chunk)
            .iter()
            .copied()
            .filter(|id| !named.contains(id))
            .collect();
        for id in stale {
            self.store.apply(&Delta::EntityGone { id });
        }
    }

    /// A chunk leave (0011): frees the overlay (pristine cache survives, M08b) and every entity no
    /// longer overlapping *any* held chunk (docs/plan/21-entities-and-timers.md Scope: a footprint
    /// straddling this chunk and a still-held one must not disappear -- widened from M12b's
    /// anchor-chunk-only check, which could never see that case since occupancy tracked only an
    /// entity's single anchor tile).
    pub(crate) fn apply_leave(&mut self, chunk: ChunkCoord) {
        let candidates: Vec<EntityId> = self.store.chunk_overlapping(chunk).to_vec();
        self.store.terrain_mut().clear_overlay(chunk);
        self.held.remove(&chunk);
        self.dirty.push(DirtyEvent::Whole(chunk));
        let dims = self.dims;
        for id in candidates {
            let Some(entity) = self.store.entity(id) else {
                continue;
            };
            let anchor = G::anchor(entity);
            let footprint = self.store.registry().footprint(G::prototype(entity));
            let still_held = crate::store::footprint_rect(anchor, footprint)
                .chunks(&dims)
                .iter()
                .any(|c| self.held.contains_key(&c));
            if !still_held {
                self.store.apply(&Delta::EntityGone { id });
            }
        }
    }

    pub(crate) fn apply_tile_delta(&mut self, chunk: ChunkCoord, index: u16, tile: Tile) {
        let pos = self.dims.tile_at(chunk, index);
        let _ = self.store.terrain_mut().set_tile(pos, tile);
        self.bump_version(chunk);
        self.dirty.push(DirtyEvent::Tile(pos, tile));
    }

    /// Bumps every *held* chunk under the entity's old footprint (read before applying) and its new
    /// one, the host's own rule: it stamps every chunk in a write's scopes
    /// (`Authority::entity_scopes`: old and new footprint chunks), so a footprint straddling a
    /// chunk boundary bumps both halves. Anchor-only bumping left a held non-anchor chunk's version
    /// stale, which `region_hash` and the resume diff both see (docs/plan/34d-straddling-entity-chunk-versions.md).
    pub(crate) fn apply_entity_put(&mut self, id: EntityId, entity: G::Entity) {
        let new_rect = self.footprint_of(&entity);
        let old_rect = self.store.entity(id).map(|e| self.footprint_of(e));
        self.store.apply(&Delta::EntityPut { id, entity });
        self.bump_rect(old_rect);
        self.bump_rect(Some(new_rect));
    }

    /// The old footprint is looked up before removal (the wire carries no anchor for a `Gone` op,
    /// 0011): `None` if this replica never held the entity (nothing to bump).
    pub(crate) fn apply_entity_gone(&mut self, id: EntityId) {
        let old_rect = self.store.entity(id).map(|e| self.footprint_of(e));
        self.store.apply(&Delta::EntityGone { id });
        self.bump_rect(old_rect);
    }

    fn footprint_of(&self, entity: &G::Entity) -> crate::world::TileRect {
        let footprint = self.store.registry().footprint(G::prototype(entity));
        crate::store::footprint_rect(G::anchor(entity), footprint)
    }

    fn bump_rect(&mut self, rect: Option<crate::world::TileRect>) {
        let Some(rect) = rect else { return };
        let dims = self.dims;
        for c in rect.chunks(&dims).iter() {
            self.bump_version(c);
        }
    }

    fn bump_version(&mut self, chunk: ChunkCoord) {
        if let Some(v) = self.held.get_mut(&chunk) {
            *v = self.tick.0;
        }
    }

    /// The desync hash of one held chunk ([`crate::integrity::chunk_hash`]): the replica's own
    /// state only, never the prediction overlay (that lives in `ClientCore`). `None` for a chunk
    /// this replica does not hold. The host's counterpart is `Host::chunk_hash`.
    pub fn chunk_hash(&self, coord: ChunkCoord) -> Option<u64> {
        self.held
            .contains_key(&coord)
            .then(|| crate::integrity::chunk_hash(&self.store, coord))
    }

    /// Appends the bytes [`Self::chunk_hash`] hashes for `coord` to `out` (hash-all dump files).
    pub fn encode_chunk(&self, coord: ChunkCoord, out: &mut Vec<u8>) {
        crate::integrity::encode_chunk(&self.store, coord, out);
    }

    /// The desync hash of this replica's `Global` value.
    pub fn global_hash(&self) -> u64 {
        crate::integrity::global_hash(&self.store)
    }

    /// The desync hash of this replica's own player state.
    pub fn own_player_hash(&self) -> u64 {
        crate::integrity::player_hash(&self.store, self.own_player)
    }

    /// Test fault injection (`client_corrupt_chunk`): rewrites tile index 0 of a held `chunk` to a
    /// different value, changing exactly one replicated byte the host never sent. `false` when
    /// the chunk is not held.
    pub fn debug_corrupt_chunk(&mut self, chunk: ChunkCoord) -> bool {
        if !self.held.contains_key(&chunk) {
            return false;
        }
        let pos = self.dims.tile_at(chunk, 0);
        let tile = self.store.terrain().tile(pos);
        let _ = self
            .store
            .terrain_mut()
            .set_tile(pos, tile.with_aux(tile.aux() ^ 1));
        self.dirty.push(DirtyEvent::Whole(chunk));
        true
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
        // A field branch, no allocation: an unconfigured terrain has no pristine function to
        // answer with, and a default tile would be a guess (`.claude/rules/prediction.md`).
        if !self.store.terrain().has_source() || !self.held.contains_key(&chunk_of::<G>(p)) {
            return Err(Unknown);
        }
        Ok(self.store.terrain().tile(p))
    }

    /// OR of the tile's traits and the occupant's traits (0007 §6): real as of M21.
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        let tile_traits = self.store.registry().tile_traits(self.tile(p)?);
        let occupant_traits = match self.entity_at(p)?.and_then(|id| self.store.entity(id)) {
            Some(e) => self.store.registry().prototype_traits(G::prototype(e)),
            None => TraitSet::EMPTY,
        };
        Ok(tile_traits.union(occupant_traits))
    }

    fn entity_at(&self, p: TilePos) -> Result<Option<EntityId>, Unknown> {
        if !self.held.contains_key(&chunk_of::<G>(p)) {
            return Err(Unknown);
        }
        Ok(self.store.entity_at(p))
    }

    /// 0022 §7: a real id the store does not hold is `Err(Unknown)` (this client cannot tell
    /// "despawned" from "outside my subscription", and either way a predicting action must
    /// decline) -- a provisional-shaped id the store does not hold is `Ok(None)` regardless (that
    /// namespace is `Predicting`'s own; a bare `Replica` never allocates or stores one, so it has no
    /// opinion about it either way).
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown> {
        match self.store.entity(id) {
            Some(e) => Ok(Some(e)),
            None if id.is_provisional() => Ok(None),
            None => Err(Unknown),
        }
    }

    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown> {
        self.store.player(who)
    }

    fn global(&self) -> &G::Global {
        self.store.global()
    }

    fn roster(&self, f: &mut dyn FnMut(PlayerId, bool)) {
        for (who, online) in &self.roster {
            f(*who, *online);
        }
    }

    /// `Err(Unknown)` before calling `f` at all if `rect` touches a chunk this replica does not
    /// hold (docs/plan/21-entities-and-timers.md Scope).
    fn entities_in(
        &self,
        rect: TileRect,
        f: &mut dyn FnMut(EntityId, &G::Entity),
    ) -> Result<(), Unknown> {
        if touches_unheld(rect, &self.dims, |c| self.held.contains_key(&c)) {
            return Err(Unknown);
        }
        let mut scratch = self.entities_in_scratch.borrow_mut();
        self.store.entities_in(rect, &mut scratch, f);
        Ok(())
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

    /// 0022 §7, three of the four cases `predict_entity_id_gone_vs_unsubscribed` (`predict/
    /// predicting.rs`) needs from `Predicting`'s own `base`: a real id the store holds is
    /// `Ok(Some)`; a real id it has never seen is `Err(Unknown)` ("despawned" and "outside my
    /// subscription" look identical from here, by design); a provisional-shaped id is `Ok(None)`
    /// regardless (a bare `Replica` never allocates one, so it has no opinion either way). The
    /// fourth case (an overlay tombstone) has no `Replica` counterpart at all -- `Predicting`'s own
    /// overlay is what carries one.
    #[test]
    fn predict_replica_entity_seen_vs_unseen_vs_provisional() {
        let mut r = Replica::<RGame>::new(
            ChunkDims::new(5),
            Box::new(ZeroSource),
            CacheCapacity::Chunks(128),
            PlayerId(1),
        );
        r.apply_entity_put(EntityId(5), REntity);
        assert_eq!(r.entity(EntityId(5)), Ok(Some(&REntity)));
        assert_eq!(r.entity(EntityId(6)), Err(Unknown));
        assert_eq!(r.entity(EntityId(EntityId::PROVISIONAL_BIT | 3)), Ok(None));
    }
}
