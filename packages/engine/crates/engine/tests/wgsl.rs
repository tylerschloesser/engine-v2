//! Validates every `.wgsl` file the TypeScript renderer embeds (docs/plan/09-renderer-terrain.md
//! Planning decisions "Bind group layout": "`naga` validates every `.wgsl` in the Rust native suite
//! (dev-dependency; 0017 §7 leaves those unrestricted)"). The engine crate owns no rendering code;
//! this only proves the WGSL `scripts/embed-wgsl.mjs` embeds verbatim is syntactically and
//! type-correct, on every commit, without a GPU.

use std::fs;
use std::path::PathBuf;

use naga::valid::{Capabilities, ValidationFlags, Validator};

fn wgsl_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/render/wgsl")
}

#[test]
fn wgsl_terrain_validates() {
    let dir = wgsl_dir();
    let entries = fs::read_dir(&dir).unwrap_or_else(|e| panic!("reading {dir:?}: {e}"));
    let mut checked = 0usize;
    for entry in entries {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("wgsl") {
            continue;
        }
        let source =
            fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
        let module = naga::front::wgsl::parse_str(&source)
            .unwrap_or_else(|e| panic!("{}: {}", path.display(), e.emit_to_string(&source)));
        let mut validator = Validator::new(ValidationFlags::all(), Capabilities::empty());
        validator
            .validate(&module)
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        checked += 1;
    }
    assert!(checked > 0, "no .wgsl files found under {}", dir.display());
}
