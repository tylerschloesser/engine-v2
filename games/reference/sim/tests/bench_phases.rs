//! `slow_phases_large_save` (M39y step 2-3): the per-phase split of
//! `sim_tick` on the standard large save, natively, release profile. The same phase ids
//! (`engine::bench_phase::Phase`) are read in a `.wasm` through the loader's bench-mark hook, so
//! the two tables line up. Measurement only: recorded as a `BENCH_SAMPLE`, never gated.

mod common;
use common::bench_host::BenchHost;
use common::bench_run::run_in_release;
use engine::bench_phase::{PHASES, SAMPLE_EVERY, take};

const SEED: u64 = 7;
const WARMUP: u32 = 200;
const MEASURED: u32 = 1_200;
const NAMES: [&str; PHASES] = [
    "start",
    "records",
    "begin_tick",
    "game_tick",
    "end_tick",
    "changes",
    "results",
    "subs",
    "skip",
    "drain",
    "advance",
    "wake_at",
    "put",
    "overhead",
];

fn pct(sorted: &[u64], p: f64) -> f64 {
    let idx = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[idx] as f64 / 1e6
}

fn measure() -> String {
    let mut bench = BenchHost::new(SEED, 1);
    for _ in 0..WARMUP {
        bench.step(false);
    }
    take();
    let mut per: Vec<Vec<u64>> = vec![Vec::new(); PHASES];
    let mut totals = Vec::new();
    for _ in 0..MEASURED {
        bench.step(false);
        let t = take();
        for (i, v) in t.iter().enumerate() {
            per[i].push(*v);
        }
        totals.push(t.iter().sum::<u64>());
    }
    totals.sort_unstable();
    let mut json = format!(
        "{{\"total\":[{:.4},{:.4}]",
        pct(&totals, 0.5),
        pct(&totals, 0.95)
    );
    println!(
        "slow_phases_large_save: sim_tick p50 {:.3} / p95 {:.3} ms",
        pct(&totals, 0.5),
        pct(&totals, 0.95)
    );
    for v in per.iter_mut() {
        v.sort_unstable();
    }
    let k = f64::from(SAMPLE_EVERY);
    // Each sampled sub-phase (9..=12) includes one `mark`'s own cost: `overhead` (13).
    let (o50, o95) = (pct(&per[13], 0.5), pct(&per[13], 0.95));
    for (i, v) in per.iter().enumerate().skip(1) {
        let (p50, p95) = match i {
            9..=12 => (
                ((pct(v, 0.5) - o50).max(0.0)) * k,
                ((pct(v, 0.95) - o95).max(0.0)) * k,
            ),
            13 => (o50 * k, o95 * k),
            _ => (pct(v, 0.5), pct(v, 0.95)),
        };
        println!("  {:<11} p50 {p50:.3} / p95 {p95:.3} ms", NAMES[i]);
        json.push_str(&format!(",\"{}\":[{p50:.4},{p95:.4}]", NAMES[i]));
    }
    json.push('}');
    json
}

#[test]
fn slow_phases_large_save() {
    if cfg!(debug_assertions) {
        let sample = run_in_release("bench_phases", "slow_phases_large_save");
        assert!(sample.contains("game_tick"), "{sample}");
    } else {
        println!("BENCH_SAMPLE {}", measure());
    }
}
