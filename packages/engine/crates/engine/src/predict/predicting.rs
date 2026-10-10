//! `Predicting<'_, G>` (docs/decisions/0003-game-facing-api.md "Contexts": "the client; reads
//! overlay then replica; writes go to the overlay") and [`predict`], the reset-and-replay
//! mechanism 0012's Decision describes ("At dispatch the action is applied once ... Then, once per
//! received frame: ... re-run `G::apply` for each still-pending action"). Ported from the spike's
//! `Predicting`/`Client::predict` (Phase 1 `prediction-api` spike).
//!
//! Deliberately generic over `&dyn WorldRead<G>` rather than a concrete replica type: the crate's
//! own module-layering test forbids anything outside the client/host directories from importing
//! either, and every read this module needs (tile/entity_at/entity/player/global, plus "is this
//! chunk held" via a probing `tile()` call) is already exactly what `WorldRead` exposes -- the
//! client core is the one place that ever passes it a real replica upcast.

use crate::game::{EntityId, Game, PlayerId, Unknown};
use crate::rng::SimRng;
use crate::time::Tick;
use crate::world::{ChunkDims, Registry, Tile, TilePos, TileRect, TraitSet};
use crate::world_access::{WorldRead, WorldWrite};

use super::overlay::{Overlay, covers, footprint_of, merge_entities_in};
use super::pending::Prediction;

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

    /// Overlay first (a tombstone short-circuits to `Ok(None)` without ever asking `base`); then a
    /// provisional id the overlay has no opinion about is `Ok(None)` too (0022 §7: "that namespace
    /// is the client's own" -- `base`, a real replica, is never even asked about one); otherwise
    /// `base.entity(id)` (0022 §7: a real id the replica does not hold is `Err(Unknown)`, which
    /// `client::Replica::entity` -- the production `base` -- now implements).
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown> {
        if let Some(found) = self.overlay.find_entity(id) {
            return Ok(found);
        }
        if id.is_provisional() {
            return Ok(None);
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

    /// M25 step 8 (M25 Planning decisions "Iterating reads"): merges
    /// the overlay on top of `base.entities_in` through [`merge_entities_in`], sharing its own
    /// `Overlay`-owned scratch buffer (`Overlay::entities_in_scratch`) since `Predicting` itself is
    /// rebuilt fresh every call and has nowhere else to keep one warm.
    fn entities_in(
        &self,
        rect: TileRect,
        f: &mut dyn FnMut(EntityId, &G::Entity),
    ) -> Result<(), Unknown> {
        let mut scratch = self.overlay.entities_in_scratch();
        let ok = merge_entities_in::<G>(
            self.overlay,
            self.registry,
            rect,
            &mut scratch,
            |emit| self.base.entities_in(rect, emit).is_ok(),
            |id| self.base.entity(id).ok().flatten(),
            &mut |id, e| f(id, e),
        );
        drop(scratch);
        if !ok {
            self.overlay.mark_unknown();
            return Err(Unknown);
        }
        Ok(())
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

    /// 0022 §5: `EntityId::provisional(seq, spawned)`, stable across every replay of this same
    /// pending action (`seq` and this per-`Predicting` spawn counter are both pure functions of
    /// "the nth spawn this action makes", re-derived identically every time). A 513th spawn in one
    /// action (`spawned == 512`) makes `provisional` return `None`; there is no valid id left to
    /// hand back, so this sets `saw_unknown` (the whole action declines as `NotPredictable` and
    /// rolls back, discarding the dummy id below along with everything else this replay wrote).
    fn spawn(&mut self, e: G::Entity) -> EntityId {
        let id = EntityId::provisional(self.seq, self.spawned).unwrap_or_else(|| {
            self.overlay.mark_unknown();
            EntityId(EntityId::PROVISIONAL_BIT)
        });
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
/// == false` declines without running `apply` at all (M25 Planning
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{PlayerEvent, TickCx};
    use crate::world::{Footprint, PrototypeId, Registry, TraitSet};
    use crate::worldgen::Worldgen;
    use std::collections::BTreeMap;

    /// Carries a position (as plain `i32`s: `TilePos` itself has no `Serialize`/`Deserialize`, and
    /// `Game::Entity` must be `Codec`) so `entities_in`'s own footprint/rect logic has something to
    /// bite on (`entity_id_gone_vs_unsubscribed`, below, only ever compares by id and does not care
    /// what position is inside).
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TEntity(i32, i32);
    impl TEntity {
        fn at(p: TilePos) -> Self {
            TEntity(p.x, p.y)
        }
        fn pos(self) -> TilePos {
            TilePos::new(self.0, self.1)
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TGlobal;
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct TReject;
    impl From<Unknown> for TReject {
        fn from(_: Unknown) -> Self {
            TReject
        }
    }
    struct TGen;
    impl Worldgen for TGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: crate::world::ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    struct TGame;
    impl Game for TGame {
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
        fn register(r: &mut Registry) {
            let id = r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
            debug_assert_eq!(id, PrototypeId(0));
        }
        fn prototype(_e: &TEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(e: &TEntity) -> TilePos {
            e.pos()
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), TReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    /// A minimal, hand-rolled `WorldRead<TGame>` (not `Replica`: `predict/` may never name the
    /// client module directly, `tests/main/module_layering.rs`'s own source scan). Models exactly
    /// the contract `Replica::entity` now guarantees for a *real* id (0022 §7): `Ok(Some)` if
    /// known, `Err(Unknown)` otherwise -- enough to prove `Predicting::entity`'s own merge is
    /// correct regardless of what a real base happens to do.
    struct FakeBase {
        known: BTreeMap<EntityId, TEntity>,
        global: TGlobal,
        /// A knob for the "`Unknown` at the edge" case of `entities_in_merges_overlay`: when set,
        /// `entities_in` declines before calling its own callback at all, matching
        /// `WorldRead::entities_in`'s own contract for a rect that touches an unheld chunk.
        unknown_entities_in: bool,
    }
    impl WorldRead<TGame> for FakeBase {
        fn tick(&self) -> Tick {
            Tick(0)
        }
        fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
            Ok(Tile::VOID)
        }
        fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
            Ok(TraitSet::EMPTY)
        }
        fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
            Ok(None)
        }
        fn entity(&self, id: EntityId) -> Result<Option<&TEntity>, Unknown> {
            self.known.get(&id).map(Some).ok_or(Unknown)
        }
        fn player(&self, _who: PlayerId) -> Result<&TPlayer, Unknown> {
            Err(Unknown)
        }
        fn global(&self) -> &TGlobal {
            &self.global
        }
        fn entities_in(
            &self,
            rect: TileRect,
            f: &mut dyn FnMut(EntityId, &TEntity),
        ) -> Result<(), Unknown> {
            if self.unknown_entities_in {
                return Err(Unknown);
            }
            for (&id, e) in self.known.iter() {
                if rect.contains(e.pos()) {
                    f(id, e);
                }
            }
            Ok(())
        }
    }

    /// 0022 §7's four cases, all through `Predicting::entity` (the real, production merge):
    /// real+held -> `Ok(Some)`; real+unheld -> `Err(Unknown)` (delegated straight to `base`, which
    /// -- in production, `client::Replica::entity` -- draws exactly this distinction, `client/
    /// replica.rs`'s own `predict_replica_entity_seen_vs_unseen_vs_provisional`); a provisional id
    /// the overlay has no opinion about -> `Ok(None)` (`Predicting`'s own short-circuit, `base` is
    /// never even asked); an overlay tombstone -> `Ok(None)` regardless of what `base` would say
    /// (constructed here to say `Err(Unknown)`, proving the tombstone truly short-circuits first).
    #[test]
    fn predict_entity_id_gone_vs_unsubscribed() {
        let real_seen = EntityId(5);
        let real_unseen = EntityId(6);
        let provisional_unseen = EntityId::provisional(1, 0).unwrap();
        let tombstoned = EntityId(7);

        let mut known = BTreeMap::new();
        let entity = TEntity::at(TilePos::new(0, 0));
        known.insert(real_seen, entity);
        let base = FakeBase {
            known,
            global: TGlobal,
            unknown_entities_in: false,
        };
        let registry = Registry::new();
        let mut overlay = Overlay::<TGame>::new();
        overlay.push_entity(tombstoned, None);

        let base: &dyn WorldRead<TGame> = &base;
        let p = Predicting::new(base, &registry, &mut overlay, Tick(0), 1);

        assert_eq!(p.entity(real_seen), Ok(Some(&entity)));
        assert_eq!(p.entity(real_unseen), Err(Unknown));
        assert_eq!(p.entity(provisional_unseen), Ok(None));
        assert_eq!(p.entity(tombstoned), Ok(None));
    }

    /// ADR 0046: `Predicting` keeps the defaulted `WorldWrite::wake_at`, so a predicted handler
    /// that arms a timer fails loudly instead of the prediction silently losing it.
    #[test]
    #[should_panic(expected = "ADR 0046")]
    fn predicting_wake_at_panics() {
        let base = FakeBase {
            known: BTreeMap::new(),
            global: TGlobal,
            unknown_entities_in: false,
        };
        let registry = Registry::new();
        let mut overlay = Overlay::<TGame>::new();
        let base: &dyn WorldRead<TGame> = &base;
        let mut p = Predicting::new(base, &registry, &mut overlay, Tick(0), 1);
        WorldWrite::wake_at(&mut p, EntityId(1), Tick(5));
    }

    /// M25 step 8 (M25 Tests added): override, tombstone,
    /// provisional-last order, and `Unknown` at the edge -- all through `Predicting::entities_in`,
    /// the real merge (`predict::merge_entities_in`).
    #[test]
    fn predict_entities_in_merges_overlay() {
        let mut r = Registry::new();
        TGame::register(&mut r);
        let mut known = BTreeMap::new();
        known.insert(EntityId(1), TEntity::at(TilePos::new(0, 0))); // untouched: still in rect
        known.insert(EntityId(2), TEntity::at(TilePos::new(1, 0))); // overridden: moved out of rect
        known.insert(EntityId(3), TEntity::at(TilePos::new(2, 0))); // tombstoned: removed
        let base = FakeBase {
            known,
            global: TGlobal,
            unknown_entities_in: false,
        };
        let base: &dyn WorldRead<TGame> = &base;

        let mut overlay = Overlay::<TGame>::new();
        overlay.push_entity(EntityId(2), Some(TEntity::at(TilePos::new(5, 0))));
        overlay.push_entity(EntityId(3), None);
        let prov = EntityId::provisional(9, 0).unwrap();
        overlay.push_entity(prov, Some(TEntity::at(TilePos::new(1, 0)))); // new, covers the rect

        let rect = TileRect::new(TilePos::new(0, 0), TilePos::new(3, 0));
        let p = Predicting::new(base, &r, &mut overlay, Tick(0), 1);
        let mut out = Vec::new();
        p.entities_in(rect, &mut |id, e| out.push((id, *e)))
            .expect("rect is fully held by this fake base");
        assert_eq!(
            out,
            vec![
                (EntityId(1), TEntity::at(TilePos::new(0, 0))),
                (prov, TEntity::at(TilePos::new(1, 0))),
            ],
            "id 2 moved away, id 3 is a tombstone, the provisional id sorts last"
        );

        // "Unknown at the edge": before any callback, not merely an empty result.
        let mut unknown_known = BTreeMap::new();
        unknown_known.insert(EntityId(1), TEntity::at(TilePos::new(0, 0)));
        let edge_base = FakeBase {
            known: unknown_known,
            global: TGlobal,
            unknown_entities_in: true,
        };
        let edge_base: &dyn WorldRead<TGame> = &edge_base;
        let mut overlay2 = Overlay::<TGame>::new();
        overlay2.push_entity(prov, Some(TEntity::at(TilePos::new(1, 0))));
        let p2 = Predicting::new(edge_base, &r, &mut overlay2, Tick(0), 1);
        let mut calls = 0;
        let result = p2.entities_in(rect, &mut |_, _| calls += 1);
        assert_eq!(result, Err(Unknown));
        assert_eq!(
            calls, 0,
            "no callback at all, not even for a pure-overlay entry"
        );
    }

    /// M25 step 8: the merge preserves `entities_in`'s own ascending-`EntityId` order (the same
    /// order the host/authority side already guarantees, M21), and a provisional id added out of
    /// numeric creation order still lands after every real one and in its own sorted place.
    #[test]
    fn predict_entities_in_order_matches_authority() {
        let mut r = Registry::new();
        TGame::register(&mut r);
        let mut known = BTreeMap::new();
        known.insert(EntityId(5), TEntity::at(TilePos::new(2, 0)));
        known.insert(EntityId(10), TEntity::at(TilePos::new(0, 0)));
        known.insert(EntityId(20), TEntity::at(TilePos::new(1, 0)));
        let base = FakeBase {
            known,
            global: TGlobal,
            unknown_entities_in: false,
        };
        let base: &dyn WorldRead<TGame> = &base;
        let rect = TileRect::new(TilePos::new(0, 0), TilePos::new(3, 0));

        let mut overlay = Overlay::<TGame>::new();
        let p = Predicting::new(base, &r, &mut overlay, Tick(0), 1);
        let mut merged = Vec::new();
        p.entities_in(rect, &mut |id, e| merged.push((id, *e)))
            .unwrap();
        assert_eq!(
            merged,
            vec![
                (EntityId(5), TEntity::at(TilePos::new(2, 0))),
                (EntityId(10), TEntity::at(TilePos::new(0, 0))),
                (EntityId(20), TEntity::at(TilePos::new(1, 0))),
            ],
            "an empty overlay changes nothing: same order the base pass alone already gives"
        );

        let prov_a = EntityId::provisional(2, 0).unwrap();
        let prov_b = EntityId::provisional(1, 0).unwrap();
        assert!(
            prov_b < prov_a,
            "picked so insertion order is not sorted order"
        );
        overlay.push_entity(prov_a, Some(TEntity::at(TilePos::new(0, 0))));
        overlay.push_entity(prov_b, Some(TEntity::at(TilePos::new(1, 0))));
        let p2 = Predicting::new(base, &r, &mut overlay, Tick(0), 1);
        let mut merged2 = Vec::new();
        p2.entities_in(rect, &mut |id, e| merged2.push((id, *e)))
            .unwrap();
        assert_eq!(
            merged2,
            vec![
                (EntityId(5), TEntity::at(TilePos::new(2, 0))),
                (EntityId(10), TEntity::at(TilePos::new(0, 0))),
                (EntityId(20), TEntity::at(TilePos::new(1, 0))),
                (prov_b, TEntity::at(TilePos::new(1, 0))),
                (prov_a, TEntity::at(TilePos::new(0, 0))),
            ],
            "both provisional ids sort after every real one, and between themselves by value"
        );
    }
}
