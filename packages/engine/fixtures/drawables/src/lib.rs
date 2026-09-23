//! Fixture game `fx-drawables` (docs/plan/17-drawlist-and-sprites.md, steps 2 and 6; docs/plan/
//! 17b-sprites-and-frame-budget.md fix round 1): a `Game` whose only interesting behaviour is
//! `ClientSide::extract` -- one circle (or, for an entity with `sprite: true`, one `sprite_id::QUAD`
//! sprite instead) per replica entity, skipping the smallest ones above a zoom threshold
//! (`frameview.zoom_matches_camera_block`'s own coverage: "the record count and DrawList hash
//! change across it and nowhere else"). `genesis` still spawns exactly three fixed entities
//! (unchanged since step 2: `drawlist_fixture_hash_golden`/`drawlist_zoom_threshold_hides_only_the_
//! small_entity` depend on that count, every genesis entity's own `sprite` is `false`); the one
//! `Action`, `Spawn` (step 6), is how the `drawables` zero-GC page reaches a few hundred entities
//! without touching `genesis` -- always accepted, no rejection path. `tick` does nothing.

use engine::client::{ClientSide, DrawList, FrameView, SpriteId};
use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::world::{Footprint, Registry, Tile, TilePos, TraitSet, WorldPos};
use engine::worldgen::Worldgen;
use std::cell::Cell;
use ts_rs::TS;

/// Sprite ids this fixture's own atlas holds (docs/plan/17b-sprites-and-frame-budget.md Scope:
/// "add `SpriteId` constants helper for fixtures only"; `scripts/gen-sprite-art.mjs`'s own
/// `sprites.json` output, `tests/browser/pages/public/drawables/`). Fixtures-only, not part of the
/// engine crate's own `client` module: `SpriteId` itself and `DrawList::sprite` already exist (M17),
/// this is just names for the three ids the fixture atlas happens to hold. `QUAD` is read by
/// `extract` (fix round 1: `Entity::sprite`); `STRIP`/`BLEED` are not dispatched by any entity,
/// reached only through `drawables.html`'s own hand-filled `sprite.*` probes.
pub mod sprite_id {
    use super::SpriteId;

    /// A four-quadrant flat-colour cell, pivot `[0.25, 0.75]`, size `[2, 1]` tiles, one frame.
    pub const QUAD: SpriteId = SpriteId(0);
    /// Three 8x8 frames laid left to right (cyan/magenta/orange), pivot `[0.5, 0.5]`, size `[1, 1]`.
    pub const STRIP: SpriteId = SpriteId(1);
    /// A flat-red 32x32 cell next to an unlisted flat-blue neighbour, separated only by its own 2px
    /// extruded padding -- the `sprite.no_bleed_at_mip1` fixture, pivot `[0.5, 0.5]`, size `[1, 1]`.
    pub const BLEED: SpriteId = SpriteId(2);
}

thread_local! {
    /// Test-only observation hook (docs/plan/17-drawlist-and-sprites.md, fix round 1):
    /// `extract` records `view.px_per_tile()` here on every call, so a native test can observe
    /// the real `game_instance.rs` wiring end to end (`GameInstance::frame` -> `extract`) without
    /// touching any `Draw` record -- `drawlist_fixture_hash_golden` is unaffected, since nothing
    /// about the DrawList bytes changes. `thread_local`, not a plain `static`/`AtomicU32`: this
    /// crate's own tests (`cargo nextest`) run on separate threads, and a `Cell<f32>` needs no
    /// `to_bits` (`.claude/rules/determinism.md`'s own ban -- `extract` is client-only, outside
    /// the deterministic core, so the rule does not bind this value's *meaning*, but there is no
    /// reason to reach for it when a thread-local `Cell` avoids the question entirely). Never read
    /// by `extract`/`Drawables` itself.
    pub static LAST_PX_PER_TILE: Cell<f32> = const { Cell::new(0.0) };
}

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
/// `FrameView::zoom()` climbs past [`SMALL_ZOOM_THRESHOLD`], which DrawList layer it draws to
/// (fix round 1, `docs/plan/17-drawlist-and-sprites.md`: `gc-drawables.ts`'s own population spreads
/// entities across several layers, including a gap, so `counters.draws_equal_nonempty_layers` has
/// more than one non-empty layer to prove against), and whether `extract` draws it as a sprite
/// (`sprite_id::QUAD`) instead of a circle (docs/plan/17b-sprites-and-frame-budget.md fix round 1:
/// "the drawables zero-GC page loads sprites and draws some"). `false`/`0`/`false` for every
/// genesis entity (unchanged -- `drawlist_fixture_hash_golden`'s own three `circle(0, ...)` calls
/// are byte-identical either way).
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity {
    pub pos: Pos,
    pub small: bool,
    pub layer: u8,
    pub sprite: bool,
}

/// One action, `Spawn` (docs/plan/17-drawlist-and-sprites.md step 6, `layer` added fix round 1,
/// `sprite` added docs/plan/17b-sprites-and-frame-budget.md fix round 1): the zero-GC `drawables`
/// page's own way to reach a few hundred entities without hand-writing them into `genesis` (which
/// stays fixed at its original three, module doc comment -- `drawlist_fixture_hash_golden` and
/// `drawlist_zoom_threshold_hides_only_the_small_entity` both depend on that exact count). Same
/// shape as `fx-puts`'s own `Action::Spawn`. `SpawnMany` (steps 4-6, `bench.frame_worstcase`,
/// "Notes for cut 2": "No bulk-spawn action") is the benchmark's own way to reach a 65,536-record
/// frame without a one-dispatch-per-entity loop -- always accepted, no rejection path, same as
/// `Spawn`. Every entity it creates is `small: false` (Known from cut 1, blocker 3:
/// `SMALL_ZOOM_THRESHOLD` would otherwise drop it at the benchmark's own max-zoom-out camera).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    Spawn {
        at: Pos,
        small: bool,
        layer: u8,
        sprite: bool,
    },
    /// A `cols` x `rows` grid of entities, `spacing` tiles apart on both axes, `origin` the
    /// grid's own top-left tile -- one call spawns `cols * rows` entities in a single admitted
    /// action, so the benchmark's own setup (`frame-bench.ts`) needs one dispatch per *batch*
    /// (kept well under the host's own 64 KiB per-tick frame budget, `host::mod::SIM_TX_BYTES`;
    /// Non-scope here, so batching on the dispatch side is the fix, not growing that constant),
    /// not one per entity.
    SpawnMany {
        origin: Pos,
        cols: u32,
        rows: u32,
        spacing: i32,
        layer: u8,
        sprite: bool,
    },
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
        LAST_PX_PER_TILE.with(|c| c.set(view.px_per_tile()));
        for (id, e, origin) in view.entities() {
            if e.small && view.zoom() > SMALL_ZOOM_THRESHOLD {
                continue;
            }
            let pos = WorldPos::from_tile(origin);
            if e.sprite {
                out.sprite(e.layer, pos, sprite_id::QUAD);
            } else {
                out.circle(e.layer, pos, [0.5, 0.5], color_for(id));
            }
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
            sprite: false,
        });
        w.spawn(Entity {
            pos: Pos { x: 5, y: 5 },
            small: false,
            layer: 0,
            sprite: false,
        });
        w.spawn(Entity {
            pos: Pos { x: -3, y: 2 },
            small: true,
            layer: 0,
            sprite: false,
        });
    }

    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}

    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &Action) -> Result<(), Reject> {
        match *a {
            Action::Spawn {
                at,
                small,
                layer,
                sprite,
            } => {
                w.spawn(Entity {
                    pos: at,
                    small,
                    layer,
                    sprite,
                });
                Ok(())
            }
            Action::SpawnMany {
                origin,
                cols,
                rows,
                spacing,
                layer,
                sprite,
            } => {
                for r in 0..rows {
                    for c in 0..cols {
                        w.spawn(Entity {
                            pos: Pos {
                                x: origin.x + (c as i32) * spacing,
                                y: origin.y + (r as i32) * spacing,
                            },
                            small: false,
                            layer,
                            sprite,
                        });
                    }
                }
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
            Action::SpawnMany { .. } => Ok(()),
        }
    }

    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

engine::export_game!(Drawables);
