//! Native heavy mode against `fx-persist` (docs/plan/22-persistence-log-and-snapshots.md Tests
//! added): `heavy_mode_fixture_n25` (fast tier) and `heavy_mode_fixture_n1` (slow tier). Both
//! replay the same checked-in log (`tests/fixture_log.rs`'s own `RECORDED_LOG`); this file just
//! points `engine::testing::heavy` at it.

use engine::testing::heavy;
use fx_persist::Persist;

mod support;
use support::{fixture_params, record};

#[test]
fn heavy_mode_fixture_n25() {
    let recorded = record();
    let result = heavy::<Persist>(fixture_params(), &recorded.log, 25);
    assert!(
        result.is_ok(),
        "heavy mode (N=25) must agree with an uninterrupted run: {result:?}"
    );
}

#[test]
fn slow_heavy_mode_fixture_n1() {
    let recorded = record();
    let result = heavy::<Persist>(fixture_params(), &recorded.log, 1);
    assert!(
        result.is_ok(),
        "heavy mode (N=1) must agree with an uninterrupted run: {result:?}"
    );
}
