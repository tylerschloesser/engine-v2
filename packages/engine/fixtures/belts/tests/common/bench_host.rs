//! The belt world's tick load (M45, M36's `games/reference/sim/tests/common/bench_host.rs` shape):
//! a `Host<Belts>` on M40's standard `Mixed` world built at genesis (`fx_belts::bench`), with eight
//! connections each holding a maximum view (256 x 256 tiles) spread over the world. One `step` is
//! what the sim worker does per tick (0014 section 4): admit (no actions: the belts move by
//! themselves), `seal` + `tick`, then `build_frame` for every connection; the frames are
//! discarded. Included by `#[path]` (the `props.rs` pattern).
#![allow(dead_code)]

use engine::bytes::SliceSink;
use engine::host::Host;
use engine::host::pacing::BandwidthConfig;
use engine::sim::WorldParams;
use engine::wire::{CameraReport, UplinkWriter};
use fx_belts::bench::world::BenchWorld;
use fx_belts::{Belts, BeltsParams, BenchSpec};

pub const PLAYERS: u32 = 8;
/// 0010: 256 tiles per axis is the maximum view.
pub const HALF_VIEW: u16 = 128;
/// M40's world seed (0077 A1).
pub const SEED: u32 = 7;
/// The sim worker's Tx region (`host::SIM_TX_BYTES`), as M36.
const TX_BYTES: usize = 65_536;

/// The bench world's item cap: 1.5 x 0076 §8's recommended 262,144, so the `Mixed` world's
/// natural population (M40 measured 315,444 items after 1,400 ticks uncapped) never meets it. At
/// the recommended cap the spawners in active-list order took the slots the sinks freed and the
/// window was not the `Mixed` regime (M45 review, finding 1). The benchmark pins the world, not the
/// game's caps; the line cap stays the recommended 32,768.
pub const BENCH_MAX_ITEMS: u32 = 393_216;

/// The bench world's params: the caps above, room for the spawners, nothing else of the state
/// budget used.
pub fn params(spec: BenchSpec) -> WorldParams<Belts> {
    WorldParams {
        seed: 1,
        worldgen: BeltsParams { bench: Some(spec) },
        max_entities: 4_096,
        max_modified_tiles: 4_096,
        max_action_growth: 4_096,
        max_lines: engine::transport::DEFAULT_MAX_LINES,
        max_items: BENCH_MAX_ITEMS,
    }
}

/// The plain-data world `spec` builds (the counts genesis must reach): `fx_belts::bench::world_of`,
/// the regime's edits included.
pub fn world_of(spec: BenchSpec) -> BenchWorld {
    fx_belts::bench::world_of(spec)
}

pub struct BenchHost {
    pub host: Host<Belts>,
    pub tick: u32,
    tx: Vec<u8>,
    /// Bytes of every frame built by the last `step`.
    pub last_frame_bytes: usize,
}

impl BenchHost {
    /// Genesis of `spec`'s world, eight connections with maximum-view cameras.
    pub fn new(spec: BenchSpec) -> Self {
        Self::with_host(Host::<Belts>::genesis_for_test(params(spec)), spec, 0)
    }

    /// `host` (a genesis or a restored world of `spec`, at `tick`) with the same eight connections.
    pub fn with_host(mut host: Host<Belts>, spec: BenchSpec, tick: u32) -> Self {
        let world = world_of(spec);
        // A CPU worst case beyond the bandwidth budget (0020 section 9, as M36): never hold a chunk
        // back and never degrade a connection, so every tick builds every frame in full.
        host.set_bandwidth(BandwidthConfig {
            unpaced: true,
            ..BandwidthConfig::default()
        });
        // Eight views stacked over the world's tile extent (220 x 545 tiles at full scale, seed 7:
        // a row per belt chain), evenly from the top edge to the bottom one, so together they see
        // every line and each sees about half the world.
        let (w, h) = (world.width as i32, world.height as i32);
        let (span_x, span_y) = ((w - 256).max(0), (h - 256).max(0));
        let mut me = BenchHost {
            host,
            tick,
            tx: vec![0; TX_BYTES],
            last_frame_bytes: 0,
        };
        for conn in 0..PLAYERS {
            me.host.connect(conn);
            let camera = CameraReport {
                center_x: 128 + span_x / 2,
                center_y: 128 + span_y * conn as i32 / (PLAYERS as i32 - 1),
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

    /// One tick as the sim worker runs it. Returns `(admit, tick, frames)` durations in ms when
    /// `timed`. Admit is empty: no player acts.
    #[allow(clippy::disallowed_types)] // a bench's own timer never reaches state (0002 section 2)
    pub fn step(&mut self, timed: bool) -> (f64, f64, f64) {
        let t0 = timed.then(std::time::Instant::now);
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
