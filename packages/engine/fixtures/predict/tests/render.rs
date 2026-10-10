//! `swap_is_one_render`/`reject_is_one_render` (M26
//! step 2, "expected green by construction ... the failability proof is what makes them
//! evidence"): drives `PredictClient::extract`/`ui` through a real, prediction-merged `FrameView`
//! (`testing::testkit::Loopback::frame_view`) every frame from dispatch through well after the
//! ack, reading back the real `DrawList` bytes `sort_into` produces -- not a re-implementation of
//! the merge.

use engine::client::drawlist::{DRAW_BYTES, HEADER_BYTES, PREDICTED, REGION_BYTES, hash_region};
use engine::client::{ClientSide, DrawList};
use engine::game::{Game, PlayerId};
use engine::predict::Prediction;
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile, TilePos, TileRect,
};
use engine::worldgen::Worldgen;
use fx_predict::{
    Action, Pos, Predict, PredictClient, PredictWorldgen, START_COAL, START_FURNACES, Ui,
};

struct GenSource;
impl PristineSource for GenSource {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        PredictWorldgen::generate(0, &(), chunk, out);
    }
}

fn dims() -> ChunkDims {
    ChunkDims::new(Predict::CHUNK_BITS)
}

fn params(seed: u64) -> WorldParams<Predict> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    }
}

fn loopback(seed: u64) -> Loopback<Predict> {
    Loopback::new(params(seed))
}

fn add_client(lb: &mut Loopback<Predict>, delay: u32) -> (usize, PlayerId) {
    lb.add_client(
        delay,
        dims(),
        Box::new(GenSource),
        CacheCapacity::Chunks(1024),
    )
}

fn camera(cx: i32, cy: i32) -> CameraReport {
    CameraReport {
        center_x: cx,
        center_y: cy,
        half_w: 1,
        half_h: 1,
        vel_x: 0,
        vel_y: 0,
    }
}

const WIDE: TileRect = TileRect::new(TilePos::new(0, 0), TilePos::new(20, 20));

/// One rendered frame: `PredictClient::extract`/`ui` through a real, prediction-merged
/// `FrameView` (`Loopback::frame_view`), the region bytes `sort_into` wrote, and the record count.
fn render(lb: &Loopback<Predict>, idx: usize) -> (Vec<u8>, u32, Ui) {
    let view = lb.frame_view(idx, WIDE, TilePos::new(0, 0));
    let mut dl = DrawList::new();
    dl.begin_frame(TilePos::new(0, 0));
    let client = PredictClient;
    client.extract(&view, &mut dl);
    let mut out = vec![0u8; REGION_BYTES];
    let n = dl.sort_into(&mut out, 0.0, None);
    let mut ui = Ui::default();
    client.ui(&view, &mut ui);
    (out, n, ui)
}

/// Every `Draw` record's own `(pos, flags)`, in `sort_into`'s own order.
fn draws(region: &[u8], n: u32) -> Vec<([f32; 2], u8)> {
    (0..n as usize)
        .map(|i| {
            let base = HEADER_BYTES + i * DRAW_BYTES;
            let x = f32::from_le_bytes(region[base..base + 4].try_into().unwrap());
            let y = f32::from_le_bytes(region[base + 4..base + 8].try_into().unwrap());
            let flags = region[base + 19];
            ([x, y], flags)
        })
        .collect()
}

/// How many `Draw` records sit at exactly `pos` (window origin is `(0, 0)` throughout this file,
/// so a `Draw`'s own `pos` is the anchor tile's coordinates, unscaled).
fn draws_at(region: &[u8], n: u32, pos: TilePos) -> Vec<u8> {
    draws(region, n)
        .into_iter()
        .filter(|&(p, _)| p == [pos.x as f32, pos.y as f32])
        .map(|(_, flags)| flags)
        .collect()
}

/// **Exactly one `Draw` on the anchor tile from dispatch through 10 frames after the ack;
/// `PREDICTED` reads `1...1 0...0` with its single transition in the frame that applied the ack;
/// `Ui` inventory constant throughout** (Tests added, verbatim). Delay 3, so the ack lands
/// `2*delay+1 = 7` steps after dispatch (the spike's own figure, unchanged by M26).
#[test]
fn swap_is_one_render() {
    let mut lb = loopback(1);
    let (idx, _who) = add_client(&mut lb, 3);
    lb.set_camera(idx, camera(10, 10));
    lb.run(4);

    let origin = Pos { x: 5, y: 5 };
    let (_seq, st) = lb.dispatch(idx, Action::Place { origin });
    assert_eq!(st, Prediction::Applied);

    let mut predicted_bits = Vec::new();
    let mut ui_values = Vec::new();
    let mut ack_frame = None;

    let (region, n, ui) = render(&lb, idx);
    assert_eq!(draws_at(&region, n, origin.tile()), vec![PREDICTED]);
    predicted_bits.push(PREDICTED != 0);
    ui_values.push(ui);

    for step in 0..17u32 {
        let pending_before = lb.pending(idx).count();
        lb.step();
        let pending_after = lb.pending(idx).count();
        if ack_frame.is_none() && pending_before == 1 && pending_after == 0 {
            ack_frame = Some(step);
        }

        let (region, n, ui) = render(&lb, idx);
        let flags = draws_at(&region, n, origin.tile());
        assert_eq!(
            flags.len(),
            1,
            "step {step}: expected exactly one Draw on the anchor tile, got {flags:?}"
        );
        predicted_bits.push(flags[0] & PREDICTED != 0);
        ui_values.push(ui);

        // Stop 10 frames after the ack (Tests added: "10 frames after the ack").
        if let Some(a) = ack_frame
            && step >= a + 10
        {
            break;
        }
    }

    assert!(
        ack_frame.is_some(),
        "the ack never landed within the window"
    );
    let ack = ack_frame.unwrap();

    // `1...1 0...0`, one transition, at the ack's own render (index `ack + 1`: the render taken
    // right after the ack-applying `step` call).
    let mut transitions = 0;
    for i in 1..predicted_bits.len() {
        if predicted_bits[i] != predicted_bits[i - 1] {
            transitions += 1;
        }
    }
    assert_eq!(transitions, 1, "predicted_bits: {predicted_bits:?}");
    assert!(predicted_bits[0], "starts predicted");
    assert!(
        !predicted_bits[ack as usize + 1],
        "unpredicted once the ack landed"
    );

    // Ui inventory: constant throughout (converges with no visible change, at the Ui level too).
    for (i, ui) in ui_values.iter().enumerate() {
        assert_eq!(
            *ui,
            Ui {
                furnaces: START_FURNACES - 1,
                coal: START_COAL,
            },
            "ui changed at index {i}: {ui_values:?}"
        );
    }
}

/// **A rival's real placement lands on the exact same tile before the reject ack: never zero or
/// two `Draw`s at that shared anchor, and the ghost's disappearance coincides exactly with the
/// item's refund** (ghost XOR refund, in the same `DrawList`+`Ui`), Tests added verbatim.
#[test]
fn reject_is_one_render() {
    let mut lb = loopback(2);
    let (slow, _who_slow) = add_client(&mut lb, 4);
    let (_fast, who_fast) = add_client(&mut lb, 1);
    lb.set_camera(slow, camera(10, 10));
    lb.set_camera(_fast, camera(10, 10));
    lb.run(4);

    let origin = Pos { x: 5, y: 5 };

    // The rival's placement is admitted for real, at the *same* origin, before `slow` ever
    // predicts its own -- the two race for one physical tile.
    lb.action(who_fast, Action::Place { origin });
    lb.step();

    let (_seq, st) = lb.dispatch(slow, Action::Place { origin });
    assert_eq!(
        st,
        Prediction::Applied,
        "slow has not yet heard about the rival's real machine"
    );

    // Rejection is read off the ghost's own disappearance plus the refund (0012's own "ghost XOR
    // refund"): this testkit path has no separate `ClientEvent`-style notification to drain, and
    // the two together are exactly what a rejection *means* here (`predict_rival_takes_the_spot_
    // never_torn`'s own by-value equivalent, `fixtures/predict/tests/loopback.rs`).
    let mut saw_ghost = false;
    let mut saw_ghost_gone = false;
    for step in 0..14 {
        lb.step();

        let (region, n, ui) = render(&lb, slow);
        let flags = draws_at(&region, n, origin.tile());
        assert_eq!(
            flags.len(),
            1,
            "step {step}: never zero or two Draws on the shared anchor tile, got {flags:?}"
        );
        let ghost_here = flags[0] & PREDICTED != 0;
        let refunded = ui.furnaces == START_FURNACES;
        if ghost_here {
            saw_ghost = true;
            assert!(
                !refunded,
                "step {step}: ghost still drawn but item already refunded (torn state): {ui:?}"
            );
        } else {
            if saw_ghost {
                saw_ghost_gone = true;
            }
            assert!(
                refunded,
                "step {step}: ghost gone but item not refunded in the same Ui: {ui:?}"
            );
        }
    }
    assert!(
        saw_ghost && saw_ghost_gone,
        "expected to see the ghost, then see it rolled back: saw_ghost={saw_ghost} \
         saw_ghost_gone={saw_ghost_gone}"
    );
}

/// **Identical overlay content gives an identical DrawList hash on consecutive frames** (Tests
/// added, verbatim): once a predicted `Place` has landed and nothing else changes (no new
/// dispatch, no ack yet -- delay 3), re-running `extract`/`sort_into` every frame must not perturb
/// `hash_region` (0018's own native-vs-`.wasm` parity hash, excluding `frame_seq`/`frame_time_ms`
/// by construction -- see its own doc comment), even though the replay loop re-runs `G::apply`
/// from scratch every single frame.
#[test]
fn drawlist_hash_stable_across_replays() {
    let mut lb = loopback(3);
    let (idx, _who) = add_client(&mut lb, 4);
    lb.set_camera(idx, camera(10, 10));
    lb.run(10);

    let origin = Pos { x: 5, y: 5 };
    let (_seq, st) = lb.dispatch(idx, Action::Place { origin });
    assert_eq!(st, Prediction::Applied);

    let (region0, n0, _) = render(&lb, idx);
    let hash0 = hash_region(&region0, n0);

    for step in 0..3 {
        lb.step();
        let (region, n, _) = render(&lb, idx);
        let hash = hash_region(&region, n);
        assert_eq!(
            hash, hash0,
            "step {step}: DrawList hash changed across an unchanged replay"
        );
    }
}
