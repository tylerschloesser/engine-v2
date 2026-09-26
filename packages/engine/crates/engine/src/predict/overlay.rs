//! `Overlay<G>` (docs/decisions/0012-prediction-and-reconciliation.md Decision: "the overlay is
//! three preallocated vectors (tiles, entities with tombstones, players) that keep capacity across
//! `clear()`") plus the one `Option<G::Global>` slot the brief's own Scope adds. A failed action
//! rolls back by truncating to a [`Overlay::mark`]; entries never allocate once warm (`.claude/
//! rules/hot-paths.md`'s "no allocation per frame or per tick" applied to a replay pass, proven by
//! `predict_alloc`).
//!
//! Ported from `spikes/prediction-api/engine/src/lib.rs`'s own `Overlay`/`read_tile`/`read_entity`/
//! `read_entity_at`/`read_player`: last write wins, lookups scan backwards, an `EntityId` entry of
//! `None` is a tombstone. `saw_unknown` is a `Cell` (not a plain `bool`) because every `WorldRead`
//! method takes `&self` (0003: object-safe), so a read that discovers `Unknown` must still be able
//! to flag it through a shared reference -- the same reason the spike used one.

use std::cell::Cell;

use crate::game::{EntityId, Game, PlayerId};
use crate::world::{Registry, Tile, TilePos};

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
}

impl<G: Game> Overlay<G> {
    pub fn new() -> Self {
        Overlay {
            tiles: Vec::new(),
            entities: Vec::new(),
            players: Vec::new(),
            global: None,
            saw_unknown: Cell::new(false),
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

    /// Read-only, for M26 (the per-frame overlay change list, docs/plan/25-prediction-core.md
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
}

impl<G: Game> Default for Overlay<G> {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether entity `e`'s footprint (`G::anchor`/`G::prototype`, `Registry::footprint`) covers tile
/// `p`. Shared by [`super::predicting::Predicting::entity_at`] and `world_access::View`'s own
/// overlay merge (both need the identical "does this predicted/overlaid entity sit on this tile"
/// check); `pub(crate)` since both callers are inside this crate.
pub(crate) fn covers<G: Game>(registry: &Registry, e: &G::Entity, p: TilePos) -> bool {
    crate::store::footprint_rect(G::anchor(e), registry.footprint(G::prototype(e))).contains(p)
}
