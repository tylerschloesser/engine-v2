//! `slow_highwater_large_save` (M36 step 4, M07's hand-over):
//! the arena's live-byte peak over the standard large save. The reference `sim` crate installs the
//! engine's `Arena` as its `#[global_allocator]` (`export_game!`), natively too, so its counters are
//! live in every test binary of this crate. The arena is preallocated, so `memory.buffer.byteLength` is flat at every scale and
//! is no high-water mark; `arena::high_water_bytes()` is the largest `live_bytes()` the allocator
//! has had. Measured across genesis, 240 ticks of the benchmark's load (eight maximum-view
//! connections) and one whole snapshot (which holds the encoded store in memory until drained).
//!
//! It is a **native** (64-bit) figure: pointer-heavy structures are larger than in `wasm32`, so it
//! is an upper bound of the module's. The module's own ceiling check is `bench-build @slow`'s
//! `engine_mem_grows() == 0` at `arenaBytes` = the `budgets.json` ceiling over the same work.
//! Dev profile is enough (no timing), allocation behaviour does not depend on the opt level.

use engine::abi::Instance;
use engine::abi::Status;
use engine::abi::arena::{high_water_bytes, live_bytes};

mod common;
use common::bench_host::BenchHost;

#[test]
fn slow_highwater_large_save() {
    let mut bench = BenchHost::new(7, 1);
    let after_genesis = high_water_bytes();
    let live_genesis = live_bytes();
    for _ in 0..240 {
        bench.step(false);
    }
    let after_ticks = high_water_bytes();
    let mut persist = vec![0u8; 256 * 1024];
    assert_eq!(
        Instance::sim_snapshot_begin(&mut bench.host, 0, 0),
        Status::Ok
    );
    let at_snapshot = high_water_bytes();
    let mut snapshot_bytes = 0usize;
    loop {
        let n = Instance::sim_snapshot_next(&mut bench.host, &mut persist).unwrap() as usize;
        if n == 0 {
            break;
        }
        snapshot_bytes += n;
    }
    let peak = high_water_bytes();
    println!(
        "slow_highwater_large_save: live after genesis {live_genesis} B, high water after genesis \
         {after_genesis} B, after 240 ticks {after_ticks} B, with the snapshot encoded \
         {at_snapshot} B, at the end {peak} B (snapshot {snapshot_bytes} B)"
    );
    println!(
        "BENCH_SAMPLE {{\"highWaterBytes\":{peak},\"afterTicksBytes\":{after_ticks},\"snapshotBytes\":{snapshot_bytes}}}"
    );
}
