//! Release-profile re-runs and the bench gate for the wall-clock benchmarks (M36
//! and-benchmarks.md steps 4-5). The slow nextest profile builds the dev profile, so a benchmark
//! compiled without optimisation (`cfg!(debug_assertions)`) re-runs itself as `cargo test --release
//! --test <file> -- --exact <name>` ([`run_in_release`]; the inner run prints one `BENCH_SAMPLE
//! <json>` line) and the outer run hands the sample to `scripts/lib/bench-gate.mjs` ([`gate`]).
//!
//! M40: a copy of `games/reference/sim/tests/common/bench_run.rs` with `-p fx-belts` (M45 moves the
//! helper into `engine::testing`), plus [`run_in_release_samples`] for a spike printing many cells.
#![allow(dead_code)]

use std::process::{Command, Stdio};

pub fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..") // fixtures/belts: one level deeper than reference/sim
}

/// Runs `name` of test binary `test_file` again in the release profile and returns its `BENCH_SAMPLE` json.
pub fn run_in_release(test_file: &str, name: &str) -> String {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let out = Command::new(cargo)
        .current_dir(repo_root())
        .args([
            "test",
            "--release",
            "-p",
            "fx-belts",
            "--test",
            test_file,
            "--",
            "--exact",
            name,
            "--nocapture",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .output()
        .expect("spawning cargo test --release");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "release run of {name} failed:\n{text}"
    );
    for line in text.lines() {
        if !line.starts_with("BENCH_SAMPLE ") {
            println!("{line}");
        }
    }
    text.lines()
        .find_map(|l| l.strip_prefix("BENCH_SAMPLE "))
        .unwrap_or_else(|| panic!("no BENCH_SAMPLE line in:\n{text}"))
        .to_string()
}

/// [`run_in_release`] for a test printing several `BENCH_SAMPLE` lines: all of them, in order.
pub fn run_in_release_samples(test_file: &str, name: &str) -> Vec<String> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let out = Command::new(cargo)
        .current_dir(repo_root())
        .args([
            "test",
            "--release",
            "-p",
            "fx-belts",
            "--test",
            test_file,
            "--",
            "--exact",
            name,
            "--nocapture",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .output()
        .expect("spawning cargo test --release");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "release run of {name} failed:\n{text}"
    );
    let mut samples = Vec::new();
    for line in text.lines() {
        match line.strip_prefix("BENCH_SAMPLE ") {
            Some(s) => samples.push(s.to_string()),
            None => println!("{line}"),
        }
    }
    assert!(!samples.is_empty(), "no BENCH_SAMPLE line in:\n{text}");
    samples
}

/// `node scripts/lib/bench-gate.mjs check <name> rust`, the sample on stdin: records it and applies
/// the gate; its `warn:` lines pass through to the runner. Panics when the gate fails.
pub fn gate(name: &str, sample: &str) {
    use std::io::Write;
    let mut child = Command::new("node")
        .current_dir(repo_root())
        .args(["scripts/lib/bench-gate.mjs", "check", name, "rust"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawning node");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(sample.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    print!("{stdout}");
    assert!(out.status.success(), "bench gate '{name}' failed: {stderr}");
}
