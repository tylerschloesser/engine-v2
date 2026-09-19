# Testing

## Requirements

- Everything is optimized for automated testing. Claude should have an automated test suite covering as much as possible.
- Avoid mocking unless it's necessary. Unit test pure functions.
- Research the latest LLM-optimized automated browser testing.
- Low-level browser behavior must be testable, e.g. deterministically run the game and assert that no garbage collection occurred.
- Tests must be fast; parallelization is fine. Budget: **under 1 minute for all tests**. If that's exceeded, Tyler will want to split into a fast suite and a slower, more comprehensive one.

## Implications for the engine's design

Testability is a design constraint, not an afterthought:

- The engine never reads wall-clock time or schedules frames in a way a test can't drive. Clock, frame stepping, tick stepping, and input are all injectable, so a test can run "N frames with these inputs" deterministically.
- Everything random is seeded.
- The sim runs headless outside a browser (native `cargo test`, and the WASM module under a JS runtime), so most game and engine logic is tested without one.
- Determinism makes a cheap, powerful test available: replay a recorded action log and compare a state hash across native, WASM, and each browser.

## Open questions

- **Tooling.** Current best options for LLM-driven and scripted browser testing (Playwright and its CLI/MCP tooling, raw CDP, Vitest browser mode), plus Rust-side runners (`cargo test`, wasm-bindgen-test or equivalent). What gives Claude the tightest edit→verify loop?
- **Headless WebGPU.** Getting a real WebGPU device in automated Chrome locally on macOS and in CI (flags, software adapters); whether other browsers are tested at all.
- **Detecting GC.** Candidate mechanisms: CDP tracing of V8 GC events, `--trace-gc` via JS flags, heap-size sampling. Which is reliable enough to assert "zero GCs during these N frames" without flaking? Prove it with a spike.
- **Verifying rendering.** GPU readback + hashing vs. screenshot comparison; tolerance across GPUs and software adapters.
- **Netcode tests without mocks.** Multiple real clients against a real server in one test process over the real transport, with a deterministic network conditioner (latency, jitter, loss) rather than a mocked socket.
- **The budget.** Does the 1 minute include the Rust/WASM build, or assume warm caches? How the suites are parallelized, and the rule for when a test moves to the slow suite.
- **Which isolates "no GC" covers.** Each worker has its own V8 isolate and heap. A GC in the sim worker doesn't drop a frame the way one on the rendering thread does. Define which threads the assertion covers, and whether minor (scavenge) GCs count.
- **Cross-browser determinism.** The implications above promise a state-hash comparison in "each browser", while the tooling question asks whether other browsers are tested at all. Safari/WebKit is the engine most likely to differ and the hardest to automate (does Playwright's WebKit build expose WebGPU, or run WASM like iOS Safari does?). Decide what is asserted where: the sim hash needs no GPU, so it can run in more engines than the renderer tests.
- Performance regression checks (frame time, tick time, bandwidth per client) and whether they belong in the fast suite.
