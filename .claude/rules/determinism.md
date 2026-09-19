---
paths:
  - "packages/engine/crates/**"
  - "packages/engine/fixtures/*/src/**"
---

# Determinism: sim, worldgen and `apply` code must agree bit for bit everywhere

The same `.wasm` runs on a server, in a worker and in every client, and native tests must match it. The rules and what was measured: `docs/decisions/0002-determinism-same-wasm-everywhere.md` §2. How they are enforced: §3.

In code under these paths:

- Float ops are `+ - * /`, `sqrt`, `floor/ceil/trunc/round`, `abs`, comparisons, `min/max` on non-NaN, and `as` casts. No std transcendentals (`sin`, `exp`, `powf`, …): a hand-written polynomial, or `libm` pinned with `=` and called explicitly.
- NaN bits are never observable: guard every division, `sqrt` and normalise; no `to_bits`, `total_cmp`, `copysign`, `is_sign_*` on a value that could be NaN.
- No `HashMap`/`HashSet`: `BTreeMap`, a sorted `Vec`, or an engine arena. No `usize`/`isize` in hashed or serialised state. Integer wrapping is written explicitly (`wrapping_add`).
- No wall clock, no I/O, no ambient input: time is the tick counter, randomness is engine-owned integer code whose state is in the snapshot. A new WASM import is an amendment to `docs/decisions/0014-js-wasm-boundary.md` §3.
- No target features beyond the toolchain default (`simd128`, `relaxed-simd`, `atomics` are named failures).

What catches a slip:

- `pnpm lint`: the clippy ban lists in `clippy.toml` (owner: 0002 §3) reach every crate with `[lints] workspace = true`. An `#[allow(clippy::disallowed_methods)]` needs a comment saying why the value cannot influence state (example: `bits()` in `packages/engine/fixtures/hash/src/lib.rs`).
- `pnpm test wasm -t "import allowlist"` and `-t "target features"`: every fixture's built module.
- `pnpm test rust -t scenario_matches_golden` and `pnpm test wasm -t determinism`: the golden hashes natively, under Node and under Bun. `pnpm golden <fixture>` is the only writer of a `golden.json`, from the `.wasm` under Node; a native mismatch means the code is wrong, not the golden.
