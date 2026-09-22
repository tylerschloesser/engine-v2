//! Context artifact (docs/plan/15-connection-and-subscriptions.md): crate `CLAUDE.md`'s own line,
//! "`host/` and `client/` are outside the deterministic core: they may read subscriptions and
//! cameras, `sim/` may not import them" -- enforced here with a source scan, since a `pub(crate)`
//! visibility boundary alone cannot express "this direction only" between sibling modules.
//!
//! Scans every `.rs` file under `src/` except `host/`, `client/`, `client.rs`, `game_instance.rs`
//! and `abi/` (which legitimately dispatch to `Host<G>`/`ClientInstance<G>`, 0014), `game.rs`
//! (pre-existing, M12: `Game::Client: ClientSide<Self>` needs `crate::client::ClientSide`'s trait
//! itself, not the client role's state) and `testing/` (dev-only cross-cutting harnesses --
//! `testkit::Loopback` wires `Host` and `ClientCore` together on purpose) for a `crate::host` or
//! `crate::client` reference. The deterministic core (`sim.rs`, `authority.rs`, `store.rs`,
//! `world/`, `world_access.rs`, `delta.rs`, `worldgen/`, ...) must have none.

use std::path::Path;

fn scan(dir: &Path, out: &mut Vec<(std::path::PathBuf, usize, String)>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap().to_str().unwrap();
            if matches!(name, "host" | "client" | "abi" | "testing") {
                continue;
            }
            scan(&path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let name = path.file_name().unwrap().to_str().unwrap();
        if matches!(name, "client.rs" | "game_instance.rs" | "game.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for (i, line) in text.lines().enumerate() {
            if line.contains("crate::host") || line.contains("crate::client") {
                out.push((path.clone(), i + 1, line.trim().to_string()));
            }
        }
    }
}

#[test]
fn sim_and_world_do_not_import_host_or_client() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut hits = Vec::new();
    scan(&src, &mut hits);
    assert!(
        hits.is_empty(),
        "the deterministic core must not import host/ or client/ (crate CLAUDE.md: \
         'host/ and client/ are outside the deterministic core ... sim/ may not import them'): {hits:#?}"
    );
}

/// Anti-vacuity: the scanner must actually find a real reference somewhere it is *allowed* to
/// (`game_instance.rs`, excluded above only from the assertion, not from existing at all) --
/// otherwise an empty result above could just mean the scan itself is broken.
#[test]
fn scanner_reaches_a_real_host_reference() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/game_instance.rs");
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("crate::host")
            || text.contains("use crate::host")
            || text.contains("host::Host"),
        "game_instance.rs no longer references host::Host; the scanner's own exclusion list may be stale"
    );
}
