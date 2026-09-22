//! Reads `packages/engine/budgets.json` (docs/decisions/0020 §9: the one budgets file) from a
//! native test, mirroring `tests/support/budgets.ts`'s `budget`/`expectWithinBudget` on the TS
//! side: a dotted path into the JSON resolves to a number, or the lookup panics naming exactly
//! what is missing, never a silent pass. This crate had no Rust-side reader before M15
//! (docs/plan/15-connection-and-subscriptions.md Deviations): every existing budget consumer was
//! TypeScript, but this milestone's own exit criterion ("`budgets.json` holds ceilings for the
//! counters on `join_wilderness` and `join_modified`") is asserted by a native Rust test.

use std::sync::OnceLock;

fn budgets() -> &'static serde_json::Value {
    static CELL: OnceLock<serde_json::Value> = OnceLock::new();
    CELL.get_or_init(|| {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../budgets.json");
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("{path}: {e} (packages/engine/budgets.json)"));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
    })
}

/// A dotted path (e.g. `counters.subscription.joinWildernessBytesDown`) into `budgets.json`,
/// resolved to a `u64`. Panics, naming the path, if it does not resolve to a number.
pub fn budget(path: &str) -> u64 {
    let mut value = budgets();
    for part in path.split('.') {
        value = value
            .get(part)
            .unwrap_or_else(|| panic!("budgets: no value at '{path}' in budgets.json"));
    }
    value
        .as_u64()
        .unwrap_or_else(|| panic!("budgets: '{path}' in budgets.json is not a whole number"))
}

/// Panics with both numbers when `actual` exceeds the budget at `path` (0020 §9: raising a number
/// is a reviewed change, never something a test does for itself -- mirrors the TS
/// `expectWithinBudget`).
pub fn expect_within_budget(path: &str, actual: u64) {
    let limit = budget(path);
    assert!(
        actual <= limit,
        "{path}: {actual} exceeds budget {limit} (packages/engine/budgets.json)"
    );
}
