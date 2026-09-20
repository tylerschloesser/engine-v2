//! Fixture game `hash`: the smallest module with state worth hashing. It runs the three
//! computations docs/decisions/0002 §2 measured (an f32 spring sim using only `+ - *`, the same
//! sim in 16.16 fixed point, a SplitMix64 action stream) and hashes raw state bits, so the golden
//! in `golden/` proves they agree natively, under Node, under Bun and in browsers.
//!
//! Config switches exist for the loader tests: `panicAtTick`, `growAtTick`, `exhaustAtTick`.

use engine::abi::config::HexU64;
use engine::abi::{Instance, RegionId, RegionLayout, Role, Status};
use engine::client::CameraBlock;
use engine::hash::{Fnv64, hash_value};

const MAX_ENTITIES: u32 = 1024;
const INPUT_MAX: usize = 16;
const FRAME_BYTES: usize = 64;
/// Far more than any arena a test configures.
const EXHAUST_BYTES: usize = 64 << 20;
/// `Rx`/`Tx` for the `Client` role only (docs/plan/06b-workers-and-spawn.md, Deviations): the
/// `echo` zero-GC page round-trips 10 KiB per frame through these two regions. `Sim`/`Gen` keep the
/// 64-byte pair below unchanged, so `golden/golden.json` (Sim-role only) stays byte-identical.
const CLIENT_RX_TX_BYTES: usize = 10 * 1024;

const K: f32 = 40.0;
const C: f32 = 6.0;
const DT: f32 = 0.016_666_668; // a literal, not 1.0 / 60.0
const U16: f32 = 1.0 / 65536.0;

const K_FX: i64 = 40 << 16;
const C_FX: i64 = 6 << 16;
const DT_FX: i64 = 1092; // about 1/60 in 16.16

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    seed: HexU64,
    entities: u32,
    panic_at_tick: Option<u32>,
    grow_at_tick: Option<u32>,
    exhaust_at_tick: Option<u32>,
}

#[derive(Clone, Copy, Default)]
struct Body<T> {
    p: [T; 2],
    v: [T; 2],
    target: [T; 2],
}

/// A `Codec` field of [`Sample`]: entity 0 is coasting, or was last pushed towards a target with
/// this much speed-squared (bits, so the finite-float rule of 0002 §3 is a `debug_assert`, not a
/// guess).
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
enum Motion {
    Idle,
    Moving { speed_sq_bits: u32 },
}

/// Part of `HashFixture`'s state, encoded through `engine::codec::Codec` and folded into
/// [`HashFixture::sim_hash`] with `engine::hash::hash_value` (docs/plan/05-codec-and-state-hash.md
/// Order of work 5): ints, an enum, an `Option`, a fixed array, and finite f32 and f64, the same
/// byte-level foundation `codec_sample`'s golden exercises, here proven to agree natively, under
/// Node, under Bun and in three browsers through the fixture's own cross-runtime golden.
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
struct Sample {
    tick: u32,
    rng: u64,
    motion: Motion,
    last_touched: Option<u16>,
    grid: [i32; 2],
    x: f32,
    y: f64,
}

pub struct HashFixture {
    cfg: Config,
    tick: u32,
    rng: u64,
    float: Vec<Body<f32>>,
    fixed: Vec<Body<i32>>,
    input: [u8; INPUT_MAX],
    input_len: usize,
    /// Entity touched by the most recently admitted input, if any yet ([`Sample::last_touched`]).
    last_touched: Option<u16>,
}

/// SplitMix64 finaliser.
fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Raw float bits, so drift cannot hide behind a threshold (0002 §3).
// `to_bits` is banned because NaN bits differ between CPUs. No NaN can arise here: the sim uses
// only `+ - *` on bounded values, and the assert keeps that honest.
#[allow(clippy::disallowed_methods)]
fn bits(v: f32) -> u32 {
    debug_assert!(v.is_finite());
    v.to_bits()
}

impl HashFixture {
    fn next_random(&mut self) -> u64 {
        self.rng = self.rng.wrapping_add(0x9E37_79B9_7F4A_7C15);
        mix64(self.rng)
    }

    /// Input admitted since the last tick becomes impulses: 4 bytes each, entity (u16 LE) then a
    /// signed x and y in half units.
    fn apply_input(&mut self) {
        let n = self.float.len();
        for k in 0..self.input_len / 4 {
            let b = &self.input[k * 4..k * 4 + 4];
            let e = (b[0] as usize | (b[1] as usize) << 8) % n;
            for d in 0..2 {
                let push = b[2 + d] as i8;
                self.float[e].v[d] += push as f32 * 0.5;
                self.fixed[e].v[d] = self.fixed[e].v[d].wrapping_add((push as i32) << 15);
            }
            self.last_touched = Some(e as u16);
        }
        self.input_len = 0;
    }

    /// Four "actions" per tick: retarget an entity.
    fn retarget(&mut self) {
        let n = self.float.len() as u64;
        for _ in 0..4 {
            let r = self.next_random();
            let e = (r % n) as usize;
            for d in 0..2 {
                let word = (r >> (16 + 16 * d)) & 0xffff;
                self.float[e].target[d] = (word as f32 * U16 - 0.5) * 200.0;
                self.fixed[e].target[d] = ((word as i64 - 32768) * 200) as i32;
            }
        }
    }

    /// Semi-implicit Euler on both sims.
    fn integrate(&mut self) {
        for body in &mut self.float {
            for d in 0..2 {
                let acc = K * (body.target[d] - body.p[d]) - C * body.v[d];
                body.v[d] += acc * DT;
                body.p[d] += body.v[d] * DT;
            }
        }
        for body in &mut self.fixed {
            for d in 0..2 {
                let (p, v, target) = (body.p[d] as i64, body.v[d] as i64, body.target[d] as i64);
                let acc = ((K_FX * (target - p)) >> 16) - ((C_FX * v) >> 16);
                body.v[d] = (v + ((acc * DT_FX) >> 16)) as i32;
                body.p[d] = (p + ((body.v[d] as i64 * DT_FX) >> 16)) as i32;
            }
        }
    }
}

impl Instance for HashFixture {
    fn init(role: Role, game_cfg_json: &str, layout: &mut RegionLayout) -> Result<Self, Status> {
        let cfg: Config = serde_json::from_str(game_cfg_json).map_err(|_| Status::BadConfig)?;
        if cfg.entities == 0 || cfg.entities > MAX_ENTITIES {
            return Err(Status::BadConfig);
        }
        let (rx_bytes, tx_bytes) = if role == Role::Client {
            (CLIENT_RX_TX_BYTES as u32, CLIENT_RX_TX_BYTES as u32)
        } else {
            (64, FRAME_BYTES as u32)
        };
        layout.region(RegionId::Rx, rx_bytes);
        layout.region(RegionId::Tx, tx_bytes);
        let n = cfg.entities as usize;
        Ok(HashFixture {
            tick: 0,
            rng: cfg.seed.0,
            float: vec![Body::default(); n],
            fixed: vec![Body::default(); n],
            input: [0; INPUT_MAX],
            input_len: 0,
            last_touched: None,
            cfg,
        })
    }

    fn sim_admit(&mut self, _conn: u32, rx: &[u8]) -> Status {
        if rx.len() > INPUT_MAX {
            return Status::BadLength;
        }
        self.input[..rx.len()].copy_from_slice(rx);
        self.input_len = rx.len();
        Status::Ok
    }

    fn sim_tick(&mut self) -> Status {
        self.tick += 1;
        let now = Some(self.tick);
        if self.cfg.panic_at_tick == now {
            panic!("fx-hash: panicAtTick {}", self.tick);
        }
        if self.cfg.grow_at_tick == now {
            // Straight to the instruction, so the arena sees nothing (`exhaustAtTick` is the
            // allocator's switch).
            #[cfg(target_arch = "wasm32")]
            core::arch::wasm32::memory_grow(0, 1);
        }
        if self.cfg.exhaust_at_tick == now {
            let past_the_arena: Vec<u8> = Vec::with_capacity(EXHAUST_BYTES);
            core::hint::black_box(&past_the_arena);
        }
        self.apply_input();
        self.retarget();
        self.integrate();
        Status::Ok
    }

    /// 64 bytes: the tick as u64, then the float position of the first seven entities.
    fn sim_build_frame(&mut self, _conn: u32, tx: &mut [u8]) -> Result<u32, Status> {
        let frame = tx.get_mut(..FRAME_BYTES).ok_or(Status::BadLength)?;
        frame.fill(0);
        frame[..8].copy_from_slice(&(self.tick as u64).to_le_bytes());
        for (body, out) in self.float.iter().zip(frame[8..].chunks_exact_mut(8)) {
            out[..4].copy_from_slice(&bits(body.p[0]).to_le_bytes());
            out[4..].copy_from_slice(&bits(body.p[1]).to_le_bytes());
        }
        Ok(FRAME_BYTES as u32)
    }

    fn sim_hash(&mut self) -> u64 {
        let mut h = Fnv64::new();
        let e0 = &self.float[0];
        let speed_sq = e0.v[0] * e0.v[0] + e0.v[1] * e0.v[1];
        let sample = Sample {
            tick: self.tick,
            rng: self.rng,
            motion: if speed_sq == 0.0 {
                Motion::Idle
            } else {
                Motion::Moving {
                    speed_sq_bits: bits(speed_sq),
                }
            },
            last_touched: self.last_touched,
            grid: self.fixed[0].p,
            x: e0.p[0],
            y: e0.p[1] as f64,
        };
        h.write_u64(hash_value(&sample));
        for body in &self.float {
            for v in [body.p, body.v, body.target].as_flattened() {
                h.write_u32(bits(*v));
            }
        }
        for body in &self.fixed {
            for v in [body.p, body.v, body.target].as_flattened() {
                h.write_u32(*v as u32);
            }
        }
        h.finish()
    }

    /// docs/plan/06b-workers-and-spawn.md, Tests added `workers.camera_block_reaches_wasm`:
    /// `centre` (two `f64`) then `t_ms` (one `f64`), raw little-endian bytes, so the browser test
    /// can prove `CameraBlock`'s Rust layout agrees with `camera/block.ts`'s bit for bit, not just
    /// that JS copied bytes into the region (which would be true regardless of layout agreement).
    fn frame(&mut self, t_ms: f64, camera: &CameraBlock, result: &mut [u8]) -> Status {
        let Some(out) = result.get_mut(..24) else {
            return Status::BadLength;
        };
        out[0..8].copy_from_slice(&camera.centre[0].to_le_bytes());
        out[8..16].copy_from_slice(&camera.centre[1].to_le_bytes());
        out[16..24].copy_from_slice(&t_ms.to_le_bytes());
        Status::Ok
    }
}

engine::export_instance!(HashFixture);
