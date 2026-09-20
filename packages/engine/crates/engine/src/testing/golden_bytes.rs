//! Native byte-format goldens (Planning decisions 6 of docs/plan/05-codec-and-state-hash.md):
//! lower-case hex, 32 bytes per line, checked in beside the test that produced them. Distinct from
//! M02's checkpoint-hash `golden.json`, which is written only by `pnpm golden` from the `.wasm`
//! under Node; these are written only by `pnpm golden:bytes`, natively, under `GOLDEN_BLESS=1`.
//!
//! [`assert_golden_bytes!`](crate::assert_golden_bytes) and
//! [`assert_golden_hash!`](crate::assert_golden_hash) expand `env!("CARGO_MANIFEST_DIR")` at the
//! call site (a macro, not a function, so it resolves in the *caller's* crate) and forward here.

use std::path::{Path, PathBuf};

fn golden_path(manifest_dir: &str, name: &str, ext: &str) -> PathBuf {
    Path::new(manifest_dir)
        .join("tests/golden")
        .join(format!("{name}.{ext}"))
}

fn bless_from_env() -> bool {
    std::env::var_os("GOLDEN_BLESS").as_deref() == Some(std::ffi::OsStr::new("1"))
}

fn format_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2 + bytes.len() / 32 + 1);
    for chunk in bytes.chunks(32) {
        for b in chunk {
            out.push_str(&format!("{b:02x}"));
        }
        out.push('\n');
    }
    out
}

fn parse_hex(text: &str) -> Vec<u8> {
    let digits: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    digits
        .chunks(2)
        .map(|pair| {
            let s = std::str::from_utf8(pair).expect("golden hex file is not ASCII");
            u8::from_str_radix(s, 16).expect("golden hex file has a non-hex byte pair")
        })
        .collect()
}

/// First differing byte offset, or `None` when equal.
fn first_diff(expected: &[u8], actual: &[u8]) -> Option<usize> {
    if expected == actual {
        return None;
    }
    Some(
        expected
            .iter()
            .zip(actual.iter())
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| expected.len().min(actual.len())),
    )
}

fn hex_window(bytes: &[u8], offset: usize) -> String {
    let start = offset.saturating_sub(16);
    let end = (offset + 16).min(bytes.len());
    bytes
        .get(start..end)
        .map(format_hex)
        .unwrap_or_default()
        .replace('\n', "")
}

pub fn check_bytes(manifest_dir: &str, name: &str, actual: &[u8]) {
    check_bytes_with(manifest_dir, name, actual, bless_from_env());
}

pub(crate) fn check_bytes_with(manifest_dir: &str, name: &str, actual: &[u8], bless: bool) {
    let path = golden_path(manifest_dir, name, "hex");
    if bless {
        std::fs::create_dir_all(path.parent().expect("golden path has a parent")).unwrap();
        std::fs::write(&path, format_hex(actual)).unwrap();
        return;
    }
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (write it with `pnpm golden:bytes`)",
            path.display()
        )
    });
    let expected = parse_hex(&text);
    if let Some(offset) = first_diff(&expected, actual) {
        panic!(
            "golden {name}: first differing offset {offset}: expected {} around it, got {} ({}, run `pnpm golden:bytes` to rebless)",
            hex_window(&expected, offset),
            hex_window(actual, offset),
            path.display(),
        );
    }
}

pub fn check_hash(manifest_dir: &str, name: &str, actual: u64) {
    check_hash_with(manifest_dir, name, actual, bless_from_env());
}

pub(crate) fn check_hash_with(manifest_dir: &str, name: &str, actual: u64, bless: bool) {
    let path = golden_path(manifest_dir, name, "hash");
    if bless {
        std::fs::create_dir_all(path.parent().expect("golden path has a parent")).unwrap();
        std::fs::write(&path, format!("{actual:016x}\n")).unwrap();
        return;
    }
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (write it with `pnpm golden:bytes`)",
            path.display()
        )
    });
    let expected =
        u64::from_str_radix(text.trim(), 16).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(
        actual,
        expected,
        "golden hash {name} differs from {} (run `pnpm golden:bytes` to rebless)",
        path.display()
    );
}

/// `engine::assert_golden_bytes!(name, bytes)`: compares `bytes` with
/// `<CARGO_MANIFEST_DIR>/tests/golden/<name>.hex`. Under `GOLDEN_BLESS=1` (`pnpm golden:bytes`) it
/// writes the file instead; a missing golden fails without that env set.
#[macro_export]
macro_rules! assert_golden_bytes {
    ($name:expr, $bytes:expr) => {
        $crate::testing::golden_bytes::check_bytes(env!("CARGO_MANIFEST_DIR"), $name, $bytes)
    };
}

/// `engine::assert_golden_hash!(name, hash)`: compares `hash` with
/// `<CARGO_MANIFEST_DIR>/tests/golden/<name>.hash`. Same bless rule as
/// [`assert_golden_bytes!`](crate::assert_golden_bytes).
#[macro_export]
macro_rules! assert_golden_hash {
    ($name:expr, $hash:expr) => {
        $crate::testing::golden_bytes::check_hash(env!("CARGO_MANIFEST_DIR"), $name, $hash)
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A fresh scratch directory per test, so parallel nextest workers never collide.
    fn scratch_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "engine-golden-bytes-test-{}-{label}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn golden_missing_fails_without_bless() {
        let dir = scratch_dir("missing");
        let dir_str = dir.to_str().unwrap();
        let result =
            std::panic::catch_unwind(|| check_bytes_with(dir_str, "nope", &[1, 2, 3], false));
        assert!(
            result.is_err(),
            "missing golden must fail, not silently pass"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn golden_reports_first_diff() {
        let dir = scratch_dir("diff");
        let dir_str = dir.to_str().unwrap();
        check_bytes_with(dir_str, "sample", &[1, 2, 3, 4, 5], true);
        let result = std::panic::catch_unwind(|| {
            check_bytes_with(dir_str, "sample", &[1, 2, 9, 4, 5], false)
        });
        let err = result.unwrap_err();
        let msg = err
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap();
        assert!(msg.contains("offset 2"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn golden_bytes_bless_round_trips() {
        let dir = scratch_dir("roundtrip");
        let dir_str = dir.to_str().unwrap();
        check_bytes_with(dir_str, "rt", &[9, 8, 7, 255, 0], true);
        check_bytes_with(dir_str, "rt", &[9, 8, 7, 255, 0], false); // must not panic
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn golden_hash_bless_round_trips_and_mismatches() {
        let dir = scratch_dir("hash");
        let dir_str = dir.to_str().unwrap();
        check_hash_with(dir_str, "h", 0x0102_0304_0506_0708, true);
        check_hash_with(dir_str, "h", 0x0102_0304_0506_0708, false); // must not panic
        let result = std::panic::catch_unwind(|| check_hash_with(dir_str, "h", 0xdead_beef, false));
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
