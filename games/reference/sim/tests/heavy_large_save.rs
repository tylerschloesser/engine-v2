//! `slow_heavy_large_save` (docs/plan/36-slow-tier-and-benchmarks.md step 7; 0002 section 3 "Heavy
//! mode"): the standard large save (0020 section 9) replayed twice for 300 ticks, one run
//! uninterrupted and one snapshotting and restoring into a fresh `Sim` every 100 ticks, the same
//! hashes at every tick. N = 100, not 1 (Planning decisions): a whole-save snapshot per tick takes
//! minutes and adds nothing over N = 1 on the scripted logs, where hidden state actually shows. What
//! the save adds is 262,144 furnaces with live timers, which a snapshot and restore must rebuild: the
//! run completes about 2,600 smelts a tick, so a lost or duplicated timer diverges at once.
//!
//! No log exists for a bench world: the replay is one idle frame of 300 ticks (`FrameWriter`).

mod common;
use common::bench_host::params;
use engine::bytes::ByteSink;
use engine::persist::FrameWriter;
use reference_sim::RefGame;

const SEED: u64 = 7;
const TICKS: u32 = 300;
const EVERY: u32 = 100;

struct Log(Vec<u8>);
impl ByteSink for Log {
    fn put(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
}

#[test]
fn slow_heavy_large_save() {
    let mut log = Log(Vec::new());
    FrameWriter::<RefGame>::new().finish(TICKS, &mut log);
    let result = engine::testing::replay::heavy::<RefGame>(params(SEED, 1), &log.0, EVERY);
    assert!(
        result.is_ok(),
        "heavy mode (N = {EVERY}, {TICKS} ticks) on the large save: {result:?}"
    );
}
