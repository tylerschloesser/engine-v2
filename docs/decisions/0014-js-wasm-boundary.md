# 0014: The JS↔WASM boundary: a fixed, hand-rolled `extern "C"` ABI

Status: Accepted (2026-09-19)

## Context

The game crate and the engine crate link into one `.wasm` that the *game's* build produces, while the engine's npm package ships prebuilt JavaScript (Requirements and "Consequence of games are written in Rust" in [`../spec/runtime-and-packaging.md`](../spec/runtime-and-packaging.md)). The same file is instantiated in several roles in the browser and once on the server ([0002](0002-determinism-same-wasm-everywhere.md), [0015](0015-threads-memory-and-topology.md)). Forces: the JS around every instance must meet the 8 B/frame budget of [0016](0016-zero-gc-definition.md); the sim must have no ambient inputs ([0002](0002-determinism-same-wasm-everywhere.md)); the Rust toolchain in a game's build should be `cargo` and nothing else ([0017](0017-packaging-and-build.md)); instance memory is not shared, so all data crosses by copy ([0015](0015-threads-memory-and-topology.md)).

## Decision

**1. No wasm-bindgen, no wasm-pack. The boundary is a fixed C ABI that the engine owns on both sides.** The decisive reason is packaging: wasm-bindgen's JS glue is *generated per build from the final `.wasm`* by a CLI whose version must exactly match the crate. Because the game builds the `.wasm`, that glue would be a game build artifact the engine's prebuilt worker and server code must somehow import. With a fixed ABI the engine package ships one fixed loader (TypeScript, runtime-agnostic: it takes a `WebAssembly.Module` and works in a worker, Node, Bun and workerd) and the game's build is `cargo build --target wasm32-unknown-unknown`. The second reason is garbage: bindgen's glue allocates for strings, slices, returned vectors, exported structs, closures and `i64`.

**2. Numbers only.** Every export and import takes and returns `i32`/`u32`, `f32` or `f64`, with at most one return value. No `i64`/`u64` (they cross as `BigInt`, which allocates): 64-bit values such as the state hash are written to memory as two `u32` halves. No multi-value returns (JS receives an array). No `externref`, no strings, no by-value structs (so the 2025 wasm32 C-ABI change does not apply). JS never sees a game-specific symbol: game hooks are ordinary trait calls inside the module.

**3. Imports: exactly two, both output-only.**

```rust
#[link(wasm_import_module = "engine")]
unsafe extern "C" {
    fn panic(ptr: *const u8, len: usize);           // UTF-8 message; returns, then the instance traps (5)
    fn log(level: u32, ptr: *const u8, len: usize); // diagnostics; decoding allocates a JS string
}
```

Time, randomness, input, storage and network bytes are *arguments or memory regions*, never imports: that is what makes the determinism rule airtight ([0002](0002-determinism-same-wasm-everywhere.md)), and persistence works by the host reading log and snapshot bytes out of a region and calling the injected `Storage` itself ([0005](0005-persistence-and-recovery.md)). `log` is compiled out below `warn` in release builds; any call inside the measured window fails [0016](0016-zero-gc-definition.md) by itself. Memory is exported (`memory`), not imported.

**The allowlist test** (Vitest under Node, in the "WASM under Node and Bun" suite of [0020](0020-testing-strategy.md); run against the reference game and every fixture game): `WebAssembly.Module.imports(module)` must be a subset of `{engine.panic, engine.log}`, all of kind `function`; `WebAssembly.Module.exports(module)` must contain `memory` and every ABI export below. On failure it prints the offending `module.name` pairs with the usual culprit (`__wbindgen_placeholder__`/`wbg` = a crate pulled in wasm-bindgen, e.g. `getrandom`'s JS backend, `instant`, `web-time`, `chrono`'s `wasmbind`; `env` = an unresolved C symbol; `wasi_snapshot_preview1` = wrong target). At runtime the loader supplies only `engine.*`, so such a module also fails to instantiate with a `LinkError`; the test exists to say why. Adding an import is an amendment to this ADR.

**4. Buffers: engine-owned regions in linear memory, addressed by pointer + length, read through long-lived views.**

```rust
// every role
engine_abi_version() -> u32                   // loader compares with its own constant; mismatch is a load error naming both versions
engine_boot() -> ptr                          // fixed 64 KiB static region: config in, panic/log text out
engine_init(role: u32, cfg_len: u32) -> u32   // parses the config in the boot region, reserves the arena (0015), lays out regions; 0 = ok
engine_region(id: u32) -> ptr                 // address of fixed region `id` for this role
engine_region_len(id: u32) -> u32             // its capacity in bytes
engine_mem_grows() -> u32                     // growth counter (0015)
```

| Role (`engine_init`) | Hot exports (shape fixed here; final list in Phase 2) |
|---|---|
| `0` sim | `sim_admit(conn, len) -> status`, `sim_tick() -> status`, `sim_build_frame(conn) -> len`, `sim_snapshot() -> len`, `sim_hash()` |
| `1` client | `on_frame(ptr, len)` ([0011](0011-wire-format-and-deltas.md)), `on_action(len) -> seq` and `on_input(len)` (JSON and input records, [0003](0003-game-facing-api.md), [0019](0019-camera-input-and-overlay.md)), `frame(t_ms: f64) -> status` |
| `2` gen | `gen_chunk(cx: i32, cy: i32)` writing 4,096 B to its output region ([0008](0008-chunk-generation.md)) |

- Regions (receive, transmit, DrawList staging, chunk-texel staging, UI JSON, log/snapshot output, camera-block copy) are laid out once by `engine_init` and **never move or resize** for the life of the instance. After init the loader reads each `(ptr, len)` once and builds its typed-array views once.
- **Copy in:** JS copies bytes from a SAB ring slot into the receive region with `wasmU8.set(slotView, ptr)` and calls one export with the length. **Copy out:** the export returns a byte length (or a status); JS copies from the region to its destination. Both directions move **whole fixed-size blocks through view pairs created at init**; `subarray()` and `new Uint8Array(...)` are never called in steady state (each allocates a view). Ring and block formats: [0015](0015-threads-memory-and-topology.md).
- **`memory.grow` detaches every view** of a non-shared memory. Growth can happen only inside an export call (the instance is single-threaded), so the loader funnels every call through one wrapper that afterwards checks `u8.byteLength === 0` (allocation-free) and, if so, rebuilds all views from `memory.buffer` at the same pointers (addresses are stable under growth; only the JS views die). Growth is therefore safe but never expected in steady state ([0015](0015-threads-memory-and-topology.md), asserted by [0016](0016-zero-gc-definition.md)).
- Config crosses once, as UTF-8 JSON in the boot region (it carries `Worldgen::Params`, typed for the game's TypeScript by `ts-rs`; parsed by the `serde_json` that [0003](0003-game-facing-api.md) justifies). Nothing else on a non-UI path is text.
- On the server the same regions are used without rings: socket bytes are copied straight in, and `Connection.send` ([0009](0009-transport-and-hosting.md)) receives a view over the transmit region. The server is outside [0016](0016-zero-gc-definition.md), so a per-send `subarray` is acceptable there.

**5. `export_game!`.** `engine::export_game!(MyGame)` (a `macro_rules!` macro, trait in [0003](0003-game-facing-api.md)) is the only line of ABI a game writes. It monomorphises the engine over the game type, emits every `#[unsafe(no_mangle)] extern "C"` export above for all three roles, installs the engine's `#[global_allocator]` over the arena ([0015](0015-threads-memory-and-topology.md)), and installs the panic hook. One instance has one role for life; calling another role's export returns an error status (traps in debug).

**6. Panics.** Builds use `panic = "abort"` ([0005](0005-persistence-and-recovery.md)). The hook formats the message and location into the static boot region without allocating (the allocator may be what failed), calls `engine.panic(ptr, len)`, which decodes and stores the text and returns; Rust then aborts, which is an `unreachable` trap. The loader's call wrapper catches the `WebAssembly.RuntimeError`, marks the instance dead (no export is ever called on it again), attaches the stored message, and reports to the role's owner: sim → the recovery path of [0005](0005-persistence-and-recovery.md); client → fresh instance plus the full resync used for reconnect ([0013](0013-sessions-and-integrity.md)); gen → fresh instance, outstanding requests re-queued. The compiled `Module` is kept, so a new instance costs an instantiate and an `engine_init`. A trap with no preceding `engine.panic` (stack overflow, out-of-bounds) is reported with the `RuntimeError`'s own message.

## Alternatives rejected

- **wasm-bindgen** (0.2.128, healthy, monthly releases). Generated-per-build glue and an exact CLI/crate version lock are incompatible with a prebuilt engine loader; the glue allocates on every non-numeric crossing. Restricting it to numeric exports removes the garbage but keeps the glue and the lock, i.e. all of the cost for none of the benefit.
- **wasm-pack** (0.15.0): only a wrapper around wasm-bindgen plus a bundled, slow `wasm-opt`.
- **Component model / wit-bindgen + jco** (wit-bindgen 0.62, jco 2.11): no browser implements components natively; in a browser `jco transpile` produces core WASM plus generated JS glue that lifts and lowers values into JS objects. That is a second build tool, generated glue again, and allocation on every call, for an interface with one consumer.
- **JSON (or any text) over the boundary on hot paths:** a JS string and a parse per frame, tick or message. JSON is confined to one-time config and the human-rate UI paths exempted in [0016](0016-zero-gc-definition.md).
- **Decoding wire bytes in JS and calling fine-grained setters:** per-entity JS work and boundary calls; rejected in [0011](0011-wire-format-and-deltas.md).
- **Importing `now`/`random`/storage functions:** ambient inputs to the sim, and each import is a hole in the allowlist.
- **`Memory.prototype.toResizableBuffer()`** (views that survive growth): Chrome 144+, Firefox 145+, Safari 26.2+ only; the detach check costs one comparison per call.

## Consequences

- Crates that assume wasm-bindgen on `wasm32-unknown-unknown` cannot be used by the engine or by games; the allowlist test makes that a build-time failure instead of a runtime mystery. The crate policy itself is [0017](0017-packaging-and-build.md).
- The engine owns an unsafe FFI layer and a loader that must change together; `engine_abi_version` and bundling the crate inside the npm package ([0017](0017-packaging-and-build.md)) keep them in lockstep.
- Whole-block copies move up to one block of slack per transfer; block sizes are chosen per region ([0015](0015-threads-memory-and-topology.md)).
- The zero-allocation copy was measured in one direction only (SAB slot → WASM memory, [`../../spikes/cross-origin-sab/RESULT.md`](../../spikes/cross-origin-sab/RESULT.md)); WASM → SAB through paired views is first exercised by the Phase 3 zero-GC test.
- Deferred to Phase 2: the final export list per role, region ids and sizes, and status codes, because they follow from the module breakdown in `PLAN.md` and change no other ADR.
- Deferred to Phase 2: whether `engine.log` text is decoded in the instance's own isolate or forwarded to the main thread, because it is a dev-ergonomics choice with no steady-state effect.

## Sources

- [`../research/runtime-and-packaging.md`](../research/runtime-and-packaging.md) 1.2, 1.6, 2 (miniquad as existence proof of a fixed hand-written loader), 3.1, 3.8.
- Spikes: [`../../spikes/cross-origin-sab/RESULT.md`](../../spikes/cross-origin-sab/RESULT.md) (preallocated per-slot views, `wasmU8.set(slotView, off)` into a non-shared `WebAssembly.Memory`, 0 GCs over 37 k messages); [`../../spikes/zero-gc-webgpu/RESULT.md`](../../spikes/zero-gc-webgpu/RESULT.md) (a numbers-only WASM worker at 0.99 B/frame, all of it harness). Raw matrix of the unfinished `spikes/vite-lib-worker-wasm` (`game/test/matrix-result.json`): a cargo-only cdylib importing exactly `engine.panic, engine.log` instantiates in Chromium, Firefox and WebKit; its conclusions belong to [0017](0017-packaging-and-build.md).
- wasm-bindgen: https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html · https://wasm-bindgen.github.io/wasm-bindgen/contributing/design/js-objects-in-rust.html · rustwasm sunset: https://blog.rust-lang.org/inside-rust/2025/07/21/sunsetting-the-rustwasm-github-org · wasm-pack releases: https://github.com/wasm-bindgen/wasm-pack/releases
- Component model in browsers: https://bytecodealliance.github.io/jco/transpiling.html · https://component-model.bytecodealliance.org/
- C ABI on wasm32: https://blog.rust-lang.org/2025/04/04/c-abi-changes-for-wasm32-unknown-unknown/ · target defaults: https://doc.rust-lang.org/nightly/rustc/platform-support/wasm32-unknown-unknown.html
- `memory.grow` detaching views: https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow · `toResizableBuffer`: https://caniuse.com/mdn-webassembly_api_memory_toresizablebuffer
- miniquad's loader: https://github.com/not-fl3/miniquad (all URLs checked 2026-09-19 via the research file)
