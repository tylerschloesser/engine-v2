//! `FrameView<'a, G>` and `Clocks` (docs/decisions/0003-game-facing-api.md: "`FrameView`:
//! `WorldRead` + clocks + presences"): the read-only per-frame view `ClientSide::extract`/`ui`
//! receive. M16b landed the minimal shape (`world`/`clocks`/`me`); this module (M17, 0018/0019)
//! grows it in place -- `entities()`, `visible()`, `zoom()`, `px_per_tile()`, `cursor_tile()`,
//! `window_origin()`, `time_ms()` -- rather than replacing it, per that milestone's own note.
//! M19/M30 add `presences()`; M26 adds `is_predicted(EntityId)`.

use std::collections::BTreeMap;

use crate::game::{EntityId, Game, PlayerId};
use crate::time::Tick;
use crate::world::{Registry, TilePos, TileRect};
use crate::world_access::WorldRead;

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
}

impl<'a, G: Game> FrameView<'a, G> {
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
        let fv = view(&world, &entities, &registry, visible, 20.0);

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

    #[test]
    fn frameview_zoom_matches_camera_block() {
        let world = FWorld;
        let registry = registry_1x1();
        let entities = BTreeMap::new();
        let visible = TileRect::new(TilePos::new(0, 0), TilePos::new(0, 0));
        // `zoom()` is a plain passthrough of whatever `game_instance.rs` wires in from
        // `CameraBlock::tiles_across` -- this proves the accessor, the wiring itself is proven end
        // to end by the wasm-under-Node publish test (Deviations).
        let fv = view(&world, &entities, &registry, visible, 42.5);
        assert_eq!(fv.zoom(), 42.5);
    }
}
