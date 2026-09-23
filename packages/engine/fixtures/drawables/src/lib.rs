//! Fixture game `fx-drawables` (docs/plan/17-drawlist-and-sprites.md, steps 2 and 6): a `Game` whose
//! only interesting behaviour is `ClientSide::extract` -- one circle per replica entity, skipping
//! the smallest ones above a zoom threshold (`frameview.zoom_matches_camera_block`'s own coverage:
//! "the record count and DrawList hash change across it and nowhere else"). `genesis` still spawns
//! exactly three fixed entities (unchanged since step 2: `drawlist_fixture_hash_golden`/
//! `drawlist_zoom_threshold_hides_only_the_small_entity` depend on that count); the one `Action`,
//! `Spawn` (step 6), is how the `drawables` zero-GC page reaches a few hundred entities without
//! touching `genesis` -- always accepted, no rejection path. `tick` does nothing.

use engine::client::{ClientSide, DrawList, FrameView};
use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::world::{Footprint, Registry, Tile, TilePos, TraitSet, WorldPos};
use engine::worldgen::Worldgen;
use ts_rs::TS;

/// Tiles across the long axis above which a "small" entity (`Entity::small`) is skipped by
/// `extract` (Tests added: `frameview.zoom_matches_camera_block`'s own zoom-threshold coverage).
pub const SMALL_ZOOM_THRESHOLD: f32 = 32.0;

/// A plain tile position (`Action`/`Entity` must stay `Codec`; not `engine::world::TilePos`, which
/// derives neither `Serialize` nor `TS` -- the same reason `fixtures/puts`'s own `Pos` exists).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

impl Pos {
    pub const fn tile(self) -> TilePos {
        TilePos::new(self.x, self.y)
    }
}

/// One drawable entity: a fixed position, whether it is the "small" kind `extract` hides once
/// `FrameView::zoom()` climbs past [`SMALL_ZOOM_THRESHOLD`], and which DrawList layer it draws to
/// (fix round 1, `docs/plan/17-drawlist-and-sprites.md`: `gc-drawables.ts`'s own population spreads
/// entities across several layers, including a gap, so `counters.draws_equal_nonempty_layers` has
/// more than one non-empty layer to prove against). `0` for every genesis entity (unchanged --
/// `drawlist_fixture_hash_golden`'s own three `circle(0, ...)` calls are byte-identical either way).
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity {
    pub pos: Pos,
    pub small: bool,
    pub layer: u8,
}

/// One action, `Spawn` (docs/plan/17-drawlist-and-sprites.md step 6, `layer` added fix round 1):
/// the zero-GC `drawables` page's own way to reach a few hundred entities without hand-writing them
/// into `genesis` (which stays fixed at its original three, module doc comment --
/// `drawlist_fixture_hash_golden` and `drawlist_zoom_threshold_hides_only_the_small_entity` both
/// depend on that exact count). Same shape as `fx-puts`'s own `Action::Spawn`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    Spawn { at: Pos, small: bool, layer: u8 },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Reject;
impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject
    }
}

pub struct DrawablesGen;
impl Worldgen for DrawablesGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

/// `ClientSide<Drawables>`: one circle per visible entity, skipping "small" ones once zoomed out
/// past [`SMALL_ZOOM_THRESHOLD`] (0018 §6: "`FrameView.zoom` lets a game skip or swap small
/// drawables").
#[derive(Default)]
pub struct DrawablesClient;

/// A fixed, entity-id-derived colour (`0xRRGGBBAA`) so `drawlist.fixture_hash_golden` has more
/// than one constant byte pattern to hash across records, without needing any real art.
fn color_for(id: engine::game::EntityId) -> u32 {
    (id.0.wrapping_mul(0x0101_0101)) | 0xFF
}

impl ClientSide<Drawables> for DrawablesClient {
    fn extract(&self, view: &FrameView<'_, Drawables>, out: &mut DrawList) {
        for (id, e, origin) in view.entities() {
            if e.small && view.zoom() > SMALL_ZOOM_THRESHOLD {
                continue;
            }
            let pos = WorldPos::from_tile(origin);
            out.circle(e.layer, pos, [0.5, 0.5], color_for(id));
        }
    }
}

pub struct Drawables;

impl Game for Drawables {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = DrawablesGen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Entity;
    type Player = ();
    type Global = ();
    type Presence = ();
    type Ui = ();
    type Client = DrawablesClient;

    fn register(r: &mut Registry) {
        // One prototype, footprint 1x1 (module doc comment: this fixture never spans a chunk
        // border).
        r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
    }

    fn prototype(_e: &Entity) -> engine::world::PrototypeId {
        engine::world::PrototypeId(0)
    }

    fn anchor(e: &Entity) -> TilePos {
        e.pos.tile()
    }

    /// Three fixed entities near the origin (module doc comment): two ordinary, one "small" --
    /// exactly what `frameview.zoom_matches_camera_block`'s own zoom-threshold coverage needs.
    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.spawn(Entity {
            pos: Pos { x: 0, y: 0 },
            small: false,
            layer: 0,
        });
        w.spawn(Entity {
            pos: Pos { x: 5, y: 5 },
            small: false,
            layer: 0,
        });
        w.spawn(Entity {
            pos: Pos { x: -3, y: 2 },
            small: true,
            layer: 0,
        });
    }

    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}

    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &Action) -> Result<(), Reject> {
        match *a {
            Action::Spawn { at, small, layer } => {
                w.spawn(Entity {
                    pos: at,
                    small,
                    layer,
                });
                Ok(())
            }
        }
    }

    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        a: &Action,
    ) -> Result<(), Reject> {
        match *a {
            Action::Spawn { .. } => Ok(()),
        }
    }

    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

engine::export_game!(Drawables);
