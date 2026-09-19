//! Native runner. Mirrors driver/plan.mjs exactly (same keys, same parameters).
use determinism_hash::{api, NAN_NAMES, N_NAN_ROWS, N_TRIG_FNS, TRIG_NAMES};
use std::time::Instant;

const SEED: u64 = 0x5EED_1234_ABCD_0042;
const N_CHUNKS: u32 = 2048;
const SIM_ENTS: u32 = 256;
const SIM_TICKS: u32 = 100_000;
const RISKY_N: u32 = 200_000;
const BENCH_CHUNKS: u32 = 2000;

fn main() {
    let env = std::env::args().nth(1).unwrap_or_else(|| "native".into());
    let mut out: Vec<(String, String)> = Vec::new();
    let mut put = |k: &str, v: u64| out.push((k.to_string(), format!("{v:016x}")));

    put("safe_chunks", api::safe_chunks(SEED, 0, N_CHUNKS));
    put("safe_chunks_tiles_only", api::safe_chunks_tiles_only(SEED, 0, N_CHUNKS));
    put("safe_chunks_f64", api::safe_chunks_f64(SEED, 0, N_CHUNKS));
    put("safe_sim_f32", api::safe_sim_f32(SEED, SIM_ENTS, SIM_TICKS));
    put("safe_sim_fixed", api::safe_sim_fixed(SEED, SIM_ENTS, SIM_TICKS));
    put("safe_det_trig", api::safe_det_trig(SEED, RISKY_N));
    for f in 0..N_TRIG_FNS {
        put(&format!("risky_std_{}", TRIG_NAMES[f as usize]), api::risky_std(f, SEED, RISKY_N));
    }
    for f in 0..N_TRIG_FNS {
        put(&format!("risky_libm_{}", TRIG_NAMES[f as usize]), api::risky_libm(f, SEED, RISKY_N));
    }
    put("risky_mul_add_fused", api::risky_mul_add(SEED, RISKY_N, 0));
    put("risky_mul_add_plain", api::risky_mul_add(SEED, RISKY_N, 1));
    put("risky_mul_add_ndiffer", api::risky_mul_add(SEED, RISKY_N, 2));
    put("risky_conv", api::risky_conv(SEED, RISKY_N));
    put("risky_nan_hash", api::risky_nan_hash());
    for r in 0..N_NAN_ROWS {
        put(&format!("nan: {}", NAN_NAMES[r as usize]), api::risky_nan_row(r) as u64);
    }

    // Timing: warm up, then time BENCH_CHUNKS chunks (different coords from the warm-up).
    let _ = api::safe_chunks(SEED, 5000, 200);
    let t = Instant::now();
    let bh = api::safe_chunks(SEED, 10_000, BENCH_CHUNKS);
    let ms_f32 = t.elapsed().as_secs_f64() * 1000.0 / BENCH_CHUNKS as f64;
    let _ = api::safe_chunks_f64(SEED, 5000, 200);
    let t = Instant::now();
    let bh64 = api::safe_chunks_f64(SEED, 10_000, BENCH_CHUNKS);
    let ms_f64 = t.elapsed().as_secs_f64() * 1000.0 / BENCH_CHUNKS as f64;
    let t = Instant::now();
    let _ = api::safe_sim_f32(SEED, SIM_ENTS, SIM_TICKS);
    let sim_us_tick = t.elapsed().as_secs_f64() * 1.0e6 / SIM_TICKS as f64;
    put("bench_chunks", bh);
    put("bench_chunks_f64", bh64);

    let results: Vec<String> = out.iter().map(|(k, v)| format!("    {:?}: {:?}", k, v)).collect();
    println!(
        "{{\n  \"env\": {:?},\n  \"results\": {{\n{}\n  }},\n  \"timing\": {{ \"ms_per_chunk_f32\": {:.5}, \"ms_per_chunk_f64\": {:.5}, \"sim_us_per_tick_256ent\": {:.4} }}\n}}",
        env,
        results.join(",\n"),
        ms_f32,
        ms_f64,
        sim_us_tick
    );
}
