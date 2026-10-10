//! The standard large save's tick load (docs/decisions/0020 section 9; M36
//! benchmarks.md step 4), shared by `bench_large_save.rs` (wall clock, system allocator) and
//! `bench_high_water.rs` (arena live-byte peak): a `Host<RefGame>` on the bench world with eight
//! connections, each holding a maximum view (256 x 256 tiles, ring 1: 121 chunks of the furnace
//! block) and sending one `FurnaceTake` a second. One `step` is what the sim worker does per tick
//! behind `sim_admit` / `sim_tick` / `sim_build_frame` (0014 section 4): admit the uplinks due,
//! `seal` + `tick`, then `build_frame` for every connection; the frames are discarded.
#![allow(dead_code)]

use engine::bytes::SliceSink;
use engine::game::PlayerId;
use engine::host::Host;
use engine::host::pacing::BandwidthConfig;
use engine::sim::WorldParams;
use engine::wire::{CameraReport, UplinkWriter};
use reference_sim::bench::{ENTITIES_PER_CHUNK, Shape};
use reference_sim::{RefAction, RefGame, RefParams, TileXY};

pub const PLAYERS: u32 = 8;
/// One action per second per player (0004 "active"), at 20 ticks per second (`content::SMELT` is in
/// ticks; 0006's default rate).
pub const TICKS_PER_ACTION: u32 = 20;
/// 0010: 256 tiles per axis is the maximum view.
pub const HALF_VIEW: u16 = 128;
const TX_BYTES: usize = 65_536;

/// The `WorldConfig` defaults of `host::SimConfig`, divided by `scale` (`large_save.rs` pins them).
pub fn params(seed: u64, scale: u32) -> WorldParams<RefGame> {
    WorldParams {
        seed,
        worldgen: RefParams {
            bench: scale,
            ..RefParams::default()
        },
        max_entities: 262_144 / scale,
        max_modified_tiles: 1_048_576 / scale,
        max_action_growth: 4_096,
    }
}

/// Width in chunks of the furnace block (`bench.rs` `cols`).
fn entity_cols(scale: u32) -> u32 {
    let n = Shape::scaled(scale).entity_chunks();
    let mut c = 1;
    while c * c < n {
        c += 1;
    }
    c
}

pub struct BenchHost {
    pub host: Host<RefGame>,
    pub tick: u32,
    seq: [u32; PLAYERS as usize],
    centres: [(i32, i32); PLAYERS as usize],
    scale: u32,
    tx: Vec<u8>,
    /// Bytes of every frame built by the last `step`.
    pub last_frame_bytes: usize,
}

impl BenchHost {
    /// Genesis (the standard large save at `1/scale`), eight connections with maximum-view cameras.
    pub fn new(seed: u64, scale: u32) -> Self {
        let mut host = Host::<RefGame>::genesis_for_test(params(seed, scale));
        // A CPU worst case beyond the bandwidth budget (0020 section 9): never hold a chunk back and
        // never degrade a connection, so every tick builds every frame in full.
        host.set_bandwidth(BandwidthConfig {
            unpaced: true,
            ..BandwidthConfig::default()
        });
        // Eight views spread over the furnace block, each wholly inside it at scale 1 (37 x 36 chunks
        // = 1,184 x 1,152 tiles; a view with ring 1 is 320 tiles across).
        let cols = entity_cols(scale) as i32;
        let (w, h) = (
            cols * 32,
            Shape::scaled(scale).entity_chunks().div_ceil(cols as u32) as i32 * 32,
        );
        let mut centres = [(0, 0); PLAYERS as usize];
        for (i, c) in centres.iter_mut().enumerate() {
            let (gx, gy) = (i as i32 % 4, i as i32 / 4);
            let span_x = (w - 320).max(0);
            let span_y = (h - 320).max(0);
            *c = (160 + span_x * gx / 3, 160 + span_y * (2 * gy + 1) / 4);
        }
        let mut me = BenchHost {
            host,
            tick: 0,
            seq: [0; PLAYERS as usize],
            centres,
            scale,
            tx: vec![0; TX_BYTES],
            last_frame_bytes: 0,
        };
        for conn in 0..PLAYERS {
            me.host.connect(conn);
            let (x, y) = me.centres[conn as usize];
            let camera = CameraReport {
                center_x: x,
                center_y: y,
                half_w: HALF_VIEW,
                half_h: HALF_VIEW,
                vel_x: 0,
                vel_y: 0,
            };
            let mut buf = [0u8; 64];
            let mut sink = SliceSink::new(&mut buf);
            UplinkWriter::write(&mut sink, 0, core::iter::empty(), Some(camera), None);
            let n = sink.finish().expect("camera uplink fits");
            me.host.on_uplink(conn, &buf[..n]).expect("camera uplink");
        }
        me
    }

    pub fn player(conn: u32) -> PlayerId {
        PlayerId(conn + 1)
    }

    /// A `FurnaceTake` at some furnace of `conn`'s view: a real action (most reject `NothingToTake`,
    /// the ones whose furnace just made an ingot move it), varying with `seq`.
    fn action_for(&self, conn: usize, seq: u32) -> RefAction {
        let cols = entity_cols(self.scale) as i32;
        let (cx, cy) = (self.centres[conn].0 >> 5, self.centres[conn].1 >> 5);
        let (dx, dy) = ((seq % 7) as i32 - 3, ((seq / 7) % 7) as i32 - 3);
        let (fx, fy) = ((cx + dx).clamp(0, cols - 1), (cy + dy).max(0));
        let slot = (seq * 37 + conn as u32 * 11) % ENTITIES_PER_CHUNK;
        RefAction::FurnaceTake {
            at: TileXY {
                x: fx * 32 + (slot as i32 % 16) * 2,
                y: fy * 32 + (slot as i32 / 16) * 2,
            },
        }
    }

    /// One tick as the sim worker runs it. Returns `(admit, tick, frames)` durations when `timed`.
    #[allow(clippy::disallowed_types)] // a bench's own timer never reaches state (0002 section 2)
    pub fn step(&mut self, timed: bool) -> (f64, f64, f64) {
        let t0 = timed.then(std::time::Instant::now);
        for conn in 0..PLAYERS as usize {
            // Staggered so the eight players do not all act on one tick.
            if self.tick % TICKS_PER_ACTION == (conn as u32 * 2) % TICKS_PER_ACTION {
                self.seq[conn] += 1;
                let action = self.action_for(conn, self.seq[conn]);
                let mut abuf = [0u8; 32];
                let alen = engine::codec::encode(&action, &mut abuf).expect("action fits");
                let mut buf = [0u8; 128];
                let mut sink = SliceSink::new(&mut buf);
                UplinkWriter::write(
                    &mut sink,
                    self.tick,
                    core::iter::once((self.seq[conn], &abuf[..alen])),
                    None,
                    None,
                );
                let n = sink.finish().expect("uplink fits");
                self.host.on_uplink(conn as u32, &buf[..n]).expect("uplink");
            }
        }
        let t1 = timed.then(std::time::Instant::now);
        // `sim_tick`: seals the previous tick's changes, then ticks.
        self.host.seal();
        self.host.tick();
        self.tick += 1;
        let t2 = timed.then(std::time::Instant::now);
        let mut bytes = 0;
        for conn in 0..PLAYERS {
            bytes += self.host.build_frame(conn, &mut self.tx);
        }
        self.last_frame_bytes = bytes;
        let t3 = timed.then(std::time::Instant::now);
        match (t0, t1, t2, t3) {
            (Some(a), Some(b), Some(c), Some(d)) => (
                (b - a).as_secs_f64() * 1e3,
                (c - b).as_secs_f64() * 1e3,
                (d - c).as_secs_f64() * 1e3,
            ),
            _ => (0.0, 0.0, 0.0),
        }
    }
}
