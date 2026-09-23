//! Own test binary (`no_alloc_ui.rs`'s own template, M15's "measured at two window lengths,
//! asserted equal, not under a budget" shape -- docs/plan/17-drawlist-and-sprites.md's own
//! Deviations ask). Proves the DrawList path (`begin_frame` -> `G::Client::extract` ->
//! `sort_into`, all inside `frame()`) does not grow the WASM arena in steady state: the scratch
//! list is reserved once at `DrawList::new()` (`CAPACITY` = 65,536) and `begin_frame` only ever
//! `clear()`s it (capacity kept), and `sort_into` writes into the caller-owned `RegionId::DrawList`
//! region, never a growing buffer of its own.

use engine::abi::{Arena, Instance, RegionLayout, Role, Status};
use engine::client::{CameraBlock, ClientSide, DrawList, FrameView};
use engine::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
use engine::game_instance::GameInstance;
use engine::world::{ChunkCoord, PrototypeId, Registry, Tile, TilePos, WorldPos};
use engine::worldgen::Worldgen;

#[global_allocator]
static ALLOCATOR: Arena = Arena;

fn live() -> usize {
    engine::abi::arena::live_bytes()
}

#[derive(
    Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, ts_rs::TS,
)]
struct DAction;
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct DReject;
impl From<Unknown> for DReject {
    fn from(_: Unknown) -> Self {
        DReject
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct DEntity;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct DPlayer;
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct DGlobal;

struct DWorldgen;
impl Worldgen for DWorldgen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

/// A fixed number of shapes every call (module doc comment): isolates the engine's own
/// `begin_frame`/`sort_into` cost from anything a game's own `extract` might otherwise allocate
/// (it does not, here, by construction).
#[derive(Default)]
struct DClient;
impl ClientSide<DGame> for DClient {
    fn extract(&self, _view: &FrameView<'_, DGame>, out: &mut DrawList) {
        for i in 0..8i32 {
            out.circle(
                (i % 8) as u8,
                WorldPos::from_tile(TilePos::new(i, -i)),
                [1.0, 1.0],
                0xffff_ffff,
            );
        }
    }
}

struct DGame;
impl Game for DGame {
    const SCHEMA_VERSION: u32 = 1;
    type Worldgen = DWorldgen;
    type Action = DAction;
    type Reject = DReject;
    type Entity = DEntity;
    type Player = DPlayer;
    type Global = DGlobal;
    type Presence = ();
    type Ui = ();
    type Client = DClient;
    fn register(_r: &mut Registry) {}
    fn prototype(_e: &DEntity) -> PrototypeId {
        PrototypeId(0)
    }
    fn anchor(_e: &DEntity) -> TilePos {
        TilePos::new(0, 0)
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &DAction) -> Result<(), DReject> {
        Ok(())
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

fn client_instance() -> GameInstance<DGame> {
    let mut layout = RegionLayout::new();
    GameInstance::<DGame>::init(
        Role::Client,
        r#"{"seed":"0x1","params":null,"genWorkers":1,"cacheChunks":1024}"#,
        &mut layout,
    )
    .unwrap()
}

fn run(inst: &mut GameInstance<DGame>, t: f64) {
    let camera = CameraBlock::for_test([0.0, 0.0], [0.0, 0.0], [4.0, 4.0]);
    assert_eq!(inst.frame(t, &camera, &mut []), Status::Ok);
}

fn window(n: u32) -> i64 {
    let mut inst = client_instance();
    // Warm-up (JIT/allocator settling is irrelevant natively, but matches the sibling templates'
    // own shape): every buffer `frame()` touches has already reached steady state.
    for i in 0..40u32 {
        run(&mut inst, i as f64);
    }
    let before = live();
    for i in 0..n {
        run(&mut inst, (1_000 + i) as f64);
    }
    live() as i64 - before as i64
}

#[test]
fn drawlist_extract_and_sort_does_not_grow_the_arena() {
    let short = window(300);
    let long = window(1_200);
    assert_eq!(
        long,
        short,
        "the DrawList path allocates per frame: {} B over 300 frames but {} B over 1,200 frames \
         ({} B/frame of growth the longer window alone paid for)",
        short,
        long,
        (long - short) as f64 / 900.0,
    );
}
