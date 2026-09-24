//! Fixture game `fx-overlay` (docs/plan/18-picking-and-overlay.md, Files touched: "`fixtures/
//! overlay/`: pickable circles, slot anchors, a ghost and a follow toggle"). Steps 4-6 built the
//! minimal `ClientSide::frame`/`cx.input()`/`cx.ui_dirty()` proof (module doc comment history:
//! `genesis` spawns no entities, `extract` was still the default no-op). Step 7-8 fill `extract`
//! (`&self`, read-only -- 0003 "Outside the deterministic core": this file is client-side
//! presentation, not sim/apply code, so `std::f32::sin/cos` below is fine, unlike `.claude/rules/
//! determinism.md`'s ban inside the deterministic core) with three unconditional, always-drawn
//! groups every page that loads this fixture shares: `RING_COUNT` pickable rings on a fixed grid
//! (`pick_id` 1..=50, `docs/plan/18-picking-and-overlay.md` step 8's device-page/GC-page "50
//! pickables" requirement), `ANCHOR_SLOT_COUNT` small circles orbiting the origin whose position is
//! *also* published through `DrawList::anchor` (0019 §5's own "a moving position the game's Rust
//! publishes"), and a cursor-anchored ghost (`ANCHOR_CURSOR_TILE`, 0019 "Cursor tile and ghost") that
//! exists only while `FrameView::cursor_tile()` is `Some` (mouse hovering, or a touch device's last
//! tap -- `input/semantic.ts`'s own tap handler sets `cameraState.cursorTile*` for exactly this).

use engine::client::{ANCHOR_CURSOR_TILE, ClientSide, DrawList, FrameCx, FrameView};
use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::world::{Registry, Tile, TilePos, TraitSet, WorldPos};
use engine::worldgen::Worldgen;
use std::cell::Cell;
use std::f32::consts::TAU;
use ts_rs::TS;

/// Device page / GC page "50 pickables" (module doc comment). A 10x5 grid, 3 tiles apart, centred
/// on the origin so `RING_COLS/2`th column, `RING_ROWS/2`th row sits exactly at world tile `(0,
/// 0)` -- a convenient, exact-coordinates target for a browser test to click.
const RING_COUNT: i32 = 50;
const RING_COLS: i32 = 10;
const RING_ROWS: i32 = 5;
const RING_SPACING_TILES: i32 = 3;
/// Tile diameter of a ring (pick radius = half this, `input/pick.ts`'s own "distance from `pos` <=
/// `size.x / 2`" containment rule).
const RING_SIZE_TILES: f32 = 1.2;
const RING_COLOR: u32 = 0xffaa33ff;

/// 0019 §5's own "4 slots" precedent (`docs/plan/18-picking-and-overlay.md` step 8, GC page
/// `anchors`' own "4 slot anchors"): small circles orbiting the origin, `DrawList::anchor`
/// published every frame so `client.overlay.anchorSlot` has something moving to follow.
const ANCHOR_SLOT_COUNT: u8 = 4;
const ANCHOR_ORBIT_RADIUS_TILES: f32 = 6.0;
const ANCHOR_SIZE_TILES: f32 = 0.6;
const ANCHOR_COLOR: u32 = 0x33aaffff;
/// Radians/ms: one full orbit every 8 seconds -- slow enough that a GC page's own 600-frame window
/// (10 s at 60 Hz) sees just short of one full loop, fast enough that `overlay.slot_anchor_follows_
/// rust`-style motion is visible within a handful of frames.
const ANCHOR_ANGULAR_RATE: f32 = TAU / 8000.0;

const GHOST_SIZE_TILES: f32 = 1.0;
const GHOST_COLOR: u32 = 0x44ffffaa;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Action;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Reject;
impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject
    }
}

/// What `client.onUi` observes (docs/plan/18-picking-and-overlay.md Tests added: `framecx.
/// tap_visible_in_frame`, `framecx.emit_visible_in_frame`): the last `cx.input()` event's own raw
/// fields, whichever kind it was -- a real tap (`kind == 1`, `pick_id`/`tile` are that event's own
/// pick id and tile) or a `client.input.emit` record (`kind == 7`, the same two fields carrying
/// `code`/`a` per `InputEvent::code()`/`a()`'s own doc comments) read back identically, since both
/// are the same wire layout. `count` lets a test tell "no event yet" (`0`) from "an event landed but
/// every field happens to be zero".
#[derive(Clone, Copy, PartialEq, Default, serde::Serialize, TS)]
#[ts(export)]
pub struct OverlayUi {
    pub count: u32,
    pub last_kind: u8,
    pub last_pick_id: u32,
    pub last_tile_x: i32,
    pub last_tile_y: i32,
}

pub struct OverlayGen;
impl Worldgen for OverlayGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

/// `ClientSide<Overlay>`: records the last `cx.input()` event (module doc comment) and forces `ui`
/// to rerun this same frame whenever one arrives (`cx.ui_dirty()`) -- with no replica mutation on
/// this fixture's own path (`apply`/`tick` never write), `ui.maybe_run`'s "a frame mutated the
/// replica" half of its call policy would otherwise never fire, so this is a real, not merely
/// convenient, use of the dirty flag: `Ui` here depends entirely on client-side state (0024 §7d).
#[derive(Default)]
pub struct OverlayClient {
    count: Cell<u32>,
    last_kind: Cell<u8>,
    last_pick_id: Cell<u32>,
    last_tile: Cell<[i32; 2]>,
}

impl ClientSide<Overlay> for OverlayClient {
    fn frame(&mut self, cx: &mut FrameCx<'_, Overlay>, _presence: &mut ()) {
        if let Some(last) = cx.input().last() {
            self.count.set(self.count.get().wrapping_add(1));
            self.last_kind.set(last.kind);
            self.last_pick_id.set(last.pick_id);
            self.last_tile.set(last.tile);
            cx.ui_dirty();
        }
    }

    fn ui(&self, _view: &FrameView<'_, Overlay>, out: &mut OverlayUi) {
        out.count = self.count.get();
        out.last_kind = self.last_kind.get();
        out.last_pick_id = self.last_pick_id.get();
        let tile = self.last_tile.get();
        out.last_tile_x = tile[0];
        out.last_tile_y = tile[1];
    }

    /// Module doc comment: rings (pickable), moving anchors (`DrawList::anchor` + a visible
    /// marker), then the cursor-anchored ghost. Unconditional every frame (no entities, no state
    /// dependency) except the ghost, which only exists while a cursor tile is live.
    fn extract(&self, view: &FrameView<'_, Overlay>, out: &mut DrawList) {
        for i in 0..RING_COUNT {
            let col = i % RING_COLS;
            let row = i / RING_COLS;
            let tx = (col - RING_COLS / 2) * RING_SPACING_TILES;
            let ty = (row - RING_ROWS / 2) * RING_SPACING_TILES;
            // Tile-centred (`+ 0.5` tile): matches the main-thread `worldX/Y` a page anchors its
            // own DOM button to for the same ring (`tx + 0.5`, `ty + 0.5`).
            let pos = WorldPos {
                x: tx * 256 + 128,
                y: ty * 256 + 128,
            };
            out.ring(0, pos, [RING_SIZE_TILES, RING_SIZE_TILES], RING_COLOR)
                .pick_id = (i + 1) as u32;
        }

        let t = view.time_ms() as f32;
        for slot in 0..ANCHOR_SLOT_COUNT {
            let angle = t * ANCHOR_ANGULAR_RATE + (slot as f32) * (TAU / ANCHOR_SLOT_COUNT as f32);
            // `.claude/rules/determinism.md`'s transcendentals ban is for the deterministic core
            // (sim/worldgen/apply, 0002 §2: native-vs-WASM bit parity); this value is a per-frame
            // client-side draw position, never replicated, hashed or read back into game state
            // (0003 "Outside the deterministic core") -- the two runtimes drawing a moving marker
            // one float-ULP apart is invisible and inconsequential.
            #[allow(clippy::disallowed_methods)]
            let wx = angle.cos() * ANCHOR_ORBIT_RADIUS_TILES;
            #[allow(clippy::disallowed_methods)]
            let wy = angle.sin() * ANCHOR_ORBIT_RADIUS_TILES;
            let pos = WorldPos {
                x: (wx * 256.0) as i32,
                y: (wy * 256.0) as i32,
            };
            out.circle(1, pos, [ANCHOR_SIZE_TILES, ANCHOR_SIZE_TILES], ANCHOR_COLOR);
            out.anchor(slot, pos);
        }

        if view.cursor_tile().is_some() {
            // `ANCHOR_CURSOR_TILE` makes the shader place this instance at the *live* cursor tile
            // (`uberquad.wgsl`'s own `origin_tile = frame.cursor_tile`), not at `view.cursor_tile()`
            // read here -- a stale `pos` would still track correctly next frame. Zero offset from
            // that origin: `relative_pos(WorldPos::from_tile(view.window_origin()))` is exactly
            // `(0, 0)`, so the ghost sits on the origin tile the flag selects.
            let pos = WorldPos::from_tile(view.window_origin());
            out.ghost(2, pos, [GHOST_SIZE_TILES, GHOST_SIZE_TILES], GHOST_COLOR)
                .flags |= ANCHOR_CURSOR_TILE;
        }
    }
}

pub struct Overlay;

impl Game for Overlay {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = OverlayGen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Entity;
    type Player = ();
    type Global = ();
    type Presence = ();
    type Ui = OverlayUi;
    type Client = OverlayClient;

    fn register(r: &mut Registry) {
        r.add_prototype(TraitSet::EMPTY, engine::world::Footprint { w: 1, h: 1 });
    }

    fn prototype(_e: &Entity) -> engine::world::PrototypeId {
        engine::world::PrototypeId(0)
    }

    fn anchor(_e: &Entity) -> TilePos {
        TilePos::new(0, 0)
    }

    /// No entities yet (module doc comment): steps 4-6's own tests never need one, and leaving this
    /// empty keeps `DrawList::sort_into`'s own `record_count` at `0` throughout, which is exactly
    /// what `extract`'s still-default no-op body produces anyway.
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}

    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}

    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &Action) -> Result<(), Reject> {
        Ok(())
    }

    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &Action,
    ) -> Result<(), Reject> {
        Ok(())
    }

    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

engine::export_game!(Overlay);
