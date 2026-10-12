//! The release re-run and the bench gate (M36), since M45 in `engine::testing::bench` (module doc
//! there); this file fixes the package name for the reference game's benchmarks.
#![allow(dead_code)]

// Every test binary includes `common` whole; not each calls `gate`.
#[allow(unused_imports)]
pub use engine::testing::bench::gate;

/// [`engine::testing::bench::run_in_release`] for `reference-sim`.
pub fn run_in_release(test_file: &str, name: &str) -> String {
    engine::testing::bench::run_in_release("reference-sim", test_file, name)
}
