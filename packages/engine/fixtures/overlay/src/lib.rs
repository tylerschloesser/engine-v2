//! Fixture game `fx-overlay` (docs/plan/18-picking-and-overlay.md, Files touched: "`fixtures/
//! overlay/`: pickable circles, slot anchors, a ghost and a follow toggle"). Steps 4-6 build only
//! what those steps' own browser tests need -- a real `ClientSide::frame` that makes `cx.input()`
//! observably reach the DOM overlay through `client.onUi` (`framecx.tap_visible_in_frame`,
//! `framecx.emit_visible_in_frame`), which needs a real WASM instance's `FrameCx` (picking, static
//! and slot anchors, and `follow` itself are all provable with a hand-filled `DrawList` SAB over a
//! real `Client` with no WASM at all, `real-camera.ts`'s own precedent, `tests/browser/{pick,overlay,
//! follow}.spec.ts`) -- and is deliberately left easy for a later step to grow: `genesis` spawns no
//! entities yet, and `extract`/`ui_dirty`'s own trigger condition (any input this frame) are the only
//! behaviour here, so step 7 can add the cursor-anchored ghost to `extract` and a real follow-target
//! rule to `frame` without restructuring anything.

use engine::client::{ClientSide, FrameCx, FrameView};
use engine::game::{
    Game, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead, WorldWrite,
};
use engine::world::{Registry, Tile, TilePos, TraitSet};
use engine::worldgen::Worldgen;
use std::cell::Cell;
use ts_rs::TS;

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
