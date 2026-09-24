//! `FrameCx<'a, G>` (docs/plan/18-picking-and-overlay.md Scope, steps 4-6: "fills M12's `FrameCx`
//! shell"; 0003, 0019 §1/§4): the per-client-frame context `ClientSide::frame` receives -- the
//! camera block, this frame's own `dt_ms`, the input events drained from `inputRing` since the
//! previous `frame` call, the same `FrameView` `extract` receives, and the write-only `follow`/
//! `ui_dirty` hooks (0024 §7d). `game_instance.rs`'s own `GameInstance::frame` builds one fresh per
//! real `frame(t_ms)` call, in the order the brief's Scope pins: "build `FrameView` -> `ClientSide
//! ::frame` -> `extract` -> header (`follow`, anchors) -> sort -> publish -> clear `InputQueue`".
//!
//! No `dispatch` here (Planning decisions, docs/plan/18-picking-and-overlay.md): action `seq` is
//! assigned on main so `client.dispatch` can return it synchronously (0003); a game turns a tap into
//! an action in `client.input.on('tap', ..)`, not here.

use crate::client::{CameraBlock, InputEvent};
use crate::game::{FrameView, Game};
use crate::world::WorldPos;

/// The per-client-frame context `ClientSide::frame` receives (module doc comment). Every accessor
/// borrows for `'a`, the same lifetime `view`/`camera`/`input` themselves borrow from -- nothing
/// here outlives the one `frame()` call that builds it.
pub struct FrameCx<'a, G: Game> {
    view: &'a FrameView<'a, G>,
    camera: &'a CameraBlock,
    dt_ms: f32,
    input: &'a [InputEvent],
    follow: Option<WorldPos>,
    ui_dirty: bool,
}

impl<'a, G: Game> FrameCx<'a, G> {
    /// `game_instance.rs`-only: a game never builds one itself (0003: the engine calls `ClientSide
    /// ::frame`, never the reverse).
    pub(crate) fn new(
        view: &'a FrameView<'a, G>,
        camera: &'a CameraBlock,
        dt_ms: f32,
        input: &'a [InputEvent],
    ) -> Self {
        FrameCx {
            view,
            camera,
            dt_ms,
            input,
            follow: None,
            ui_dirty: false,
        }
    }

    /// The same value `extract` receives (Provides).
    pub fn view(&self) -> &FrameView<'a, G> {
        self.view
    }

    /// M06b's camera block, M17's `viewport_px` (Provides): centre, velocity, `tiles_across`, half
    /// extents, `dpr` -- what the reference game's spring reads.
    pub fn camera(&self) -> &CameraBlock {
        self.camera
    }

    /// Difference of successive `frame_time_ms`, clamped to `0..100` (Provides).
    pub fn dt_ms(&self) -> f32 {
        self.dt_ms
    }

    /// Events drained from `inputRing` since the previous `frame` call, oldest first, at most 64,
    /// valid for this call only (Provides).
    pub fn input(&self) -> &[InputEvent] {
        self.input
    }

    /// Sets this frame's follow target (0019 §1). Written to the DrawList header's `follow_valid`/
    /// `follow` fields once `frame` returns (`game_instance.rs`, `DrawList::sort_into`'s own `follow`
    /// parameter), read by the main thread's `camera.setFollow` in the frame that draws that slot.
    /// `None` (the default every call starts from) clears any previous target.
    pub fn follow(&mut self, target: Option<WorldPos>) {
        self.follow = target;
    }

    /// Sets M16b's client-side `ui` dirty flag (0024 §7d): `ui` re-runs this same frame when `frame`
    /// changed state `Ui` depends on, even with no new host mutation since the last check.
    pub fn ui_dirty(&mut self) {
        self.ui_dirty = true;
    }

    /// `game_instance.rs`-only: this frame's follow target, after `ClientSide::frame` returned.
    pub(crate) fn take_follow(&self) -> Option<WorldPos> {
        self.follow
    }

    /// `game_instance.rs`-only: whether `ui_dirty()` was called this frame.
    pub(crate) fn took_ui_dirty(&self) -> bool {
        self.ui_dirty
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::Clocks;
    use crate::game::{PlayerEvent, PlayerId, TickCx, Unknown, WorldRead, WorldWrite};
    use crate::world::{PrototypeId, Registry, Tile, TilePos, TraitSet};
    use crate::worldgen::Worldgen;

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct FxEntity;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct FxPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct FxGlobal;
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct FxAction;
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct FxReject;
    impl From<Unknown> for FxReject {
        fn from(_: Unknown) -> Self {
            FxReject
        }
    }

    struct FxWorldgen;
    impl Worldgen for FxWorldgen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: crate::world::ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    struct FxGame;
    impl Game for FxGame {
        const SCHEMA_VERSION: u32 = 0;
        type Worldgen = FxWorldgen;
        type Action = FxAction;
        type Reject = FxReject;
        type Entity = FxEntity;
        type Player = FxPlayer;
        type Global = FxGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();

        fn register(_r: &mut Registry) {}
        fn prototype(_e: &FxEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &FxEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(
            _w: &mut dyn WorldWrite<Self>,
            _who: PlayerId,
            _a: &FxAction,
        ) -> Result<(), FxReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    struct FxWorld;
    impl WorldRead<FxGame> for FxWorld {
        fn tick(&self) -> crate::time::Tick {
            crate::time::Tick(0)
        }
        fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
            Err(Unknown)
        }
        fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
            Err(Unknown)
        }
        fn entity_at(&self, _p: TilePos) -> Result<Option<crate::game::EntityId>, Unknown> {
            Ok(None)
        }
        fn entity(&self, _id: crate::game::EntityId) -> Result<Option<&FxEntity>, Unknown> {
            Ok(None)
        }
        fn player(&self, _who: PlayerId) -> Result<&FxPlayer, Unknown> {
            Err(Unknown)
        }
        fn global(&self) -> &FxGlobal {
            &FxGlobal
        }
    }

    fn events(n: usize) -> Vec<InputEvent> {
        (0..n)
            .map(|i| InputEvent {
                kind: crate::client::input::kind::TAP,
                seq: i as u32,
                ..Default::default()
            })
            .collect()
    }

    /// `framecx.input_slice_order_and_clear` (Tests added): `cx.input()` hands back exactly the
    /// slice it was built with, in the same (ring) order -- the "clear" half of this test's name is
    /// `game_instance.rs`'s own responsibility (`InputQueue::clear()` after `frame` returns, proven
    /// by `client/ui.rs`-style integration coverage there, not by this type in isolation, since
    /// `FrameCx` itself never touches the queue).
    #[test]
    fn framecx_input_slice_order_and_clear() {
        let world = FxWorld;
        let entities = std::collections::BTreeMap::new();
        let registry = Registry::new();
        let remote = crate::client::RemotePresences::<FxGame>::new();
        let view = FrameView::new(
            &world as &dyn WorldRead<FxGame>,
            Clocks::default(),
            PlayerId(1),
            &entities,
            &registry,
            crate::world::TileRect::new(TilePos::new(0, 0), TilePos::new(0, 0)),
            0.0,
            0.0,
            None,
            TilePos::new(0, 0),
            0.0,
            (),
            &remote,
        );
        let camera = CameraBlock::for_test([0.0, 0.0], [0.0, 0.0], [10.0, 10.0]);
        let evs = events(3);
        let cx = FrameCx::<FxGame>::new(&view, &camera, 16.0, &evs);
        assert_eq!(cx.input().len(), 3);
        assert_eq!(cx.input()[0].seq, 0);
        assert_eq!(cx.input()[2].seq, 2);
        assert_eq!(cx.dt_ms(), 16.0);
    }

    #[test]
    fn framecx_follow_defaults_to_none_and_records_a_set_target() {
        let world = FxWorld;
        let entities = std::collections::BTreeMap::new();
        let registry = Registry::new();
        let remote = crate::client::RemotePresences::<FxGame>::new();
        let view = FrameView::new(
            &world as &dyn WorldRead<FxGame>,
            Clocks::default(),
            PlayerId(1),
            &entities,
            &registry,
            crate::world::TileRect::new(TilePos::new(0, 0), TilePos::new(0, 0)),
            0.0,
            0.0,
            None,
            TilePos::new(0, 0),
            0.0,
            (),
            &remote,
        );
        let camera = CameraBlock::for_test([0.0, 0.0], [0.0, 0.0], [10.0, 10.0]);
        let evs: Vec<InputEvent> = Vec::new();
        let mut cx = FrameCx::<FxGame>::new(&view, &camera, 16.0, &evs);
        assert_eq!(cx.take_follow(), None);
        assert!(!cx.took_ui_dirty());

        cx.follow(Some(WorldPos { x: 256, y: 512 }));
        cx.ui_dirty();
        assert_eq!(cx.take_follow(), Some(WorldPos { x: 256, y: 512 }));
        assert!(cx.took_ui_dirty());
    }
}
