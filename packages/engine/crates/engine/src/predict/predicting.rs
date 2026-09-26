//! `Predicting<'_, G>` (docs/decisions/0003-game-facing-api.md "Contexts": "the client; reads
//! overlay then replica; writes go to the overlay") and [`predict`], the reset-and-replay
//! mechanism 0012's Decision describes ("At dispatch the action is applied once ... Then, once per
//! received frame: ... re-run `G::apply` for each still-pending action"). Ported from the spike's
//! `Predicting`/`Client::predict` (`spikes/prediction-api/engine/src/lib.rs`).
//!
//! Deliberately generic over `&dyn WorldRead<G>` rather than a concrete replica type: the crate's
//! own module-layering test forbids anything outside the client/host directories from importing
//! either, and every read this module needs (tile/entity_at/entity/player/global, plus "is this
//! chunk held" via a probing `tile()` call) is already exactly what `WorldRead` exposes -- the
//! client core is the one place that ever passes it a real replica upcast.

use crate::game::{EntityId, Game, PlayerId, Unknown};
use crate::rng::SimRng;
use crate::store::footprint_rect;
use crate::time::Tick;
use crate::world::{ChunkDims, Registry, Tile, TilePos, TileRect, TraitSet};
use crate::world_access::{WorldRead, WorldWrite};

use super::overlay::{Overlay, covers};
use super::pending::Prediction;

/// Placeholder client-local id for a predicted spawn: bit 31 set (so `EntityId::is_provisional()`
/// holds), distinct per `(seq, n)` within one client instance for the lifetime of that `seq`. M25
/// step 5 (docs/plan/25-prediction-core.md Order of work) replaces this with the ADR
/// 0022 §5 exact layout (`EntityId::provisional`, the 513-spawn-per-action cap, the `Deserialize`
/// guard that keeps one off the wire) -- deliberately *not* named `EntityId::provisional` here, so
/// the next implementer adds that seam rather than renames this one.
fn temp_provisional_id(seq: u32, n: u32) -> EntityId {
    EntityId(EntityId::PROVISIONAL_BIT | ((seq & 0x00FF_FFFF) << 4) | (n & 0xF))
}

fn footprint_of<G: Game>(registry: &Registry, e: &G::Entity) -> TileRect {
    footprint_rect(G::anchor(e), registry.footprint(G::prototype(e)))
}

/// What a predicted handler runs against (0003). `base` is the client's replica, upcast to
/// `&dyn WorldRead<G>` by the caller (`client::core::ClientCore`); `registry` is needed alongside
/// it because `WorldRead` itself carries no footprint/trait-table lookup.
pub struct Predicting<'a, G: Game> {
    base: &'a dyn WorldRead<G>,
    registry: &'a Registry,
    overlay: &'a mut Overlay<G>,
    tick: Tick,
    seq: u32,
    spawned: u32,
}

impl<'a, G: Game> Predicting<'a, G> {
    pub(crate) fn new(
        base: &'a dyn WorldRead<G>,
        registry: &'a Registry,
        overlay: &'a mut Overlay<G>,
        tick: Tick,
        seq: u32,
    ) -> Self {
        Predicting {
            base,
            registry,
            overlay,
            tick,
            seq,
            spawned: 0,
        }
    }
}

impl<'a, G: Game> WorldRead<G> for Predicting<'a, G> {
    /// Frozen per pending action (0012 "Frozen predicted tick"): never the live replica tick, so a
    /// timer a handler writes from this does not get rewritten on every replay. **Do not change
    /// this to `self.base.tick()`** -- `predict_frozen_predicted_tick`'s own inject-fail-revert proof is
    /// exactly that one-word substitution.
    fn tick(&self) -> Tick {
        self.tick
    }

    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        match self.base.tile(p) {
            Ok(base) => Ok(self.overlay.find_tile(p).unwrap_or(base)),
            Err(Unknown) => {
                self.overlay.mark_unknown();
                Err(Unknown)
            }
        }
    }

    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        let tile_traits = self.registry.tile_traits(self.tile(p)?);
        let occupant_traits = match self
            .entity_at(p)?
            .and_then(|id| self.entity(id).ok().flatten())
        {
            Some(e) => self.registry.prototype_traits(G::prototype(e)),
            None => TraitSet::EMPTY,
        };
        Ok(tile_traits.union(occupant_traits))
    }

    fn entity_at(&self, p: TilePos) -> Result<Option<EntityId>, Unknown> {
        let base = match self.base.entity_at(p) {
            Ok(base) => base,
            Err(Unknown) => {
                self.overlay.mark_unknown();
                return Err(Unknown);
            }
        };
        if let Some(found) = self
            .overlay
            .find_entity_at(|e| covers::<G>(self.registry, e, p))
        {
            return Ok(found);
        }
        // The base occupant may have been moved or despawned in the overlay without the scan
        // above finding a *new* covering entity at `p` (ported from the spike's own comment).
        match base {
            Some(id) if self.overlay.overlays_id(id) => Ok(None),
            other => Ok(other),
        }
    }

    /// Overlay first, else the replica -- total on `Replica` today (docs/plan/
    /// 21-entities-and-timers.md loopback test Deviations: "an id the replica has never seen is
    /// `Ok(None)`, not `Err(Unknown)`"). 0022 §7's Unknown-vs-unseen distinction for a *real* id is
    /// this milestone's own item but lands with the taint/provisional-id steps (5-8), not here.
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown> {
        if let Some(found) = self.overlay.find_entity(id) {
            return Ok(found);
        }
        self.base.entity(id)
    }

    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown> {
        if let Some(p) = self.overlay.find_player(who) {
            return Ok(p);
        }
        match self.base.player(who) {
            Ok(p) => Ok(p),
            Err(Unknown) => {
                self.overlay.mark_unknown();
                Err(Unknown)
            }
        }
    }

    fn global(&self) -> &G::Global {
        self.overlay.global().unwrap_or_else(|| self.base.global())
    }

    /// The overlay merge here is M25 step 8's own cut line (docs/plan/25-prediction-core.md Order
    /// of work): delegates to the base read alone until then.
    fn entities_in(
        &self,
        rect: TileRect,
        f: &mut dyn FnMut(EntityId, &G::Entity),
    ) -> Result<(), Unknown> {
        self.base.entities_in(rect, f)
    }
}

impl<'a, G: Game> WorldWrite<G> for Predicting<'a, G> {
    /// A blind write outside the subscription sets `saw_unknown` too (0012 Scope): probes via
    /// `base.tile(p)` rather than a dedicated "is this chunk held" predicate, so this module never
    /// needs one (module doc comment).
    fn set_tile(&mut self, p: TilePos, t: Tile) {
        if self.base.tile(p).is_err() {
            self.overlay.mark_unknown();
        }
        self.overlay.push_tile(p, t);
    }

    fn spawn(&mut self, e: G::Entity) -> EntityId {
        let id = temp_provisional_id(self.seq, self.spawned);
        self.spawned += 1;
        self.put_entity(id, e);
        id
    }

    fn put_entity(&mut self, id: EntityId, e: G::Entity) {
        let dims = ChunkDims::new(G::CHUNK_BITS);
        let rect = footprint_of::<G>(self.registry, &e);
        let held = rect
            .chunks(&dims)
            .iter()
            .all(|c| self.base.tile(dims.tile_at(c, 0)).is_ok());
        if !held {
            self.overlay.mark_unknown();
        }
        self.overlay.push_entity(id, Some(e));
    }

    fn despawn(&mut self, id: EntityId) {
        self.overlay.push_entity(id, None);
    }

    fn put_player(&mut self, who: PlayerId, p: G::Player) {
        self.overlay.push_player(who, p);
    }

    fn put_global(&mut self, g: G::Global) {
        self.overlay.set_global(g);
    }

    /// Host only; `Unknown` under prediction (0003), which the taint rule (M25 step 6) reads as
    /// `NotPredictable` like any other decline.
    fn rng(&mut self) -> Result<&mut SimRng, Unknown> {
        self.overlay.mark_unknown();
        Err(Unknown)
    }
}

/// One pending action's own predict-or-decline pass (0012 Decision, verbatim): `G::predict(action)
/// == false` declines without running `apply` at all (docs/plan/25-prediction-core.md Planning
/// decisions); otherwise runs `G::apply` against a fresh mark, rolling back to it on `saw_unknown`
/// or a clean rejection -- the engine enforces the client-side atomicity 0012 promises "for free".
/// Called once at dispatch (`ClientCore::on_action`) and once per still-pending action every frame
/// (`ClientCore::on_frame`); `predict_alloc` proves the whole loop allocates nothing in steady
/// state.
pub(crate) fn predict<G: Game>(
    base: &dyn WorldRead<G>,
    registry: &Registry,
    overlay: &mut Overlay<G>,
    who: PlayerId,
    tick: Tick,
    seq: u32,
    action: &G::Action,
) -> Prediction<G::Reject> {
    if !G::predict(action) {
        return Prediction::NotPredictable;
    }
    let mark = overlay.mark();
    overlay.reset_unknown();
    let result = {
        let mut w = Predicting::new(base, registry, overlay, tick, seq);
        G::apply(&mut w, who, action)
    };
    if overlay.saw_unknown() {
        overlay.rollback(mark);
        Prediction::NotPredictable
    } else {
        match result {
            Ok(()) => Prediction::Applied,
            Err(e) => {
                overlay.rollback(mark);
                Prediction::Rejected(e)
            }
        }
    }
}
