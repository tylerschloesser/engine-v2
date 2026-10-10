//! `predict_alloc` (M25 Tests added; 0012 Decision, "Measured: 0
//! allocations over 190 frames x 4 pending actions"): ported from `spikes/prediction-api/game/
//! tests/alloc.rs`, driven against the real `Host<Predict>`/`ClientCore<Predict>` instead of the
//! spike's own harness. No `#[global_allocator]` here (unlike the spike, and unlike this crate's
//! own `no_alloc_*` binaries in `crates/engine/tests/`): `fx_predict::export_game!` already installs
//! `engine::abi::Arena` (needed for the crate's own `cdylib`/`.wasm` target), and that declaration
//! reaches this native test binary through the crate's `rlib` -- a second one conflicts (fx-machines'
//! own `journal_bench.rs` documents the identical constraint). `engine::abi::arena::thread_live_bytes()`
//! (bytes allocated minus freed) is this crate's own zero-allocation instrument instead; a genuinely
//! allocation-free window leaves it completely unmoved, not merely net-zero from cancelling
//! alloc/free pairs.
//!
//! Four pending actions are dispatched through the real prediction path and then left to reset-
//! and-replay against 190 more host-produced frames they never get acked by (a second, unrelated
//! client keeps ticking the world underneath them so the frames are not all trivially empty, the
//! same "no allocation" defect `predict_frozen_predicted_tick`'s own doc comment describes -- an
//! all-empty-frame window would pass this test even with an allocating replay path, having decoded
//! nothing).

use engine::game::Game;
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile};
use engine::worldgen::Worldgen;
use fx_predict::{Action, Pos, Predict, PredictWorldgen};

fn live() -> isize {
    engine::abi::arena::thread_live_bytes()
}

/// `live_bytes()` alone (allocated minus freed) misses a transient allocation that gets freed
/// again inside the same measured window; `high_water_bytes()` (the largest `live_bytes()` has
/// ever been) catches that too, as long as the window's own transient peak exceeds whatever peak
/// came before it -- which is why the measured window below is checked against the high-water mark
/// taken *immediately before* it starts, not against zero.
fn high_water() -> isize {
    engine::abi::arena::thread_high_water_bytes()
}

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

const BORDER_ORIGIN: Pos = Pos { x: 63, y: 5 };

#[test]
fn predict_alloc() {
    let mut lb: Loopback<Predict> = Loopback::new(params(9));
    let (idx, _who_idx) =
        lb.add_client(0, dims(), Box::new(GenSource), CacheCapacity::Chunks(1024));
    let (_toucher, who_toucher) =
        lb.add_client(0, dims(), Box::new(GenSource), CacheCapacity::Chunks(1024));
    lb.set_camera(idx, camera(10, 10));
    lb.run(6);

    // An authoritative furnace, so replay frames can carry a put for an already-existing entity.
    lb.dispatch(
        idx,
        Action::Place {
            origin: Pos { x: 20, y: 20 },
        },
    );
    lb.run(8);
    assert!(
        !lb.entity_at(idx, Pos { x: 20, y: 20 }.tile())
            .unwrap()
            .is_provisional(),
        "setup furnace must be authoritative before the measured window starts"
    );

    // Four pending actions that never get acked: a border-spanning placement, two dependent
    // deposits, and a timed collect. From here on the host is driven directly (module doc
    // comment): neither `idx`'s own outbox nor `Loopback::step`'s bookkeeping is touched again, so
    // these four stay pending for the whole measured window.
    let live0 = live();
    let mut seqs = Vec::new();
    for a in [
        Action::Place {
            origin: BORDER_ORIGIN,
        },
        Action::Deposit {
            at: Pos { x: 64, y: 6 },
            count: 1,
        },
        Action::Deposit {
            at: Pos { x: 63, y: 5 },
            count: 2,
        },
        Action::Collect {
            tile: Pos { x: 9, y: 9 },
        },
    ] {
        let (seq, _status) = lb.dispatch(idx, a);
        seqs.push(seq);
    }
    let submit_growth = (live() - live0).max(0);

    // Frames built directly against the host (not `Loopback::step`, which itself allocates for
    // this testkit's own convenience -- `frame_buf[..n].to_vec()` and friends -- unrelated to the
    // code path under test): a periodic camera refresh keeps `idx`'s subscription alive past 0010's
    // 5s hold, and a second, unrelated client keeps changing `Global` so most frames carry real
    // bytes to decode, not empty ones.
    let conn = lb.conn(idx);
    let mut frame_buf = vec![0u8; 64 * 1024];
    let frames: Vec<Vec<u8>> = (1..=210u32)
        .map(|i| {
            if i % 40 == 0 {
                lb.set_camera(idx, camera(10, 10));
            }
            if i % 2 == 0 {
                lb.action(who_toucher, Action::SetGlobal { value: i as i32 });
            }
            lb.host.tick();
            let n = lb.host.build_frame(conn, &mut frame_buf);
            let bytes = if n > 0 {
                frame_buf[..n].to_vec()
            } else {
                Vec::new()
            };
            lb.host.seal();
            bytes
        })
        .collect();

    // `peak_before_replay` is taken *before the very first replay call of any kind* (warm-up
    // included): a per-call allocation that is always freed by the time that same call returns
    // (e.g. a scratch `Vec` built and dropped inside `Overlay::clear`) sets exactly one new
    // high-water mark, on its *first* occurrence, and never moves `high_water_bytes()` again on
    // later, identical calls -- so comparing high-water only around the 190-frame window (after
    // ten warm-up calls have already banked that same peak) would be blind to it. Comparing
    // against the mark from before *any* replay call catches it regardless of which call it first
    // happens on.
    let peak_before_replay = high_water();

    for f in &frames[..10] {
        if !f.is_empty() {
            lb.client_mut(idx)
                .on_frame(f)
                .expect("host-produced frames are well-formed");
        }
    }

    // Two window lengths (`no_alloc_connection.rs`'s own proof shape): equal growth at both means
    // nothing scales with the number of replay frames, not merely that one alloc/free pair inside
    // the window happened to cancel out. `during_190` is the figure 0012 measures.
    let before_190 = live();
    for f in &frames[10..200] {
        if !f.is_empty() {
            lb.client_mut(idx)
                .on_frame(f)
                .expect("host-produced frames are well-formed");
        }
    }
    let during_190 = (live() - before_190).max(0);

    let before_200 = live();
    for f in &frames[200..210] {
        if !f.is_empty() {
            lb.client_mut(idx)
                .on_frame(f)
                .expect("host-produced frames are well-formed");
        }
    }
    let during_10_more = (live() - before_200).max(0);
    let peak_growth_since_before_replay = (high_water() - peak_before_replay).max(0);

    assert_eq!(
        lb.pending(idx).count(),
        4,
        "none of the four ever got acked"
    );
    for seq in seqs {
        assert!(
            lb.pending(idx).any(|p| p.seq == seq),
            "seq {seq} still pending"
        );
    }
    println!(
        "arena growth: {submit_growth} B for 4 dispatches (human rate), {during_190} B live for \
         190 reset-and-replay frames x 4 pending actions, {during_10_more} B live for 10 more, \
         {peak_growth_since_before_replay} B peak growth over all 210 replay calls (warm-up \
         included)"
    );
    assert_eq!(during_190, 0);
    assert_eq!(during_10_more, 0);
    assert_eq!(peak_growth_since_before_replay, 0);
}
