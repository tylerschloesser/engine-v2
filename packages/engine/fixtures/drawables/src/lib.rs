//! Fixture game `fx-drawables` (docs/plan/17-drawlist-and-sprites.md, step 2): a `Game` whose only
//! interesting behaviour is `ClientSide::extract` -- one circle per replica entity, skipping the
//! smallest ones above a zoom threshold (`frameview.zoom_matches_camera_block`'s own coverage:
//! "the record count and DrawList hash change across it and nowhere else"). `apply`/`tick` do
//! nothing; every entity is spawned once, at `genesis`, at a fixed position -- this fixture exists
//! to exercise `FrameView::entities()`/`DrawList` deterministically, not to be a realistic game.

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

/// One drawable entity: a fixed position and whether it is the "small" kind `extract` hides once
/// `FrameView::zoom()` climbs past [`SMALL_ZOOM_THRESHOLD`].
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity {
    pub pos: Pos,
    pub small: bool,
}

/// No real actions: this fixture's own state is fixed at `genesis` (module doc comment).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {}

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
            out.circle(0, pos, [0.5, 0.5], color_for(id));
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
        });
        w.spawn(Entity {
            pos: Pos { x: 5, y: 5 },
            small: false,
        });
        w.spawn(Entity {
            pos: Pos { x: -3, y: 2 },
            small: true,
        });
    }

    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}

    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &Action) -> Result<(), Reject> {
        match *a {}
    }

    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        a: &Action,
    ) -> Result<(), Reject> {
        match *a {}
    }

    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

engine::export_game!(Drawables);
