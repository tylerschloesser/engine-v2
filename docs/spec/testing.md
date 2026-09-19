# Testing

## Requirements

- Everything is optimized for automated testing. Claude should have an automated test suite covering as much as possible.
- Avoid mocking unless it's necessary. Unit test pure functions.
- Research the latest LLM-optimized automated browser testing.
- Low-level browser behavior must be testable, e.g. deterministically run the game and assert that no garbage collection occurred.
- Tests must be fast; parallelization is fine. Budget: **under 1 minute for all tests**. If that's exceeded, Tyler will want to split into a fast suite and a slower, more comprehensive one.

- The 1-minute budget assumes warm build caches. Separately, an incremental rebuild after a one-line Rust edit should take 30 seconds or less.
- CI is GitHub Actions on Linux with a software WebGPU adapter. Real-GPU and timing-sensitive runs happen only on Tyler's Mac. iOS Safari is covered by a manual checklist on a real phone; no device cloud.
- "Zero GC" means: in steady state, zero major GCs and approximately zero allocation on every engine-owned isolate, except a small fixed floor (about 100 B/frame) on the rendering thread for WebGPU's unavoidable wrapper objects, and the rare sub-millisecond scavenge that implies.

## Implications for the engine's design

Testability is a design constraint, not an afterthought:

- The engine never reads wall-clock time or schedules frames in a way a test can't drive. Clock, frame stepping, tick stepping, and input are all injectable, so a test can run "N frames with these inputs" deterministically.
- Everything random is seeded.
- The sim runs headless outside a browser (native `cargo test`, and the WASM module under a JS runtime), so most game and engine logic is tested without one.
- Determinism makes a cheap, powerful test available: replay a recorded action log and compare a state hash across native, WASM, and each browser.

## Open questions

- **Tooling.** Decided in [0020](../decisions/0020-testing-strategy.md).
- **Headless WebGPU.** Decided in [0020](../decisions/0020-testing-strategy.md). Deferred to Phase 3: verifying the SwiftShader flag set on a GitHub runner (spike B), because the local loop is proven and the fallback is known. See [0020](../decisions/0020-testing-strategy.md).
- **Detecting GC.** Decided in [0016](../decisions/0016-zero-gc-definition.md).
- **Verifying rendering.** Decided in [0020](../decisions/0020-testing-strategy.md).
- **Netcode tests without mocks.** Decided in [0020](../decisions/0020-testing-strategy.md).
- **The budget.** Suites, parallelization and the demotion rule decided in [0020](../decisions/0020-testing-strategy.md).
- **Which isolates "no GC" covers.** Decided in [0016](../decisions/0016-zero-gc-definition.md).
- **Cross-browser determinism.** Decided in [0020](../decisions/0020-testing-strategy.md) and [0002](../decisions/0002-determinism-same-wasm-everywhere.md).
- **Performance regression checks.** Decided in [0020](../decisions/0020-testing-strategy.md).
