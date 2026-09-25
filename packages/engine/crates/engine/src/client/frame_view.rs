//! `FrameView<'a, G>` and `Clocks` (docs/decisions/0003-game-facing-api.md: "`FrameView`:
//! `WorldRead` + clocks + presences"): the read-only per-frame view `ClientSide::extract`/`ui`
//! receive. M16b landed the minimal shape (`world`/`clocks`/`me`); this module (M17, 0018/0019)
//! grows it in place -- `entities()`, `visible()`, `zoom()`, `px_per_tile()`, `cursor_tile()`,
//! `window_origin()`, `time_ms()` -- rather than replacing it, per that milestone's own note.
//! M19/M30 add `presences()`; M26 adds `is_predicted(EntityId)`.

use std::collections::BTreeMap;

use crate::game::{EntityId, Game, PlayerId};
use crate::presence::Presence as _;
use crate::time::Tick;
use crate::world::{Registry, TilePos, TileRect, WorldPos};
use crate::world_access::WorldRead;

use super::remote_presence::RemotePresences;

/// The authoritative and predicted tick a client observes (0003; 0006 "On the client" -- `client.
/// clock()` exposes the same pair to TypeScript). `predicted` equals `authoritative` until M26
/// gives prediction a real lead ([`docs/decisions/0012-prediction-and-reconciliation.md`]).
/// `tick_fraction`/`ticks_per_second` are M17's own addition (Seams: "progress into the current
/// tick, for smooth progress drawables"), read from the client worker's own clock block the same
/// wake `frame()` runs (`game_instance.rs`).
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Clocks {
    pub authoritative: Tick,
    pub predicted: Tick,
    pub tick_fraction: f32,
    pub ticks_per_second: u32,
}

/// Every replica entity whose footprint (`G::prototype`'s own `Footprint`, anchored at `G::anchor`)
/// intersects `FrameView::visible()`, ascending `EntityId` (`BTreeMap`'s own iteration order --
/// makes DrawList hashes stable, docs/plan/17-drawlist-and-sprites.md Seams). Built by
/// `FrameView::entities()`; a game never constructs this directly.
pub struct EntityIter<'a, G: Game> {
    inner: std::collections::btree_map::Iter<'a, EntityId, G::Entity>,
    registry: &'a Registry,
    visible: TileRect,
}

impl<'a, G: Game> Iterator for EntityIter<'a, G> {
    type Item = (EntityId, &'a G::Entity, TilePos);

    fn next(&mut self) -> Option<Self::Item> {
        for (&id, e) in self.inner.by_ref() {
            let origin = G::anchor(e);
            let footprint = self.registry.footprint(G::prototype(e));
            let rect = TileRect::new(
                origin,
                TilePos::new(
                    origin.x + footprint.w as i32 - 1,
                    origin.y + footprint.h as i32 - 1,
                ),
            );
            if rect.intersects(&self.visible) {
                return Some((id, e, origin));
            }
        }
        None
    }
}

/// The read-only view `ClientSide::extract`/`ui` receive (0003 "Contexts": the `View` role).
/// Borrows the replica for its own lifetime `'a` through `&dyn WorldRead<G>` (object-safe by
/// design, 0003: "`dyn` is deliberate ... trait-object upcasting") rather than owning a copy, so
/// one `FrameView` shape serves every `Game` with no generic read implementation per caller.
/// `entities`/`registry` are borrowed the same way, straight out of `client::Replica` (`pub(crate)`
/// accessors added this milestone) -- `WorldRead` itself stays object-safe, so entity iteration
/// cannot go through it (docs/plan/17-drawlist-and-sprites.md Deviations).
pub struct FrameView<'a, G: Game> {
    world: &'a dyn WorldRead<G>,
    clocks: Clocks,
    me: PlayerId,
    entities: &'a BTreeMap<EntityId, G::Entity>,
    registry: &'a Registry,
    visible: TileRect,
    zoom: f32,
    px_per_tile: f32,
    cursor_tile: Option<TilePos>,
    window_origin: TilePos,
    time_ms: f64,
    own_presence: G::Presence,
    remote_presences: &'a RemotePresences<G>,
}

/// One remote player's presence, as `FrameView::presences()` hands it to a game's own callback
/// (docs/plan/19-presence-channel.md Provides, verbatim field list). `alpha` is always `1.0` until
/// M30 (Goal: "remote samples are exposed raw (snapped)").
pub struct RemotePresence<'a, G: Game> {
    pub who: PlayerId,
    pub pos: WorldPos,
    pub vel: [i32; 2],
    pub sample: &'a G::Presence,
    pub alpha: f32,
}

impl<'a, G: Game> FrameView<'a, G> {
    /// docs/plan/19-presence-channel.md steps 4-6, Deviations: `own_presence` crosses *by value*
    /// (`G::Presence: Copy`), not `&'a G::Presence` as the brief's own Provides literally spells
    /// it -- `game_instance.rs`'s fixed call order (M18: "build `FrameView` -> `ClientSide::frame`
    /// -> `extract`") builds this `FrameView` *before* `ClientSide::frame` runs, and `frame`
    /// receives `presence: &mut G::Presence` into the very same `ClientInstance` field a `&'a
    /// G::Presence` held here would alias -- copying the value out at construction (the field's
    /// value as of the *start* of this frame, i.e. last frame's final write) sidesteps that
    /// conflict entirely, the same one-frame staleness this file's `camera_view` fields (cached in
    /// `game_instance.rs`) already accept for `on_frame`'s own `FrameView`.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        world: &'a dyn WorldRead<G>,
        clocks: Clocks,
        me: PlayerId,
        entities: &'a BTreeMap<EntityId, G::Entity>,
        registry: &'a Registry,
        visible: TileRect,
        zoom: f32,
        px_per_tile: f32,
        cursor_tile: Option<TilePos>,
        window_origin: TilePos,
        time_ms: f64,
        own_presence: G::Presence,
        remote_presences: &'a RemotePresences<G>,
    ) -> Self {
        FrameView {
            world,
            clocks,
            me,
            entities,
            registry,
            visible,
            zoom,
            px_per_tile,
            cursor_tile,
            window_origin,
            time_ms,
            own_presence,
            remote_presences,
        }
    }

    /// This client's own persistent presence sample (Provides), as of the start of this frame --
    /// see [`Self::new`]'s own doc comment for why it crosses by value.
    pub fn own_presence(&self) -> G::Presence {
        self.own_presence
    }

    /// Every remote player's newest known presence sample, ascending `PlayerId` (Provides).
    pub fn presences(&self, f: &mut dyn FnMut(RemotePresence<'_, G>)) {
        for (who, entry) in self.remote_presences.iter() {
            f(RemotePresence {
                who,
                pos: entry.sample.pos(),
                vel: entry.sample.vel(),
                sample: &entry.sample,
                alpha: 1.0,
            });
        }
    }

    pub fn world(&self) -> &dyn WorldRead<G> {
        self.world
    }

    pub fn clocks(&self) -> Clocks {
        self.clocks
    }

    pub fn me(&self) -> PlayerId {
        self.me
    }

    /// Replica entities whose footprint intersects [`Self::visible`], ascending `EntityId`.
    pub fn entities(&self) -> EntityIter<'a, G> {
        EntityIter {
            inner: self.entities.iter(),
            registry: self.registry,
            visible: self.visible,
        }
    }

    /// The visible rectangle plus a 2-tile margin (0018 §2's DrawList capacity assumes extract
    /// only ever considers roughly this much of the world).
    pub fn visible(&self) -> TileRect {
        self.visible
    }

    /// Tiles across the long axis (0018 §6): equals the camera block's own `tiles_across`.
    pub fn zoom(&self) -> f32 {
        self.zoom
    }

    /// Device pixels per tile (steps 4-6 Deviations "`px_per_tile()` wired for real"):
    /// `camera/transform.ts`'s own `pxPerTile` formula (`max(viewportPxW, viewportPxH) /
    /// tilesAcross`), computed in `game_instance.rs` from `CameraBlock::viewport_px` (written by
    /// `frame-loop.ts` each rAF from `renderer.viewport`) and `CameraBlock::tiles_across`. `0.0`
    /// when `tiles_across <= 0` (untriggered production, or a native test built from `CameraBlock
    /// ::for_test`, which never sets `viewport_px`/`tiles_across`). `SCREEN_PX_STROKE` is still
    /// resolved in the vertex shader from its own uniform, not from this accessor (0018 Planning
    /// decisions) -- this accessor exists for a game's own `extract()` to make a screen-space
    /// decision (e.g. culling a drawable below one screen pixel), not for the renderer.
    pub fn px_per_tile(&self) -> f32 {
        self.px_per_tile
    }

    pub fn cursor_tile(&self) -> Option<TilePos> {
        self.cursor_tile
    }

    /// The tile every `Draw::pos` this frame is relative to (Planning decisions "Window origin").
    pub fn window_origin(&self) -> TilePos {
        self.window_origin
    }

    /// The client's own frame time in milliseconds (`CameraBlock::frame_time_ms`), for effects
    /// that progress independent of the tick clock.
    pub fn time_ms(&self) -> f64 {
        self.time_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::{PlayerEvent, TickCx, Unknown, WorldWrite};
    use crate::world::{Footprint, PrototypeId, Tile, TraitSet};
    use crate::worldgen::Worldgen;

    #[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
    struct FEntity {
        pos: TilePosSer,
    }

    /// `TilePos` has no `Serialize`/`Deserialize` (it is not itself replicated data); `FEntity`
    /// needs `Codec` (`Game::Entity`'s own bound), so this test module carries its own plain-data
    /// mirror rather than adding derives to the core coordinate type for one test.
    #[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
    struct TilePosSer {
        x: i32,
        y: i32,
    }

    impl From<TilePos> for TilePosSer {
        fn from(p: TilePos) -> Self {
            TilePosSer { x: p.x, y: p.y }
        }
    }
    impl From<TilePosSer> for TilePos {
        fn from(p: TilePosSer) -> Self {
            TilePos::new(p.x, p.y)
        }
    }

    struct FGen;
    impl Worldgen for FGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: crate::world::ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct FReject;
    impl From<Unknown> for FReject {
        fn from(_: Unknown) -> Self {
            FReject
        }
    }

    struct FGame;
    impl Game for FGame {
        const SCHEMA_VERSION: u32 = 0;
        type Worldgen = FGen;
        type Action = ();
        type Reject = FReject;
        type Entity = FEntity;
        type Player = ();
        type Global = ();
        type Presence = ();
        type Ui = ();
        type Client = ();

        fn register(_r: &mut Registry) {}
        fn prototype(_e: &FEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(e: &FEntity) -> TilePos {
            e.pos.into()
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), FReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    struct FWorld;
    impl WorldRead<FGame> for FWorld {
        fn tick(&self) -> Tick {
            Tick(0)
        }
        fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
            Err(Unknown)
        }
        fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
            Err(Unknown)
        }
        fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
            Ok(None)
        }
        fn entity(&self, _id: EntityId) -> Result<Option<&FEntity>, Unknown> {
            Ok(None)
        }
        fn player(&self, _who: PlayerId) -> Result<&(), Unknown> {
            Err(Unknown)
        }
        fn global(&self) -> &() {
            &()
        }
        fn entities_in(
            &self,
            _rect: crate::world::TileRect,
            _f: &mut dyn FnMut(EntityId, &FEntity),
        ) -> Result<(), Unknown> {
            Ok(())
        }
    }

    fn registry_1x1() -> Registry {
        let mut r = Registry::new();
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn view<'a>(
        world: &'a FWorld,
        entities: &'a BTreeMap<EntityId, FEntity>,
        registry: &'a Registry,
        visible: TileRect,
        zoom: f32,
        remote_presences: &'a RemotePresences<FGame>,
    ) -> FrameView<'a, FGame> {
        FrameView::new(
            world as &dyn WorldRead<FGame>,
            Clocks::default(),
            PlayerId(1),
            entities,
            registry,
            visible,
            zoom,
            0.0,
            None,
            TilePos::new(0, 0),
            0.0,
            (),
            remote_presences,
        )
    }

    #[test]
    fn frameview_entities_sorted_and_clipped() {
        let world = FWorld;
        let registry = registry_1x1();
        let mut entities = BTreeMap::new();
        // Deliberately inserted out of id order to prove the iterator sorts (BTreeMap already
        // does; this is what actually asserts it, not merely construction order).
        entities.insert(
            EntityId(3),
            FEntity {
                pos: TilePos::new(5, 5).into(),
            },
        ); // inside
        entities.insert(
            EntityId(1),
            FEntity {
                pos: TilePos::new(0, 0).into(),
            },
        ); // inside
        entities.insert(
            EntityId(2),
            FEntity {
                pos: TilePos::new(1000, 1000).into(),
            },
        ); // outside
        let visible = TileRect::new(TilePos::new(0, 0), TilePos::new(10, 10));
        let remote = RemotePresences::<FGame>::new();
        let fv = view(&world, &entities, &registry, visible, 20.0, &remote);

        let got: Vec<(EntityId, TilePos)> =
            fv.entities().map(|(id, _, origin)| (id, origin)).collect();
        assert_eq!(
            got,
            vec![
                (EntityId(1), TilePos::new(0, 0)),
                (EntityId(3), TilePos::new(5, 5)),
            ]
        );
    }

    #[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct PPresence {
        x: i32,
    }
    impl crate::presence::Presence for PPresence {
        fn pos(&self) -> crate::world::WorldPos {
            crate::world::WorldPos { x: self.x, y: 0 }
        }
        fn vel(&self) -> [i32; 2] {
            [7, 0]
        }
    }
    struct PGame;
    impl Game for PGame {
        const SCHEMA_VERSION: u32 = 0;
        type Worldgen = FGen;
        type Action = ();
        type Reject = FReject;
        type Entity = ();
        type Player = ();
        type Global = ();
        type Presence = PPresence;
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &()) -> PrototypeId {
            unimplemented!()
        }
        fn anchor(_e: &()) -> TilePos {
            unimplemented!()
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), FReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    /// `own_presence()` returns the value `FrameView::new` was built with (Provides), by value
    /// (this file's own `Self::new` doc comment explains why not by reference).
    #[test]
    fn frameview_own_presence_returns_the_value_built_with() {
        let registry = Registry::new();
        let remote = RemotePresences::<PGame>::new();
        struct PWorld;
        impl WorldRead<PGame> for PWorld {
            fn tick(&self) -> Tick {
                Tick(0)
            }
            fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
                Err(Unknown)
            }
            fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
                Err(Unknown)
            }
            fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
                Ok(None)
            }
            fn entity(&self, _id: EntityId) -> Result<Option<&()>, Unknown> {
                Ok(None)
            }
            fn player(&self, _who: PlayerId) -> Result<&(), Unknown> {
                Err(Unknown)
            }
            fn global(&self) -> &() {
                &()
            }
            fn entities_in(
                &self,
                _rect: TileRect,
                _f: &mut dyn FnMut(EntityId, &()),
            ) -> Result<(), Unknown> {
                Ok(())
            }
        }
        let pworld = PWorld;
        let entities: BTreeMap<EntityId, ()> = BTreeMap::new();
        let fv = FrameView::<PGame>::new(
            &pworld as &dyn WorldRead<PGame>,
            Clocks::default(),
            PlayerId(1),
            &entities,
            &registry,
            TileRect::new(TilePos::new(0, 0), TilePos::new(0, 0)),
            0.0,
            0.0,
            None,
            TilePos::new(0, 0),
            0.0,
            PPresence { x: 42 },
            &remote,
        );
        assert_eq!(fv.own_presence(), PPresence { x: 42 });
    }

    /// `presences()`: ascending `PlayerId`, `pos`/`vel` derived from each sample's own trait
    /// methods, `alpha` always `1.0` (Goal: "remote samples are exposed raw (snapped)" until M30).
    /// Inject-fail-revert: swap `RemotePresences::iter`'s `self.entries.iter()` for `self.entries
    /// .iter().rev()` -- the assertion on ascending order fails (`left: [3, 1], right: [1, 3]`);
    /// reverted.
    #[test]
    fn frameview_presences_ascending_with_derived_pos_and_vel() {
        let registry = Registry::new();
        let mut remote = RemotePresences::<PGame>::new();
        remote.apply_sample(PlayerId(3), PPresence { x: 30 }, Tick(1));
        remote.apply_sample(PlayerId(1), PPresence { x: 10 }, Tick(1));
        struct PWorld;
        impl WorldRead<PGame> for PWorld {
            fn tick(&self) -> Tick {
                Tick(0)
            }
            fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
                Err(Unknown)
            }
            fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
                Err(Unknown)
            }
            fn entity_at(&self, _p: TilePos) -> Result<Option<EntityId>, Unknown> {
                Ok(None)
            }
            fn entity(&self, _id: EntityId) -> Result<Option<&()>, Unknown> {
                Ok(None)
            }
            fn player(&self, _who: PlayerId) -> Result<&(), Unknown> {
                Err(Unknown)
            }
            fn global(&self) -> &() {
                &()
            }
            fn entities_in(
                &self,
                _rect: TileRect,
                _f: &mut dyn FnMut(EntityId, &()),
            ) -> Result<(), Unknown> {
                Ok(())
            }
        }
        let pworld = PWorld;
        let entities: BTreeMap<EntityId, ()> = BTreeMap::new();
        let fv = FrameView::<PGame>::new(
            &pworld as &dyn WorldRead<PGame>,
            Clocks::default(),
            PlayerId(2),
            &entities,
            &registry,
            TileRect::new(TilePos::new(0, 0), TilePos::new(0, 0)),
            0.0,
            0.0,
            None,
            TilePos::new(0, 0),
            0.0,
            PPresence::default(),
            &remote,
        );
        let mut got: Vec<(PlayerId, i32, f32)> = Vec::new();
        fv.presences(&mut |p| got.push((p.who, p.pos.x, p.alpha)));
        assert_eq!(
            got,
            vec![(PlayerId(1), 10, 1.0), (PlayerId(3), 30, 1.0)],
            "ascending PlayerId, pos derived from Presence::pos()"
        );
    }

    // `frameview_zoom_matches_camera_block` used to live here, built by hand through `view()`
    // above -- it proved `FrameView::zoom()` reads back whatever field it was constructed with,
    // never the real wiring (`game_instance.rs`'s `camera_view.zoom = camera.tiles_across`).
    // Fix round 1 (docs/plan/17-drawlist-and-sprites.md, coordinator review): moved to
    // `fixtures/drawables/tests/drawlist_golden.rs`, which can drive a real `GameInstance<
    // Drawables>` through the actual `Instance::frame` ABI method with a real `CameraBlock` --
    // `crates/engine` itself has no concrete `Game` whose `extract()` exposes `zoom()`/
    // `px_per_tile()` observably, only the local test-only `FGame`/`TestGame`/`MGame` fixtures
    // that don't route through a real camera at all.
}
