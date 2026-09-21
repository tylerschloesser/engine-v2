//! `Authority<G>` (docs/decisions/0003-game-facing-api.md "Contexts": "the host; reads never
//! `Unknown`" except a missing player; a write applies, records the delta, and derives its scope
//! from footprint or player"): wraps a `Store<G>` plus the host driver's own state, `SimRng` and
//! the current `Tick`, that M12's `Store` deliberately does not hold (docs/plan/
//! 12-store-and-game-trait.md Deviations). `TickCx` (0003: "`Authority` plus iteration over active
//! entities", minimal here -- 0021b adds the rest) is built here too, since it delegates every
//! `WorldRead`/`WorldWrite` method straight to one.

use crate::delta::Delta;
use crate::game::{EntityId, Game, PlayerId, Unknown};
use crate::rng::SimRng;
use crate::store::Store;
use crate::time::{Tick, Ticks};
use crate::world::{ChunkCoord, Registry, TerrainStore, Tile, TilePos, TraitSet};
use crate::world_access::{WorldRead, WorldWrite, chunk_of};

/// Who a delta is scoped to (0011 "Scopes"), derived mechanically at write time -- never chosen by
/// the game.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Chunk(ChunkCoord),
    Player(PlayerId),
    Global,
}

/// Up to 4 scopes for one write (0007 §5: a footprint overlaps at most 4 chunks at most, once M21
/// widens anchor-only scope derivation to the full footprint). M12b's own writes need at most 2 --
/// a moved entity's old and new anchor chunk -- so the extra headroom is unused today. A fixed
/// inline array, never heap-allocated (Budgets: zero allocation in `apply`/`tick` steady state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scopes {
    items: [Option<Scope>; 4],
}

impl Scopes {
    pub const fn none() -> Self {
        Scopes { items: [None; 4] }
    }

    pub const fn one(a: Scope) -> Self {
        Scopes {
            items: [Some(a), None, None, None],
        }
    }

    pub const fn two(a: Scope, b: Scope) -> Self {
        Scopes {
            items: [Some(a), Some(b), None, None],
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = Scope> + '_ {
        self.items.iter().filter_map(|s| *s)
    }

    pub fn len(&self) -> usize {
        self.items.iter().filter(|s| s.is_some()).count()
    }

    pub fn is_empty(&self) -> bool {
        self.items[0].is_none()
    }
}

/// One `Authority`'s recorded writes since the last [`Authority::clear_changes`]: `(Scopes,
/// Delta<G>)` pairs, in write order. Reused across ticks (`Sim::step` clears it after handing the
/// frame to its caller), never reallocated in steady state once its capacity settles.
pub struct ChangeLog<G: Game> {
    changes: Vec<(Scopes, Delta<G>)>,
}

impl<G: Game> ChangeLog<G> {
    pub fn new() -> Self {
        ChangeLog {
            changes: Vec::new(),
        }
    }

    pub fn push(&mut self, scopes: Scopes, delta: Delta<G>) {
        self.changes.push((scopes, delta));
    }

    pub fn clear(&mut self) {
        self.changes.clear();
    }

    pub fn as_slice(&self) -> &[(Scopes, Delta<G>)] {
        &self.changes
    }

    pub fn len(&self) -> usize {
        self.changes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
}

impl<G: Game> Default for ChangeLog<G> {
    fn default() -> Self {
        Self::new()
    }
}

/// The host's authoritative world (0003 "Contexts"). A write is `Store::apply` plus pushing the
/// scoped `Delta` onto a reused [`ChangeLog`]; reads are total except a missing player.
pub struct Authority<G: Game> {
    store: Store<G>,
    registry: Registry,
    rng: SimRng,
    tick: Tick,
    changes: ChangeLog<G>,
}

impl<G: Game> Authority<G> {
    /// `terrain` is already constructed (M07/M08 own that); `global` is the value before
    /// `Game::genesis` runs (`Store::new`'s own doc comment: `G::Global` has no `Default` bound in
    /// the `Game` trait, so `Sim::genesis` -- the only production caller -- supplies one through a
    /// local `where G::Global: Default` bound instead; see docs/plan/
    /// 12b-world-access-and-sim-driver.md Deviations). `Game::register` runs once, here, to build
    /// the trait-table `Registry` every `traits_at` read consults.
    pub fn new(terrain: TerrainStore, global: G::Global, seed: u64) -> Self {
        let mut registry = Registry::new();
        G::register(&mut registry);
        Authority {
            store: Store::new(terrain, global),
            registry,
            rng: SimRng::new(seed),
            tick: Tick(0),
            changes: ChangeLog::new(),
        }
    }

    pub fn store(&self) -> &Store<G> {
        &self.store
    }

    pub fn changes(&self) -> &[(Scopes, Delta<G>)] {
        self.changes.as_slice()
    }

    pub fn clear_changes(&mut self) {
        self.changes.clear();
    }

    #[inline]
    pub fn tick(&self) -> Tick {
        self.tick
    }

    /// `Sim::step`, after `G::tick` runs for the current tick (Scope: "records ... then `G::tick`,
    /// then advances the tick"). `pub(crate)`: only the driver advances the clock.
    pub(crate) fn advance_tick(&mut self) {
        self.tick = self.tick.add(Ticks(1));
    }

    /// The host's per-player last-processed `seq` (0004), updated through `Store::apply` --
    /// `Store::apply` is the only mutator of replicated state (`crate::store`'s own doc comment)
    /// -- but outside [`Authority::write`]/the [`ChangeLog`]: 0004 delivers acks to a client over
    /// their own channel ("Acks ride on deltas", a separate `Ack<G>`, never a rebroadcast
    /// `Delta`), so this is never a scoped, client-visible change (docs/plan/
    /// 12b-world-access-and-sim-driver.md Deviations, which also has the added `Delta::Ack`
    /// variant this calls into `Store::apply` through).
    pub(crate) fn record_ack(&mut self, who: PlayerId, seq: u32) {
        self.store.apply(&Delta::Ack { who, seq });
    }

    fn write(&mut self, delta: Delta<G>, scopes: Scopes) {
        self.store.apply(&delta);
        self.changes.push(scopes, delta);
    }

    /// `Scope::Chunk(chunk_of(anchor))`, both the entity's old anchor (if it already existed) and
    /// its new one (if this write gives it one), deduplicated when they match (Scope bullet: "old
    /// and new anchor on a move").
    fn entity_scopes(&self, id: EntityId, new_anchor: Option<TilePos>) -> Scopes {
        let old_anchor = self.store.entity(id).map(|e| G::anchor(e));
        match (old_anchor, new_anchor) {
            (Some(old), Some(new)) if old != new => Scopes::two(
                Scope::Chunk(chunk_of::<G>(old)),
                Scope::Chunk(chunk_of::<G>(new)),
            ),
            (Some(old), _) => Scopes::one(Scope::Chunk(chunk_of::<G>(old))),
            (None, Some(new)) => Scopes::one(Scope::Chunk(chunk_of::<G>(new))),
            (None, None) => Scopes::none(),
        }
    }
}

impl<G: Game> WorldRead<G> for Authority<G> {
    fn tick(&self) -> Tick {
        self.tick
    }

    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        Ok(self.store.terrain().tile(p))
    }

    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        Ok(self.registry.tile_traits(self.store.terrain().tile(p)))
    }

    fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
        // Occupancy is M21 (docs/plan/12b-world-access-and-sim-driver.md Non-scope): no index
        // exists yet to answer from, so no tile has an occupant.
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

impl<G: Game> WorldWrite<G> for Authority<G> {
    fn set_tile(&mut self, p: TilePos, t: Tile) {
        if !p.in_range() {
            // 0007 §2: "writes outside the coordinate range are debug-asserted and ignored."
            debug_assert!(false, "set_tile outside coordinate range: {p:?}");
            return;
        }
        let scope = Scopes::one(Scope::Chunk(chunk_of::<G>(p)));
        self.write(Delta::Tile { pos: p, tile: t }, scope);
    }

    fn spawn(&mut self, e: G::Entity) -> EntityId {
        let id = EntityId(self.store.next_entity_id());
        let scope = self.entity_scopes(id, Some(G::anchor(&e)));
        self.write(Delta::EntityPut { id, entity: e }, scope);
        id
    }

    fn put_entity(&mut self, id: EntityId, e: G::Entity) {
        let scope = self.entity_scopes(id, Some(G::anchor(&e)));
        self.write(Delta::EntityPut { id, entity: e }, scope);
    }

    fn despawn(&mut self, id: EntityId) {
        let scope = self.entity_scopes(id, None);
        self.write(Delta::EntityGone { id }, scope);
    }

    fn put_player(&mut self, who: PlayerId, p: G::Player) {
        self.write(
            Delta::Player { who, state: p },
            Scopes::one(Scope::Player(who)),
        );
    }

    fn put_global(&mut self, g: G::Global) {
        self.write(Delta::Global { state: g }, Scopes::one(Scope::Global));
    }

    fn rng(&mut self) -> Result<&mut SimRng, Unknown> {
        Ok(&mut self.rng)
    }
}

/// The write context `Game::tick` receives (0003: "HOST ONLY. `TickCx` is a `WorldWrite`: the
/// same recording write path"). Minimal here (Planning decisions "Exact `TickCx` shape"): index-
/// based player iteration only; M21b adds wake/timer/active-list methods. Delegates every
/// `WorldRead`/`WorldWrite` method to the `Authority` it wraps.
pub struct TickCx<'a, G: Game> {
    authority: &'a mut Authority<G>,
}

impl<'a, G: Game> TickCx<'a, G> {
    pub(crate) fn new(authority: &'a mut Authority<G>) -> Self {
        TickCx { authority }
    }

    /// The write context as a plain `&mut dyn WorldWrite<G>`, e.g. to share a rule helper with
    /// `apply` (0003).
    pub fn as_write(&mut self) -> &mut dyn WorldWrite<G> {
        &mut *self.authority
    }

    pub fn player_count(&self) -> usize {
        self.authority.store().player_count()
    }

    /// The `i`th player in ascending `PlayerId` order (0022 §1's `Ord`; `Store`'s player table is
    /// a `BTreeMap`, so this is its natural iteration order). Index-based so a rule can write
    /// while iterating (Planning decisions: no entity-wide iteration exists, and the player table
    /// has no wheel -- `tick` just scans it, "tens of rows").
    pub fn player_id_at(&self, i: usize) -> Option<PlayerId> {
        self.authority.store().player_id_at(i)
    }
}

impl<G: Game> WorldRead<G> for TickCx<'_, G> {
    fn tick(&self) -> Tick {
        WorldRead::<G>::tick(self.authority)
    }
    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        self.authority.tile(p)
    }
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        self.authority.traits_at(p)
    }
    fn entity_at(&self, p: TilePos) -> Result<Option<EntityId>, Unknown> {
        self.authority.entity_at(p)
    }
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown> {
        self.authority.entity(id)
    }
    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown> {
        self.authority.player(who)
    }
    fn global(&self) -> &G::Global {
        self.authority.global()
    }
}

impl<G: Game> WorldWrite<G> for TickCx<'_, G> {
    fn set_tile(&mut self, p: TilePos, t: Tile) {
        self.authority.set_tile(p, t);
    }
    fn spawn(&mut self, e: G::Entity) -> EntityId {
        self.authority.spawn(e)
    }
    fn put_entity(&mut self, id: EntityId, e: G::Entity) {
        self.authority.put_entity(id, e);
    }
    fn despawn(&mut self, id: EntityId) {
        self.authority.despawn(id);
    }
    fn put_player(&mut self, who: PlayerId, p: G::Player) {
        self.authority.put_player(who, p);
    }
    fn put_global(&mut self, g: G::Global) {
        self.authority.put_global(g);
    }
    fn rng(&mut self) -> Result<&mut SimRng, Unknown> {
        self.authority.rng()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::PlayerEvent;
    use crate::world::{CacheCapacity, ChunkDims, PristineSource, PrototypeId};
    use crate::worldgen::Worldgen;

    struct ZeroSource;
    impl PristineSource for ZeroSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TEntity {
        anchor: (i32, i32),
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TPlayer {
        score: u32,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct TGlobal {
        day: u32,
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
        fn anchor(e: &TEntity) -> TilePos {
            TilePos::new(e.anchor.0, e.anchor.1)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), TReject> {
            Ok(())
        }
        fn tick(_cx: &mut crate::game::TickCx<'_, Self>) {}
    }

    fn authority() -> Authority<TGame> {
        let terrain = TerrainStore::new(
            ChunkDims::new(4),
            Box::new(ZeroSource),
            CacheCapacity::Chunks(8),
        );
        Authority::new(terrain, TGlobal { day: 0 }, 42)
    }

    #[test]
    fn every_put_is_one_delta_with_scope() {
        let mut a = authority();

        a.set_tile(TilePos::new(1, 1), Tile::new(1, 0, 0));
        assert_eq!(a.changes().len(), 1);
        assert_eq!(a.changes()[0].0.len(), 1);
        assert!(matches!(
            a.changes()[0].0.iter().next(),
            Some(Scope::Chunk(_))
        ));

        let id = a.spawn(TEntity { anchor: (5, 5) });
        assert_eq!(a.changes().len(), 2);
        assert_eq!(a.changes()[1].0.len(), 1);

        a.put_entity(id, TEntity { anchor: (100, 5) }); // moved chunk: two scopes
        assert_eq!(a.changes().len(), 3);
        assert_eq!(a.changes()[2].0.len(), 2);

        a.despawn(id);
        assert_eq!(a.changes().len(), 4);
        assert_eq!(a.changes()[3].0.len(), 1);

        a.put_player(PlayerId(1), TPlayer { score: 3 });
        assert_eq!(a.changes().len(), 5);
        assert_eq!(
            a.changes()[4].0.iter().next(),
            Some(Scope::Player(PlayerId(1)))
        );

        a.put_global(TGlobal { day: 9 });
        assert_eq!(a.changes().len(), 6);
        assert_eq!(a.changes()[5].0.iter().next(), Some(Scope::Global));

        a.clear_changes();
        assert!(a.changes().is_empty());
    }

    #[test]
    fn host_reads_are_total() {
        let mut a = authority();
        // Every tile read succeeds, written or not.
        assert!(a.tile(TilePos::new(123, 456)).is_ok());
        let id = a.spawn(TEntity { anchor: (0, 0) });
        assert_eq!(a.entity(id), Ok(Some(&TEntity { anchor: (0, 0) })));
        assert_eq!(a.entity(EntityId(9999)), Ok(None));
        assert_eq!(a.global(), &TGlobal { day: 0 });
    }

    #[test]
    fn missing_player_is_unknown() {
        let a = authority();
        assert_eq!(a.player(PlayerId(1)), Err(Unknown));
    }
}
