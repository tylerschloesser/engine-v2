//! `WorldRead<G>`/`WorldWrite<G>` (docs/decisions/0003-game-facing-api.md Decision, "Contexts"):
//! every world read and write a handler sees, exactly as 0003, object-safe so a handler compiles
//! once against `&dyn WorldWrite<G>` (0003: "`dyn` is deliberate ... relies on trait-object
//! upcasting", stable since Rust 1.86). Three implementors named there: `Authority` (host,
//! `crate::authority`), `Predicting` (client, M25) and read-only [`View`] (renderer, `ui`, shared
//! rule helpers -- built here).
//!
//! Re-exported at `crate::game::{WorldRead, WorldWrite}` (game.rs) since the `Game` trait's own
//! method signatures name them there and every existing caller imports them from that path.

use std::cell::RefCell;

use crate::game::{EntityId, Game, PlayerId, Unknown};
use crate::rng::SimRng;
use crate::store::Store;
use crate::time::Tick;
use crate::world::{ChunkCoord, ChunkDims, Registry, Tile, TilePos, TileRect, TraitSet};

/// `tile >> CHUNK_BITS` for `G` (0007 §2-3): shared by every `WorldRead`/`WorldWrite` implementor
/// so none needs to carry a `ChunkDims` of its own -- `G::CHUNK_BITS` is a compile-time constant
/// of the game crate.
#[inline]
pub(crate) fn chunk_of<G: Game>(pos: TilePos) -> ChunkCoord {
    ChunkDims::new(G::CHUNK_BITS).chunk_of(pos)
}

/// Every world read (0003 Decision, verbatim), object-safe. Host reads (`Authority`) are total
/// except a missing player (`Unknown`); a client replica returns `Unknown` outside its
/// subscription (0007 §1).
pub trait WorldRead<G: Game> {
    /// Under prediction: frozen per pending action (0012). Host: the tick being simulated.
    fn tick(&self) -> Tick;
    fn tile(&self, p: TilePos) -> Result<Tile, Unknown>;
    /// OR of the tile's traits and the occupant's traits (0007 §6). Occupancy is not tracked until
    /// M21 (docs/plan/12b-world-access-and-sim-driver.md Non-scope): until then `entity_at` never
    /// returns an occupant, so this is the tile term alone.
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown>;
    fn entity_at(&self, p: TilePos) -> Result<Option<EntityId>, Unknown>;
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown>;
    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown>;
    fn global(&self) -> &G::Global;
    /// Every entity whose footprint intersects `rect`, ascending `EntityId`, visited once (0007
    /// §5, M21). A replica answers `Err(Unknown)` *before calling `f` at all* if `rect` touches a
    /// chunk it does not hold (docs/plan/21-entities-and-timers.md Scope); the host is always
    /// total. M25 adds the prediction overlay's merge on top of this.
    fn entities_in(
        &self,
        rect: TileRect,
        f: &mut dyn FnMut(EntityId, &G::Entity),
    ) -> Result<(), Unknown>;
}

/// Every chunk `rect` touches, under `dims`: shared by every `WorldRead::entities_in` implementor
/// that must check "does this touch an unheld chunk?" before calling `Store::entities_in` (0007
/// §1). A free function, not a method, since it is needed by `Authority`/`Replica`/`View` alike and
/// none of them shares a common base type.
pub(crate) fn touches_unheld(
    rect: TileRect,
    dims: &ChunkDims,
    held: impl Fn(ChunkCoord) -> bool,
) -> bool {
    rect.chunks(dims).iter().any(|c| !held(c))
}

/// Every world write (0003 Decision, verbatim): one whole-value put, one `Delta` (0011).
pub trait WorldWrite<G: Game>: WorldRead<G> {
    fn set_tile(&mut self, p: TilePos, t: Tile);
    fn spawn(&mut self, e: G::Entity) -> EntityId;
    fn put_entity(&mut self, id: EntityId, e: G::Entity);
    fn despawn(&mut self, id: EntityId);
    fn put_player(&mut self, who: PlayerId, p: G::Player);
    fn put_global(&mut self, g: G::Global);
    /// Host only; `Unknown` under prediction (`NotPredictable`, M25).
    fn rng(&mut self) -> Result<&mut SimRng, Unknown>;
}

/// The read-only context (0003 "Contexts"): renderer, `ClientSide::ui`, and shared rule helpers
/// such as `can_place(&dyn WorldRead, ..)`. Wraps a `Store` plus a "held chunk" predicate -- always
/// true on the host (every read is total there); M15 supplies the replica's (subscription-scoped).
/// `traits_at`'s occupant term is not implemented yet (Non-scope, same as every `WorldRead`
/// implementor here).
pub struct View<'a, G: Game> {
    store: &'a Store<G>,
    registry: &'a Registry,
    tick: Tick,
    held: &'a dyn Fn(ChunkCoord) -> bool,
    /// Reused across `entities_in` calls (`.claude/rules/hot-paths.md`): a `RefCell` since
    /// `WorldRead::entities_in` takes `&self`, matching `Authority`/`Replica`'s own scratch field.
    entities_in_scratch: RefCell<Vec<EntityId>>,
}

impl<'a, G: Game> View<'a, G> {
    pub fn new(
        store: &'a Store<G>,
        registry: &'a Registry,
        tick: Tick,
        held: &'a dyn Fn(ChunkCoord) -> bool,
    ) -> Self {
        View {
            store,
            registry,
            tick,
            held,
            entities_in_scratch: RefCell::new(Vec::new()),
        }
    }

    /// A `View` over the whole world: every chunk is "held" (the host's own reads, or a test that
    /// wants totality without building `Authority`).
    pub fn total(store: &'a Store<G>, registry: &'a Registry, tick: Tick) -> Self {
        View {
            store,
            registry,
            tick,
            held: &|_| true,
            entities_in_scratch: RefCell::new(Vec::new()),
        }
    }
}

impl<G: Game> WorldRead<G> for View<'_, G> {
    fn tick(&self) -> Tick {
        self.tick
    }

    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        if !(self.held)(chunk_of::<G>(p)) {
            return Err(Unknown);
        }
        Ok(self.store.terrain().tile(p))
    }

    /// OR of the tile's traits and the occupant's traits (0007 §6): real as of M21.
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        let tile_traits = self.registry.tile_traits(self.tile(p)?);
        let occupant_traits = match self.entity_at(p)?.and_then(|id| self.store.entity(id)) {
            Some(e) => self.registry.prototype_traits(G::prototype(e)),
            None => TraitSet::EMPTY,
        };
        Ok(tile_traits.union(occupant_traits))
    }

    fn entity_at(&self, p: TilePos) -> Result<Option<EntityId>, Unknown> {
        if !(self.held)(chunk_of::<G>(p)) {
            return Err(Unknown);
        }
        Ok(self.store.entity_at(p))
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

    fn entities_in(
        &self,
        rect: TileRect,
        f: &mut dyn FnMut(EntityId, &G::Entity),
    ) -> Result<(), Unknown> {
        let dims = ChunkDims::new(G::CHUNK_BITS);
        if touches_unheld(rect, &dims, self.held) {
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
    use crate::game::{PlayerEvent, TickCx};
    use crate::world::{CacheCapacity, ChunkDims, PristineSource, PrototypeId};
    use crate::worldgen::Worldgen;

    struct ZeroSource;
    impl PristineSource for ZeroSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TEntity;
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
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
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
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &TEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &TEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn super::WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn super::WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(
            _w: &mut dyn super::WorldWrite<Self>,
            _who: PlayerId,
            _a: &(),
        ) -> Result<(), TReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn store() -> Store<TGame> {
        let terrain = crate::world::TerrainStore::new(
            ChunkDims::new(4),
            Box::new(ZeroSource),
            CacheCapacity::Chunks(8),
        );
        Store::new(terrain, TGlobal)
    }

    /// Object-safety + trait-object upcasting (0003: "relies on trait-object upcasting, stable
    /// since Rust 1.86"): a handler that only ever sees `&dyn WorldWrite<G>` can still call
    /// `WorldRead` methods through it, with no separate `&dyn WorldRead` ever constructed by hand.
    fn reads_through_write_upcast<G: Game>(w: &mut dyn WorldWrite<G>) -> Tick {
        let r: &dyn WorldRead<G> = w; // upcast coercion
        r.tick()
    }

    #[test]
    fn worldwrite_upcasts_to_worldread() {
        use crate::authority::Authority;
        let mut a = Authority::<TGame>::new(
            crate::world::TerrainStore::new(
                ChunkDims::new(4),
                Box::new(ZeroSource),
                CacheCapacity::Chunks(8),
            ),
            TGlobal,
            1,
        );
        let t = reads_through_write_upcast::<TGame>(&mut a);
        assert_eq!(t, a.tick());
    }

    #[test]
    fn view_total_reads_are_total() {
        let mut s = store();
        s.apply(&crate::delta::Delta::Tile {
            pos: TilePos::new(1, 1),
            tile: Tile::new(9, 0, 0),
        });
        let registry = Registry::new();
        let view = View::<TGame>::total(&s, &registry, Tick(0));
        assert_eq!(view.tile(TilePos::new(1, 1)), Ok(Tile::new(9, 0, 0)));
        assert_eq!(view.global(), &TGlobal);
    }

    #[test]
    fn view_unheld_chunk_is_unknown() {
        let s = store();
        let registry = Registry::new();
        let view = View::<TGame>::new(&s, &registry, Tick(0), &|_| false);
        assert_eq!(view.tile(TilePos::new(1, 1)), Err(Unknown));
        assert_eq!(view.traits_at(TilePos::new(1, 1)), Err(Unknown));
    }
}
