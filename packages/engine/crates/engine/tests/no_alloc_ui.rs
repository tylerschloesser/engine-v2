//! Own test binary (mirrors `no_alloc_connection.rs`/`no_alloc_terrain.rs`: only a dedicated
//! binary's `#[global_allocator]` is actually counted). Proves the constant-`Ui` path of
//! docs/plan/16b-ui-observation-and-clock.md's `ui` call policy does not grow the WASM arena
//! (`.claude/rules/hot-paths.md`): `frame(t_ms)` runs `ClientSide::ui` every frame a host frame
//! was applied, but a value that never differs from the one last emitted is never serialised again
//! after the one real change (`Default` -> the constant value, on the very first call).
//!
//! M15's own template: measured at two window lengths and asserted **equal**, not under a budget
//! -- a reused buffer settling at its steady-state capacity costs the same in both windows, while
//! anything allocating per frame costs proportionally more in the longer one.

use engine::abi::{Arena, Instance, RegionLayout, Role, Status};
use engine::bytes::SliceSink;
use engine::client::{CameraBlock, ClientSide, FrameView};
use engine::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
use engine::game_instance::GameInstance;
use engine::wire::{FrameHeader, FrameWriter};
use engine::world::{ChunkCoord, PrototypeId, Registry, Tile, TilePos};
use engine::worldgen::Worldgen;

#[global_allocator]
static ALLOCATOR: Arena = Arena;

fn live() -> usize {
    engine::abi::arena::live_bytes()
}

#[derive(
    Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, ts_rs::TS,
)]
struct NAction;
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct NReject;
impl From<Unknown> for NReject {
    fn from(_: Unknown) -> Self {
        NReject
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NEntity;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NPlayer;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct NGlobal;

/// A constant, `Copy`-only `Ui`: isolates the engine's own policy cost from whatever a game's own
/// `Ui` impl might otherwise allocate (0003: "`Ui` may own `Vec`/`String`", Non-scope here).
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, ts_rs::TS)]
struct NUi {
    motd_id: u32,
}

struct NWorldgen;
impl Worldgen for NWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

#[derive(Default)]
struct NClient;
impl ClientSide<NGame> for NClient {
    fn ui(&self, _view: &FrameView<'_, NGame>, out: &mut NUi) {
        out.motd_id = 7; // the same value, every call
    }
}

struct NGame;
impl Game for NGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = NWorldgen;
    type Action = NAction;
    type Reject = NReject;
    type Entity = NEntity;
    type Player = NPlayer;
    type Global = NGlobal;
    type Presence = ();
    type Ui = NUi;
    type Client = NClient;
    fn register(_r: &mut Registry) {}
    fn prototype(_e: &NEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(_e: &NEntity) -> TilePos {
        TilePos::new(0, 0)
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &NAction) -> Result<(), NReject> {
        Ok(())
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

fn client_instance() -> GameInstance<NGame> {
    let mut layout = RegionLayout::new();
    GameInstance::<NGame>::init(
        Role::Client,
        r#"{"seed":"0x1","params":null,"genWorkers":1,"cacheChunks":1024}"#,
        &mut layout,
    )
    .unwrap()
}

/// One heartbeat frame (no sections) at `tick`: enough for `on_frame` to bump `ClientCore::
/// mutations()` (docs/plan/16b-ui-observation-and-clock.md: "iff a frame mutated the replica since
/// the last call") without needing any real replicated state.
fn heartbeat(tick: u32) -> Vec<u8> {
    let mut buf = [0u8; 32];
    let mut sink = SliceSink::new(&mut buf);
    FrameWriter::new(&mut sink, FrameHeader { tick, ack_seq: 0 });
    let n = sink.finish().unwrap();
    buf[..n].to_vec()
}

fn run(inst: &mut GameInstance<NGame>, tick: u32) {
    assert_eq!(inst.on_frame(&heartbeat(tick)), Status::Ok);
    let camera = CameraBlock::for_test([0.0, 0.0], [0.0, 0.0], [4.0, 4.0]);
    assert_eq!(inst.frame(tick as f64, &camera, &mut []), Status::Ok);
}

fn window(n: u32) -> i64 {
    let mut inst = client_instance();
    // Warm-up, past the one real change (`Default` -> the constant value) that only the very
    // first `run` call ever produces, so every buffer it touches (the swap pair, `ui_buf`'s own
    // one-time growth for that single record) has already settled before `before` is sampled.
    for i in 0..40u32 {
        run(&mut inst, i);
    }
    let before = live();
    for i in 0..n {
        run(&mut inst, 1_000 + i);
    }
    live() as i64 - before as i64
}

#[test]
fn ui_constant_value_does_not_grow_the_arena() {
    let short = window(300);
    let long = window(1_200);
    assert_eq!(
        long,
        short,
        "the constant-Ui frame() path allocates per frame: {} B over 300 frames but {} B over \
         1,200 frames ({} B/frame of growth the longer window alone paid for)",
        short,
        long,
        (long - short) as f64 / 900.0,
    );
}
