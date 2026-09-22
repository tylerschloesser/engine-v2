//! Native test helpers (feature `testing`, dev-dependency use only).

use std::path::Path;

pub mod budgets;
pub mod cache_matrix;
pub mod golden_bytes;
pub mod testkit;
pub mod worldgen_contract;

// So `engine::testing::assert_golden_bytes!`/`assert_golden_hash!` work at the path their doc
// comments advertise; the macros themselves are `#[macro_export]`ed at the crate root because
// `env!("CARGO_MANIFEST_DIR")` inside them must expand in the *caller's* crate.
pub use crate::{assert_golden_bytes, assert_golden_hash};
pub use cache_matrix::{
    CacheConfig, CountingHandle, CountingSource, DEFAULT_CACHE_CHUNKS, Prewarm, TestTerrain,
    assert_cache_invisible, prewarm_chunks,
};
pub use testkit::{Loopback, run_script};
pub use worldgen_contract::assert_worldgen_contract;

#[derive(serde::Deserialize)]
struct Golden {
    checkpoints: Vec<String>,
}

/// Compare state hashes with `<fixture_dir>/golden/golden.json`, reporting the first checkpoint
/// that differs. The golden is written only by `pnpm golden <fixture>`, from the `.wasm` run under
/// Node, which docs/decisions/0002 makes authoritative: a mismatch here means the native build
/// diverged from the `.wasm`, so fix the code, not the golden.
pub fn assert_golden(fixture_dir: impl AsRef<Path>, checkpoints: &[u64]) {
    assert_golden_named(fixture_dir, "golden.json", checkpoints);
}

/// `assert_golden`, against `<fixture_dir>/golden/<file_name>` instead of the canonical `golden.
/// json` (docs/plan/16-action-round-trip.md step 5): a fixture with more than one scenario/golden
/// pair (`scripts/golden.mjs`'s own `scenario<suffix>.json` -> `golden<suffix>.json` convention,
/// e.g. `fixtures/puts/golden/golden-script-a.json`) names its own file explicitly.
pub fn assert_golden_named(fixture_dir: impl AsRef<Path>, file_name: &str, checkpoints: &[u64]) {
    let path = fixture_dir.as_ref().join("golden").join(file_name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (write it with `pnpm golden`)", path.display()));
    let golden: Golden =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let actual: Vec<String> = checkpoints.iter().map(|h| format!("{h:016x}")).collect();
    for (i, (want, got)) in golden.checkpoints.iter().zip(&actual).enumerate() {
        assert_eq!(got, want, "checkpoint {i} differs from {}", path.display());
    }
    assert_eq!(
        actual.len(),
        golden.checkpoints.len(),
        "checkpoint count differs from {}",
        path.display()
    );
}
