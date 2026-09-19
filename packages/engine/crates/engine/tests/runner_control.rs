//! Permanent negative control for the nextest adapter: `pnpm test --self-check-fail` sets
//! `RUNNER_SELF_CHECK=fail` in every child, and the runner must then report this test as a failure.

#[test]
fn runner_negative_control() {
    let fail = std::env::var("RUNNER_SELF_CHECK").is_ok_and(|v| v == "fail");
    assert!(!fail, "runner self-check: deliberate failure");
}
