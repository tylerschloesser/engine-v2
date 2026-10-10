//! `Overlay<G>` (docs/decisions/0012-prediction-and-reconciliation.md Decision: "the overlay is
//! three preallocated vectors (tiles, entities with tombstones, players) that keep capacity across
//! `clear()`") plus the one `Option<G::Global>` slot the brief's own Scope adds. A failed action
//! rolls back by truncating to a [`Overlay::mark`]; entries never allocate once warm (`.claude/
//! rules/hot-paths.md`'s "no allocation per frame or per tick" applied to a replay pass, proven by
//! `predict_alloc`).
//!
//! Ported from the Phase 1 `prediction-api` spike's own `Overlay`/`read_tile`/`read_entity`/
//! `read_entity_at`/`read_player`: last write wins, lookups scan backwards, an `EntityId` entry of
//! `None` is a tombstone. `saw_unknown` is a `Cell` (not a plain `bool`) because every `WorldRead`
//! method takes `&self` (0003: object-safe), so a read that discovers `Unknown` must still be able
//! to flag it through a shared reference -- the same reason the spike used one.

use std::cell::{Cell, RefCell};

use crate::game::{EntityId, Game, PlayerId};
use crate::world::{Registry, Tile, TilePos, TileRect};

/// `Overlay::mark`'s return type: a rollback point. Carries a clone of the pre-write `Global` slot
/// (`G::Global: Clone`, 0003) since that slot is a single value, not a vector index -- there is
/// nothing else to "truncate back" to.
pub struct OverlayMark<G: Game> {
    tiles: usize,
    entities: usize,
    players: usize,
    global: Option<G::Global>,
}

/// The client-side prediction overlay (0012 Decision). Reused across every `on_action`/`on_frame`
/// replay: `clear()` truncates the three vectors to zero without shrinking their capacity.
pub struct Overlay<G: Game> {
    tiles: Vec<(TilePos, Tile)>,
    entities: Vec<(EntityId, Option<G::Entity>)>,
    players: Vec<(PlayerId, G::Player)>,
    global: Option<G::Global>,
    saw_unknown: Cell<bool>,
    /// M25 step 8's own scratch for the `entities_in` overlay merge (`merge_entities_in`, below):
    /// `Predicting` is rebuilt fresh on every `predict()` call (`predicting.rs`'s module doc
    /// comment), so this `Overlay` -- the one thing that survives across an entire replay pass --
    /// is the only place a reusable buffer can live for it (`.claude/rules/hot-paths.md`). A
    /// `RefCell` for the same reason `saw_unknown` is a `Cell`: every `WorldRead` method takes
    /// `&self`.
    entities_in_scratch: RefCell<Vec<EntityId>>,
    /// M26's own scratch for `FrameView::entities()`'s overlay merge (M26): a *separate* buffer from
    /// [`Self::entities_in_scratch`], not a shared one, so a game's `extract()` calling both
    /// `view.entities()` (this) and `view.world().entities_in(..)` (that) in the same frame never
    /// double-borrows one `RefCell`.
    ///
    /// **Post-`done` fix (frame-bench hang):** each pair's `u32` is the index into [`Self::
    /// entities`] of that id's *latest* overlay entry, or [`NO_OVERLAY_ENTRY`] when the id has
    /// none -- `merge_render_ids` (`frame_view.rs`) collapses a sorted id list into this shape once
    /// per frame so `EntityIter::Merged::next` can resolve each id with one `entity_value_at`
    /// index, never a `find_entity` scan repeated per id.
    render_entities_scratch: RefCell<Vec<(EntityId, u32)>>,
}

/// [`Overlay::render_entities_scratch`]'s own sentinel: an id in that scratch list with no
/// overlay opinion at all (a base-only candidate). Never a real index -- overlay entries are in
/// the thousands (0012), not `u32::MAX`.
pub(crate) const NO_OVERLAY_ENTRY: u32 = u32::MAX;

impl<G: Game> Overlay<G> {
    pub fn new() -> Self {
        Overlay {
            tiles: Vec::new(),
            entities: Vec::new(),
            players: Vec::new(),
            global: None,
            saw_unknown: Cell::new(false),
            entities_in_scratch: RefCell::new(Vec::new()),
            render_entities_scratch: RefCell::new(Vec::new()),
        }
    }

    /// A rollback point at the current length of every vector, plus the current `Global` slot.
    pub fn mark(&self) -> OverlayMark<G> {
        OverlayMark {
            tiles: self.tiles.len(),
            entities: self.entities.len(),
            players: self.players.len(),
            global: self.global.clone(),
        }
    }

    /// Truncates every vector back to `mark` and restores the `Global` slot it captured (0012:
    /// "a failed action rolls back by truncating to a mark").
    pub fn rollback(&mut self, mark: OverlayMark<G>) {
        self.tiles.truncate(mark.tiles);
        self.entities.truncate(mark.entities);
        self.players.truncate(mark.players);
        self.global = mark.global;
    }

    /// Truncates every vector to empty and clears the `Global` slot, keeping capacity (0012: "keep
    /// capacity across `clear()`"); called once per frame, before replaying every still-pending
    /// action (`ClientCore::on_frame`).
    pub fn clear(&mut self) {
        self.tiles.clear();
        self.entities.clear();
        self.players.clear();
        self.global = None;
    }

    pub fn is_empty(&self) -> bool {
        self.tiles.is_empty()
            && self.entities.is_empty()
            && self.players.is_empty()
            && self.global.is_none()
    }

    pub fn len(&self) -> usize {
        self.tiles.len()
            + self.entities.len()
            + self.players.len()
            + usize::from(self.global.is_some())
    }

    /// Read-only, for M26 (the per-frame overlay change list, M25
    /// Provides): every tile put in overlay order (last write per position wins if iterated
    /// backwards; forward order is kept here since M26 owns how it diffs this).
    pub fn tiles(&self) -> impl Iterator<Item = (TilePos, Tile)> + '_ {
        self.tiles.iter().copied()
    }

    /// `None` = despawned in the overlay (a tombstone).
    pub fn entities(&self) -> impl Iterator<Item = (EntityId, Option<&G::Entity>)> + '_ {
        self.entities.iter().map(|(id, e)| (*id, e.as_ref()))
    }

    pub fn players(&self) -> impl Iterator<Item = (PlayerId, &G::Player)> + '_ {
        self.players.iter().map(|(who, p)| (*who, p))
    }

    pub fn global(&self) -> Option<&G::Global> {
        self.global.as_ref()
    }

    /// Set the moment a predicted handler reads state this client does not hold, or (the backstop
    /// case) writes blindly outside its subscription (0012 "`Unknown` reads"). Reset per action by
    /// [`Predicting::predict`](super::predicting::predict) before each replay.
    pub fn saw_unknown(&self) -> bool {
        self.saw_unknown.get()
    }

    pub(crate) fn mark_unknown(&self) {
        self.saw_unknown.set(true);
    }

    pub(crate) fn reset_unknown(&mut self) {
        self.saw_unknown.set(false);
    }

    pub(crate) fn push_tile(&mut self, pos: TilePos, tile: Tile) {
        self.tiles.push((pos, tile));
    }

    pub(crate) fn push_entity(&mut self, id: EntityId, e: Option<G::Entity>) {
        self.entities.push((id, e));
    }

    pub(crate) fn push_player(&mut self, who: PlayerId, p: G::Player) {
        self.players.push((who, p));
    }

    pub(crate) fn set_global(&mut self, g: G::Global) {
        self.global = Some(g);
    }

    /// The latest overlay value at `pos`, if any (ported from the spike's `read_tile`: "lookups
    /// scan backwards").
    pub(crate) fn find_tile(&self, pos: TilePos) -> Option<Tile> {
        self.tiles
            .iter()
            .rev()
            .find(|(p, _)| *p == pos)
            .map(|(_, t)| *t)
    }

    pub(crate) fn find_player(&self, who: PlayerId) -> Option<&G::Player> {
        self.players
            .iter()
            .rev()
            .find(|(w, _)| *w == who)
            .map(|(_, p)| p)
    }

    /// The latest overlay entry for `id`, if any: `Some(None)` is a tombstone (despawned in the
    /// overlay), distinct from `None` (the overlay has no opinion about `id` at all).
    pub(crate) fn find_entity(&self, id: EntityId) -> Option<Option<&G::Entity>> {
        self.entities
            .iter()
            .rev()
            .find(|(i, _)| *i == id)
            .map(|(_, e)| e.as_ref())
    }

    /// Ported from the spike's `read_entity_at`: the most recent, non-superseded overlay entity
    /// whose footprint `covers` returns `true` for -- "superseded" means a *later* overlay entry
    /// already exists for that same id (this scan runs backwards, so an id's most recent state is
    /// what decides, never an older one). `Some(Some(id))` = a predicted occupant covers `pos`;
    /// `None` = the overlay has no covering entity here (the caller falls back to its own base
    /// read). No allocation: a nested scan over the overlay's own small (single-digit) entries,
    /// exactly the spike's own shape.
    pub(crate) fn find_entity_at(
        &self,
        mut covers: impl FnMut(&G::Entity) -> bool,
    ) -> Option<Option<EntityId>> {
        for (idx, (id, e)) in self.entities.iter().enumerate().rev() {
            let superseded = self.entities[idx + 1..].iter().any(|(i, _)| i == id);
            if superseded {
                continue;
            }
            if let Some(e) = e
                && covers(e)
            {
                return Some(Some(*id));
            }
        }
        None
    }

    /// Whether the overlay has *any* opinion about `id` at all (put or despawn) -- the spike's own
    /// `read_entity_at` fallback comment: "the replica's occupant may have been moved/despawned in
    /// the overlay", so a base occupant that the overlay also mentions (but that the scan above did
    /// not just confirm still covers `pos`) must not be trusted as-is.
    pub(crate) fn overlays_id(&self, id: EntityId) -> bool {
        self.entities.iter().any(|(i, _)| *i == id)
    }

    /// This overlay's own reusable `entities_in`-merge scratch buffer (see the field's own doc
    /// comment): borrowed by [`merge_entities_in`]'s two callers (`Predicting::entities_in`,
    /// `world_access::View::entities_in`).
    pub(crate) fn entities_in_scratch(&self) -> std::cell::RefMut<'_, Vec<EntityId>> {
        self.entities_in_scratch.borrow_mut()
    }

    /// M26's own scratch for `FrameView::entities()`'s overlay merge, kept separate from
    /// [`Self::entities_in_scratch`] (its own doc comment).
    pub(crate) fn render_entities_scratch(&self) -> std::cell::RefMut<'_, Vec<(EntityId, u32)>> {
        self.render_entities_scratch.borrow_mut()
    }

    /// Every overlay entity entry's id, in push order (index `i` here is exactly the index
    /// [`Self::entity_value_at`] takes) -- `merge_render_ids`'s own raw source, deliberately not
    /// filtered by footprint or tombstone: a later entry for the same id must be able to suppress
    /// an earlier one (or a base entry) regardless of whether *this* particular entry itself
    /// covers `visible`.
    pub(crate) fn entity_ids_raw(&self) -> impl Iterator<Item = EntityId> + '_ {
        self.entities.iter().map(|(id, _)| *id)
    }

    /// The value at overlay entry `idx` (`Self::entity_ids_raw`'s own index space): `None` is a
    /// tombstone, `Some(e)` a put. One O(1) index, not `find_entity`'s O(overlay) reverse scan --
    /// the fix for `bench.frame_worstcase`'s hang (a per-id `find_entity` call from
    /// `EntityIter::Merged::next`, O(visible base entities x overlay entries) per frame).
    pub(crate) fn entity_value_at(&self, idx: u32) -> Option<&G::Entity> {
        self.entities[idx as usize].1.as_ref()
    }

    /// Every *effective* (non-superseded) tile put, in overlay order: the position and its
    /// last-write value, with an earlier entry for the same position skipped (M26: "`OverlayDiff` keeps the previous deduplicated
    /// overlay tile list"; also `FrameView::predicted_tiles`). Same "small, nested scan, no
    /// allocation" shape as [`Self::find_entity_at`]'s own "superseded" check -- overlay entries
    /// are single digits (0012), so the O(n^2) worst case never matters in practice.
    pub(crate) fn effective_tiles(&self, f: &mut dyn FnMut(TilePos, Tile)) {
        for (idx, &(pos, tile)) in self.tiles.iter().enumerate() {
            let superseded = self.tiles[idx + 1..].iter().any(|&(p, _)| p == pos);
            if !superseded {
                f(pos, tile);
            }
        }
    }
}

impl<G: Game> Default for Overlay<G> {
    fn default() -> Self {
        Self::new()
    }
}

/// An entity's footprint rect (`G::anchor`/`G::prototype`, `Registry::footprint`): shared by
/// [`covers`], [`merge_entities_in`] and `predicting.rs`'s own occupancy check in `put_entity`.
pub(crate) fn footprint_of<G: Game>(registry: &Registry, e: &G::Entity) -> TileRect {
    crate::store::footprint_rect(G::anchor(e), registry.footprint(G::prototype(e)))
}

/// Whether entity `e`'s footprint covers tile `p`. Shared by [`super::predicting::Predicting::
/// entity_at`] and `world_access::View`'s own overlay merge (both need the identical "does this
/// predicted/overlaid entity sit on this tile" check); `pub(crate)` since both callers are inside
/// this crate.
pub(crate) fn covers<G: Game>(registry: &Registry, e: &G::Entity, p: TilePos) -> bool {
    footprint_of::<G>(registry, e).contains(p)
}

/// The overlay merge of `WorldRead::entities_in` (M25 Planning
/// decisions "Iterating reads", M25 step 8): every id the overlay has an opinion about replaces or
/// removes (a tombstone) whatever `run_base` visited; every id the overlay covers `rect` with,
/// even one `run_base` never visits (a provisional spawn, or an entity moved to newly cover
/// `rect`), is added. Ascending order falls out for free: both sources are merged through the same
/// binary-search-insert `Store::entities_in` already uses, and `EntityId`'s `Ord` already puts
/// every provisional id (bit 31 set) after every real one, so a provisional entry never needs to be
/// resorted ahead of a real one.
///
/// `run_base` is the caller's own (already `Unknown`-checked) base pass -- `Predicting` wraps
/// `self.base.entities_in`, `View` wraps `Store::entities_in` directly -- and returns whether it
/// succeeded: `false` (base returned `Err(Unknown)`, and by that same contract never called its own
/// callback) makes this return `false` too, *before* `f` is ever called for anything, including a
/// pure-overlay entry -- matching `WorldRead::entities_in`'s own contract ("`Err(Unknown)` before
/// any callback"). `base_entity` looks up a base-only id's value for the final emit pass (an id the
/// overlay never mentions at all). `scratch` is the caller's own reused buffer (`.claude/rules/
/// hot-paths.md`): cleared here, never reallocated once warm.
pub(crate) fn merge_entities_in<'a, G: Game>(
    overlay: &'a Overlay<G>,
    registry: &Registry,
    rect: TileRect,
    scratch: &mut Vec<EntityId>,
    mut run_base: impl FnMut(&mut dyn FnMut(EntityId, &G::Entity)) -> bool,
    base_entity: impl Fn(EntityId) -> Option<&'a G::Entity>,
    f: &mut dyn FnMut(EntityId, &'a G::Entity),
) -> bool {
    scratch.clear();
    let ok = run_base(&mut |id, _| {
        if let Err(pos) = scratch.binary_search(&id) {
            scratch.insert(pos, id);
        }
    });
    if !ok {
        return false;
    }
    for (id, e) in overlay.entities() {
        if let Some(e) = e
            && footprint_of::<G>(registry, e).intersects(&rect)
            && let Err(pos) = scratch.binary_search(&id)
        {
            scratch.insert(pos, id);
        }
    }
    for &id in scratch.iter() {
        match overlay.find_entity(id) {
            Some(Some(e)) => {
                if footprint_of::<G>(registry, e).intersects(&rect) {
                    f(id, e);
                }
            }
            Some(None) => {} // tombstone
            None => {
                if let Some(e) = base_entity(id) {
                    f(id, e);
                }
            }
        }
    }
    true
}
