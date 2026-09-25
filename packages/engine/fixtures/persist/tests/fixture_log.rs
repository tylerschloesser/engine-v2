//! Records and checks in `fx-persist`'s own log + checkpoint hashes (docs/plan/
//! 22-persistence-log-and-snapshots.md Order of work step 3). Regenerated only by an explicit
//! command (0020 §5), the same bless convention every other native golden in this repo uses:
//!
//! ```sh
//! GOLDEN_BLESS=1 cargo nextest run -p fx-persist -E 'test(persist_fixture_log_and_checkpoints)'
//! ```
//!
//! (`pnpm golden:bytes -- -p fx-persist -E 'test(persist_fixture_log_and_checkpoints)'` also works
//! -- see `packages/engine/CLAUDE.md`'s own note on passing `-E`/`-p` straight to `cargo nextest`.)

mod support;
use support::record;

#[test]
fn persist_fixture_log_and_checkpoints() {
    let recorded = record();
    engine::assert_golden_bytes!("persist_fixture_log", &recorded.log);
    for (i, (tick, hash)) in recorded.checkpoints.iter().enumerate() {
        // The tick itself is part of what a golden pins: if the script above changes shape (more
        // or fewer idle ticks before a checkpoint), the checkpoint's own tick moving is exactly
        // the kind of change this golden exists to catch, same as the hash moving.
        engine::assert_golden_hash!(
            &format!("persist_fixture_checkpoint_{i}_tick"),
            tick.0 as u64
        );
        engine::assert_golden_hash!(&format!("persist_fixture_checkpoint_{i}_hash"), *hash);
    }
}
