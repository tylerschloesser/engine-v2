//! `slow_tick_large_save` and `slow_snapshot_large_save` (docs/decisions/0020 section 9, 0010 "Tick
//! CPU budget"; docs/plan/36-slow-tier-and-benchmarks.md step 4): wall-clock benchmarks of the
//! standard large save at full scale, **release profile**. The slow nextest profile builds the dev
//! profile, so under it each test re-runs itself as `cargo test --release -p reference-sim --test
//! bench_large_save -- --exact <name>` (the inner run measures, prints one `BENCH_SAMPLE <json>`
//! line) and the outer one feeds the sample to `scripts/lib/bench-gate.mjs` (the 25 % rule and the
//! 0010 proxy, applied only on the baseline machine; elsewhere it records to
//! `test-results/rust/bench/`). A test compiled in release (`cargo nextest run --release`) measures
//! inline.
//!
//! What a tick covers here (0010): the admitted uplinks (`Host::on_uplink`, the body of
//! `sim_admit`), `seal` + `Host::tick` (`sim_tick`), and `Host::build_frame` for each of eight
//! connections holding a maximum view (`sim_build_frame`), frames discarded. Not covered: the
//! write-ahead log append (a few actions a tick) and the TS host's fan-out; the Node twin
//! (`tick-large-save node @slow`) runs the `.wasm` through `createWorldServer`.

mod common;
use common::bench_host::{BenchHost, PLAYERS};
use common::bench_run::{gate, run_in_release};
use engine::abi::Instance;

const SEED: u64 = 7;
/// 0020 section 9: 1,200 ticks after 200 warm-up ticks.
const WARMUP: u32 = 200;
const MEASURED: u32 = 1_200;
/// 0005 "Idle pause": five ticks per wakeup; 0018 section 9's phone factor makes the desktop
/// proxy a third of that window.
const SNAPSHOT_PROXY_MS: f64 = 5.0 * 50.0 / 3.0;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[idx]
}

fn sorted(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v
}

fn measure_tick() -> String {
    let mut bench = BenchHost::new(SEED, 1);
    // The join: the first ticks after the eight connections subscribe (121 dense chunks each),
    // reported separately from the steady state the gate uses.
    let mut join = Vec::new();
    let mut join_bytes = 0usize;
    for _ in 0..40 {
        let (a, t, f) = bench.step(true);
        join.push(a + t + f);
        join_bytes += bench.last_frame_bytes;
    }
    for _ in 40..WARMUP {
        bench.step(false);
    }
    let (mut total, mut admit, mut tick, mut frames) = (vec![], vec![], vec![], vec![]);
    let mut bytes = 0usize;
    for _ in 0..MEASURED {
        let (a, t, f) = bench.step(true);
        total.push(a + t + f);
        admit.push(a);
        tick.push(t);
        frames.push(f);
        bytes += bench.last_frame_bytes;
    }
    let (total, admit, tick, frames) = (sorted(total), sorted(admit), sorted(tick), sorted(frames));
    let join = sorted(join);
    let median = percentile(&total, 0.5);
    let p99 = percentile(&total, 0.99);
    println!(
        "slow_tick_large_save: {PLAYERS} players x 121 chunks, {MEASURED} ticks after {WARMUP}: \
         median {median:.3} ms, p99 {p99:.3} ms, max {:.3} ms; split of the median: admit {:.3}, tick {:.3}, \
         frames {:.3} ms; {} B of frames per tick; join (first 40 ticks): max {:.3} ms, median {:.3} ms, {} B per tick",
        total[total.len() - 1],
        percentile(&admit, 0.5),
        percentile(&tick, 0.5),
        percentile(&frames, 0.5),
        bytes / MEASURED as usize,
        join[join.len() - 1],
        percentile(&join, 0.5),
        join_bytes / 40,
    );
    format!(
        "{{\"medianMs\":{median:.4},\"p99Ms\":{p99:.4},\"maxMs\":{:.4},\"tickMedianMs\":{:.4},\
         \"framesMedianMs\":{:.4},\"frameBytesPerTick\":{},\"joinMaxMs\":{:.4}}}",
        total[total.len() - 1],
        percentile(&tick, 0.5),
        percentile(&frames, 0.5),
        bytes / MEASURED as usize,
        join[join.len() - 1],
    )
}

#[test]
fn slow_tick_large_save() {
    let sample = if cfg!(debug_assertions) {
        run_in_release("bench_large_save", "slow_tick_large_save")
    } else {
        let s = measure_tick();
        println!("BENCH_SAMPLE {s}");
        return;
    };
    gate("tick", &sample);
}

fn measure_snapshot() -> String {
    #[allow(clippy::disallowed_types)] // a bench's own timer never reaches state
    use std::time::Instant;
    let mut bench = BenchHost::new(SEED, 1);
    for _ in 0..60 {
        bench.step(false);
    }
    let mut persist = vec![0u8; 256 * 1024];
    let t0 = Instant::now();
    assert_eq!(
        Instance::sim_snapshot_begin(&mut bench.host, 0, 0),
        engine::abi::Status::Ok
    );
    let begin_ms = t0.elapsed().as_secs_f64() * 1e3;
    let (mut bytes, mut calls) = (0usize, 0u32);
    loop {
        let n = Instance::sim_snapshot_next(&mut bench.host, &mut persist).expect("next") as usize;
        if n == 0 {
            break;
        }
        bytes += n;
        calls += 1;
    }
    let total_ms = t0.elapsed().as_secs_f64() * 1e3;
    let verdict = if total_ms <= SNAPSHOT_PROXY_MS {
        "inside"
    } else {
        "OUTSIDE"
    };
    println!(
        "slow_snapshot_large_save: begin {begin_ms:.1} ms (the whole store is encoded here), drain \
         {calls} calls to {bytes} B, total {total_ms:.1} ms: {verdict} the desktop proxy of \
         {SNAPSHOT_PROXY_MS:.1} ms (a third of five 50 ms tick intervals, 0005 + 0018 section 9)"
    );
    if total_ms > SNAPSHOT_PROXY_MS {
        println!(
            "warn: snapshot of the large save takes {total_ms:.1} ms, over {SNAPSHOT_PROXY_MS:.1} ms"
        );
    }
    format!("{{\"beginMs\":{begin_ms:.3},\"totalMs\":{total_ms:.3},\"lastSnapshotBytes\":{bytes}}}")
}

#[test]
fn slow_snapshot_large_save() {
    if cfg!(debug_assertions) {
        let sample = run_in_release("bench_large_save", "slow_snapshot_large_save");
        // Recorded, never gated: no baseline (the answer is the proxy line above).
        gate("snapshot", &sample);
    } else {
        println!("BENCH_SAMPLE {}", measure_snapshot());
    }
}
