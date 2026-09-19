# 0002: Determinism by running the same `.wasm` everywhere

Status: Accepted (2026-09-19)

## Context

[`../spec/simulation.md`](../spec/simulation.md) requires that a world be reconstructed exactly from code, seed, parameters and the timed action log. The same sim code runs on a server, in a single-player worker, and (action handlers only) in every client for prediction ([0012](0012-prediction-and-reconciliation.md)); clients also regenerate pristine terrain locally ([0008](0008-chunk-generation.md)). All of those must agree bit for bit. WebAssembly specifies every float result except NaN bits, and leaves nondeterminism only in NaN bits, relaxed SIMD, threads, imports and resource exhaustion. `spikes/determinism-hash` measured what actually holds.

## Decision

**1. One artifact.** The game-built `.wasm` that the browser loads is the file the server runs, under a JS runtime (runtimes and hosts: [0009](0009-transport-and-hosting.md), [0017](0017-packaging-and-build.md)). There is no native server binary. Native builds exist for `cargo test` speed and tooling; the authoritative determinism tests run the `.wasm`. The sim's identity is the content hash of that file ([0005](0005-persistence-and-recovery.md)).

**2. Rules for every crate that compiles into sim, worldgen or `apply` code, with what the spike measured** (20 runs: 6 native builds on aarch64 and x86-64 Linux; 14 WASM runs on Node/V8, Bun/JSC, Chromium, Chrome, Firefox, WebKit and Node x64 under emulation, each at `opt-level=3` and `"s"`; 2,048 chunks out to ±8,000,000 tiles; 256 entities x 100,000 ticks; raw float bits hashed):

| Rule | Measurement |
|---|---|
| Allowed float ops: `+ - * /`, `sqrt`, `floor/ceil/trunc/round`, `abs`, comparisons, `min/max` on non-NaN, int/float and f32/f64 `as` casts. Constants are decimal literals | Identical hashes in all 20 runs, f32 and f64, including `target-cpu=native` (LLVM never fused `a*b+c`) and debug vs release |
| No std transcendentals (`sin cos tan exp ln powf atan2 hypot` ...). Use hand-written polynomials, or the `libm` crate pinned with `=` and called explicitly (`libm::sinf`) | std: native differs from WASM for every function listed (all WASM runs agree with each other; `cbrt` matched only by shared ancestry). Pinned `libm =0.2.15` and the polynomial sin/cos: identical in all 20 |
| `mul_add` is allowed but avoided in hot paths | Identical in all 20; it differs bitwise from `a*b+c` in 13% of random triples, so fusion would have been visible; it is a software call in WASM |
| NaN bits are never observable: no NaN in state; guard every division, `sqrt` and normalize; never `to_bits`, `total_cmp`, `copysign`, `is_sign_*` or transmute on a possibly-NaN value | Operation-produced NaN is `0x7fc00000` on aarch64 and `0xffc00000` on x86-64 **for the identical `.wasm`**; `-(0/0)` also differs between debug and release on one CPU. This is the one hazard that survives rule 1 (x86 server, ARM phone) |
| Persistent quantities are integers or fixed-point (positions Q24.8, [0007](0007-world-model.md)); floats are fine for dynamics. No `usize`/`isize` in hashed or serialized state; wrapping integer ops written explicitly | 16.16 fixed-point sim and SplitMix64 hashes identical in all 20 |
| No `HashMap`/`HashSet` in sim state. Use `BTreeMap`, sorted `Vec`, or engine arenas whose free list is serialized | On `wasm32-unknown-unknown` std seeds `RandomState` from stack and heap addresses, so iteration order changes after a snapshot restore |
| Randomness: engine-owned `SimRng` (hand-rolled PCG32, integer-only range sampling, `fork(stream)`), state stored in the snapshot, reachable only through the host's write context; a predicted `apply` that asks for it declines to predict ([0003](0003-game-facing-api.md)). Worldgen uses stateless coordinate hashes only ([0008](0008-chunk-generation.md)) | Same integer code everywhere; matched in all 20 |
| No wall clock, no I/O, no ambient input: time is the tick counter | Enforced by the import allowlist below |
| Default `wasm32-unknown-unknown` target features only: no `relaxed-simd`, no `atomics`, no `simd128`; stable Rust, `panic=abort` | `opt-level` 3 vs `s`, LTO and debug/release changed no non-NaN result. `simd128` was not tested |

Speed is not a reason to go native: worldgen and the spring sim ran at about 1.1-1.3x native release time in every engine.

**3. Enforcement, mechanical wherever possible** (test placement and CI matrix: [0020](0020-testing-strategy.md)):

- **Import allowlist test.** Parse the built module's import section; every import must be in the `engine.*` allowlist ([0014](0014-js-wasm-boundary.md)). This is what rules out `Date.now`, `Math.random`, `getrandom` and clock crates, and it is airtight. A second assertion checks the module uses no features beyond the default target set.
- **Lint bans** in the engine's shared clippy config, applied to engine sim crates and to game crates: `disallowed_methods` for the std float transcendentals and the NaN-observing methods; `disallowed_types` for `HashMap`, `HashSet`, `std::time::{Instant, SystemTime}`. An `#[allow]` needs a comment saying why the value cannot influence state.
- **NaN canonicalization.** The engine `Codec` for `f32`/`f64` writes `0x7fc00000` (or the f64 equivalent) for any NaN and `debug_assert!`s finiteness; snapshots and the state hash are built only from `Codec` bytes. It is a backstop, not permission to store NaN.
- **Heavy mode.** A test mode that, every N ticks (N=1 in the slow suite), saves, loads into a fresh instance, continues, and compares the state hash with an uninterrupted run. This is what finds hidden state (caches, free lists, RNG, table layout).
- **Replay equality.** Run a script to hash H; replay its log from genesis; expect H.
- **Cross-engine golden hashes.** One fixed seed and script, golden hashes checked in, run as `.wasm` in Node, Bun and Playwright Chromium/Firefox/WebKit, and natively (suite placement: [0020](0020-testing-strategy.md)). Raw float bits are hashed so drift cannot hide behind thresholds.
- The state hash is 64-bit FNV-1a over canonical snapshot bytes (as in the spike). It detects bugs, not adversaries.

## Alternatives rejected

- **Native server binary of the same crates.** The spike shows the safe subset also matches natively, but a native server adds a second build target per game, a Rust WebSocket and storage stack per host, permanent libm/`usize`/`HashMap` discipline with no mechanical check, and a wasm-vs-native equivalence job that can only sample. It buys about 1.2x speed that 2-8 players do not need, and it breaks "single-player saves and server saves are interchangeable".
- **Fixed-point everywhere.** Unnecessary: plain IEEE arithmetic was bit-identical in every environment tested, and f64 noise cost the same as f32. Fixed-point is kept where exact equality and compact encoding matter (positions, timers, counts).
- **Trusting std float functions because everyone runs the same `.wasm`.** True only until someone runs `cargo test` natively or a toolchain bump changes the bundled libm; the measured native-vs-WASM divergence would make native tests disagree with production. Banned outright.
- **The `rand` crate.** Portable generators exist, but value-breaking changes are allowed in minor releases and `usize` sampling is not portable; PCG32 is about 40 lines to own.
- **A deterministic-profile runtime (Wasmtime NaN canonicalization).** Browsers offer no such switch, so the sim must be NaN-robust on its own anyway.

## Consequences

- Server hosting is limited to JS runtimes that can instantiate WebAssembly ([0009](0009-transport-and-hosting.md)).
- Any toolchain, dependency or flag change produces a new `.wasm` hash and therefore a new log segment ([0005](0005-persistence-and-recovery.md)); `Cargo.lock` is committed and `libm` is pinned exactly.
- Game authors must follow the float and collection rules; the lints and heavy mode tell them when they do not. The rules also bind the client-side prediction path, since it runs `apply`.
- Deferred to Phase 2: a run on real x86-64 hardware and on a physical iPhone and Android phone, because the spike had only Rosetta emulation and desktop browser builds; the first CI milestone closes it with the golden-hash test.
- Deferred to Phase 2: whether `+simd128` and `wasm-opt` may be enabled, because neither was measured; until then both stay off for the sim module.

## Sources

- Spike: [`../../spikes/determinism-hash/RESULT.md`](../../spikes/determinism-hash/RESULT.md)
- [`../research/simulation.md`](../research/simulation.md) 1.1, 1.2, 3.2
- Wasm numerics and nondeterminism: https://webassembly.github.io/spec/core/exec/numerics.html , https://github.com/WebAssembly/design/blob/main/Nondeterminism.md
- Rust float semantics (RFC 3514): https://rust-lang.github.io/rfcs/3514-float-semantics.html ; target features: https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html
- `HashMap` seeding on unsupported targets: https://raw.githubusercontent.com/rust-lang/rust/master/library/std/src/sys/random/unsupported.rs
- `rand` reproducibility policy: https://rust-random.github.io/book/crate-reprod.html ; `libm` crate (0.2.16 current, checked 2026-09-19): https://crates.io/crates/libm
- Factorio heavy mode: https://www.factorio.com/blog/post/fff-63 ; Rapier cross-platform determinism: https://rapier.rs/docs/user_guides/rust/determinism/
