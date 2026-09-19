// The test plan, mirrored 1:1 by src/main.rs. Self-contained (no closures) so it can be
// stringified and evaluated inside a browser page.
export function runPlan(ex, now) {
  const SEED = 0x5EED1234ABCD0042n;
  const N_CHUNKS = 2048, SIM_ENTS = 256, SIM_TICKS = 100000, RISKY_N = 200000, BENCH_CHUNKS = 2000;
  const TRIG = ["sin", "cos", "tan", "exp", "ln", "powf", "atan2", "sqrt", "cbrt", "hypot", "sin_f64", "pow_f64"];
  const NAN = ["0/0 runtime", "inf-inf", "inf*0", "sqrt(-1)", "-(0/0)", "qNaN(payload 1)+1", "sNaN(payload 1)+1",
    "sNaN f32->f64->f32 (no arithmetic)", "qNaN payload f32->f64 low32", "NaN.min(1)", "NaN*0 as i32",
    "0/0 const-folded by compiler", "normalize zero vector x/len", "two NaN payloads a+b"];
  const hex = (v) => BigInt.asUintN(64, BigInt(v)).toString(16).padStart(16, "0");
  const results = {};
  const put = (k, v) => { results[k] = hex(v); };
  put("safe_chunks", ex.safe_chunks(SEED, 0, N_CHUNKS));
  put("safe_chunks_tiles_only", ex.safe_chunks_tiles_only(SEED, 0, N_CHUNKS));
  put("safe_chunks_f64", ex.safe_chunks_f64(SEED, 0, N_CHUNKS));
  put("safe_sim_f32", ex.safe_sim_f32(SEED, SIM_ENTS, SIM_TICKS));
  put("safe_sim_fixed", ex.safe_sim_fixed(SEED, SIM_ENTS, SIM_TICKS));
  put("safe_det_trig", ex.safe_det_trig(SEED, RISKY_N));
  TRIG.forEach((n, f) => put("risky_std_" + n, ex.risky_std(f, SEED, RISKY_N)));
  TRIG.forEach((n, f) => put("risky_libm_" + n, ex.risky_libm(f, SEED, RISKY_N)));
  put("risky_mul_add_fused", ex.risky_mul_add(SEED, RISKY_N, 0));
  put("risky_mul_add_plain", ex.risky_mul_add(SEED, RISKY_N, 1));
  put("risky_mul_add_ndiffer", ex.risky_mul_add(SEED, RISKY_N, 2));
  put("risky_conv", ex.risky_conv(SEED, RISKY_N));
  put("risky_nan_hash", ex.risky_nan_hash());
  NAN.forEach((n, r) => put("nan: " + n, ex.risky_nan_row(r) >>> 0));

  ex.safe_chunks(SEED, 5000, 200); // warm-up / tier-up
  let t = now();
  const bh = ex.safe_chunks(SEED, 10000, BENCH_CHUNKS);
  const ms32 = (now() - t) / BENCH_CHUNKS;
  ex.safe_chunks_f64(SEED, 5000, 200);
  t = now();
  const bh64 = ex.safe_chunks_f64(SEED, 10000, BENCH_CHUNKS);
  const ms64 = (now() - t) / BENCH_CHUNKS;
  t = now();
  ex.safe_sim_f32(SEED, SIM_ENTS, SIM_TICKS);
  const simUs = ((now() - t) * 1000) / SIM_TICKS;
  put("bench_chunks", bh);
  put("bench_chunks_f64", bh64);
  return {
    results,
    timing: { ms_per_chunk_f32: +ms32.toFixed(5), ms_per_chunk_f64: +ms64.toFixed(5), sim_us_per_tick_256ent: +simUs.toFixed(4) },
  };
}
