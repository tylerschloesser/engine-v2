# M05: Codec and state hash

Status: done · After: 04 · Tyler-dependent: no

## Goal
The engine crate has the one byte-level foundation everything persistent or networked stands on: `Codec` (postcard with NaN canonicalisation), a byte sink/reader pair with the engine's single varint form, the 64-bit FNV-1a state hash fed by the same writers that produce snapshot bytes, and a golden-bytes test pattern with an explicit bless command. The `hash` fixture's cross-runtime golden is computed through these and still agrees natively, in Node, in Bun and in three browsers.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0002-determinism-same-wasm-everywhere.md` (§2 rows on NaN, integers, collections; §3 all bullets)
3. `docs/decisions/0003-game-facing-api.md` (the `Codec` bullet under the trait listing; the bounds on `Action`/`Entity`/`Player`/`Global`)
4. `docs/decisions/0011-wire-format-and-deltas.md` (Encoding; Decode path: what `Codec` must serve without allocating)

Mine from spikes: `spikes/determinism-hash/src/lib.rs` lines 11–61 (`mix64`), `RESULT.md` "Rules for a deterministic crate" rule 4 (the `x != x` canonicalisation) and the NaN rows of the results table (bit patterns to use as test inputs). Rules that apply: `.claude/rules/determinism.md`.

## Scope
- `Codec`: a blanket marker over `Serialize + DeserializeOwned` plus free functions that encode into a caller's slice or any `ByteSink`, measure, decode a prefix and return the rest, and decode untrusted input canonically. No allocation for plain-data types.
- NaN canonicalisation inside the serializer (every `f32`/`f64` at any nesting depth), with the `debug_assert!` of 0002 §3.
- `ByteSink` / `ByteReader`: little-endian fixed-width puts and gets, and one unsigned LEB128 varint byte-identical to postcard's, for the hand-written framing of 0011 and the containers of 0005.
- `impl ByteSink for Fnv64` (M02's hasher), `StateHash`, `hash_value`, `mix64`.
- Byte-golden helpers (Rust macros + bless command) beside M02's checkpoint-hash goldens; TS `fnv1a64Hex` for bytes read out of regions.
- `determinism.md` gains the `Codec`/hash rules.

## Non-scope
- Frame header, sections, section ids, overlay run format: M14. Snapshot and log containers, crc32: M22. Per-chunk desync hashes: M31b. `SimRng`: M12. Heavy mode and replay equality: M22/M22b/M36.
- `sim_hash`, `runHashScenario`, `golden.json` and `pnpm golden`: M02/M03 own them; this milestone only changes what the `hash` fixture feeds its hasher.
- A canonicalising *deserializer* (Planning decisions 2).

## Files, packages and crates touched
- `packages/engine/crates/engine/`: `src/codec.rs`, `src/bytes.rs`, `src/hash.rs` (extended), `src/testing/golden_bytes.rs` (under M02's `testing` feature), `tests/codec.rs`, `tests/no_alloc_codec.rs`, `tests/golden/*.hex`.
- `packages/engine/` TS: `src/test.ts` (`fnv1a64Hex`), `tests/unit/fnv.test.ts`; root script `golden:bytes`; `scripts/lib/no-usize.test.mjs`.
- `packages/engine/fixtures/hash/`: part of its state becomes a `Codec` struct; `golden.json` re-blessed with `pnpm golden hash`.
- `.claude/rules/determinism.md` (extended).

## Seams
**Provides** (Rust paths under `engine::`):
- `codec::Codec`; `codec::encode<T: Codec>(&T, &mut [u8]) -> Result<usize, CodecError>`; `codec::encode_to<T: Codec>(&T, &mut impl ByteSink) -> Result<(), CodecError>`; `codec::encoded_len<T: Codec>(&T) -> usize`; `codec::decode<T: Codec>(&[u8]) -> Result<(T, &[u8]), CodecError>`; `codec::decode_canonical<T: Codec>(&[u8]) -> Result<T, CodecError>`; `codec::canon_f32_bits(f32) -> u32`, `codec::canon_f64_bits(f64) -> u64`; `CodecError { Overflow, Malformed, NonCanonical, Trailing }`.
- `bytes::ByteSink` (`put(&[u8])`, provided `put_u8/u16/u32/u64/i32`, `put_varint(u64)`), `bytes::SliceSink<'a>` (overflow is an error state read by `finish() -> Result<usize, CodecError>`, never a panic), `bytes::CountSink`, `bytes::ByteReader<'a>` (`u8/u16/u32/u64/i32`, `varint`, `bytes(n)`, `rest`, all `Result`).
- `hash::StateHash { fn hash_state(&self, h: &mut Fnv64); }`, `hash::hash_value<T: Codec>(&T) -> u64`, `hash::mix64(u64) -> u64`, and `impl ByteSink for Fnv64`. `Fnv64`'s M02 methods (`new`, `write`, `write_u32`, `write_u64`, `finish`) are unchanged.
- `testing::assert_golden_bytes!(name, &[u8])`, `testing::assert_golden_hash!(name, u64)`; env `GOLDEN_BLESS=1`; command `pnpm golden:bytes [-- <nextest filter>]`.
- TS, `engine/test`: `fnv1a64Hex(bytes: Uint8Array): string` (16 lower-case hex digits, M02's hash string convention; BigInt is fine, tests only).

**Consumes:** M02: `engine::hash::Fnv64`, feature `testing` and `assert_golden`, fixture `hash` with `scenario.json`/`golden.json`, `pnpm golden`, `runHashScenario`, `abi::Arena` with `abi::arena::live_bytes` (as the no-alloc tests' `#[global_allocator]`), the `clippy.toml` bans of 0002 §3, `.claude/rules/determinism.md`. M03: the `determinism.html` spec in three engines. M01: `pnpm test rust|unit|wasm|browser`, `pnpm lint`.

## Planning decisions
1. **`determinism.md` is created by M02, and that is right** (0021 §1: "the milestone that creates the first code it governs"; M02's `hash` fixture and `Fnv64` are that code, and its globs already cover the crate and the fixtures; M20 adds `games/reference/sim/**`). This milestone appends what only now has a name to point at: state and hashes are built only from `Codec` and `ByteSink` bytes; never hash with `std::hash`; floats in state are finite; `usize` never enters encoded state; untrusted bytes go through `decode_canonical`. The file stays under 40 lines.
2. **Canonicalisation is a delegating serde `Serializer` wrapper** (`CanonSerializer<S>`, overriding `serialize_f32`/`serialize_f64` and wrapping every compound serializer so nested values pass through it), not float newtypes and not a postcard `Flavor` (a flavor sees bytes, not types). No new dependency. Decoding is *not* wrapped: a delegating `Deserializer` must wrap every `Visitor` and is several times the code. Untrusted bytes (uplink actions, M16) go through `decode_canonical`, which decodes, re-encodes into a scratch slice and rejects any difference; that also rejects overlong varints and trailing bytes, so logged bytes are always canonical.
3. **The `debug_assert!` is switchable in tests.** `encode` runs the wrapper with `strict = cfg!(debug_assertions)`; a crate-private `encode_with(strict, ..)` lets dev-profile tests drive NaN through nested types. One `#[should_panic]` test under `cfg(debug_assertions)` proves the assert fires; one `cfg(not(debug_assertions))` test covers the release path when M36 runs the suite on the release profile. The fixture never holds a NaN (a dev-profile `.wasm` would trap, as intended).
4. **Hash = the writer fed to a different sink.** Every canonical writer in the engine takes `&mut impl ByteSink`; passing `Fnv64` hashes without a buffer, passing `SliceSink` produces the snapshot bytes. "The state hash is FNV-1a over canonical snapshot bytes" (0002 §3) is then true by construction. M07, M12, M21 and M22 implement `StateHash` this way.
5. **One varint.** `put_varint` is unsigned LEB128 exactly as postcard encodes `u64`, asserted by test, so hand-framed and serde-framed integers share one form. Signed values in engine framing are fixed-width (0011 Encoding).
6. **Two golden kinds, two commands.** Checkpoint hashes that must hold *across runtimes* stay in a fixture's `golden.json`, written only by `pnpm golden <fixture>` from the `.wasm` run (M02, 0020 §5). Native byte-format goldens are new here: lower-case hex, 32 bytes per line, at `<calling crate>/tests/golden/<name>.hex` (the macro expands `env!("CARGO_MANIFEST_DIR")` in the caller), or one 16-digit line in `<name>.hash`. A mismatch prints one line: name, first differing offset, 16 bytes either side. Files are written only under `GOLDEN_BLESS=1` (`pnpm golden:bytes`); a missing golden fails. M07, M12, M14 and M22 reuse the macros.
7. **`usize` cannot be policed by serde** (it arrives as `u64`); it stays a review rule, stated in `determinism.md`, backed by the source scan `no_usize_in_serialized_types` (Tests added), which later crates' types fall under without an edit.

## Order of work
1. `bytes.rs` with tests (varint boundaries against postcard). 2. `hash.rs`: `impl ByteSink for Fnv64`, `StateHash`, `mix64`. 3. `codec.rs`: canon functions, `CanonSerializer`, the postcard flavor over `ByteSink`, encode/decode functions, `decode_canonical`. 4. `testing/golden_bytes.rs` and `pnpm golden:bytes`; first golden: a sample plain-data struct. 5. Fixture `hash`: move part of its state into a `Codec` struct (ints, enum, `Option`, fixed array, finite `f32` and `f64`) hashed with `hash_value`; `pnpm golden hash`; confirm native, Node, Bun and three browsers agree. 6. `fnv1a64Hex` and its vectors. 7. `determinism.md` additions; `packages/engine/CLAUDE.md` (both golden kinds, both commands).

## Tests added
Rust: `varint_matches_postcard`, `slice_sink_overflow_is_error`, `reader_truncation_is_error`, `fnv64_is_a_byte_sink`, `hash_value_equals_hash_of_encoded_bytes`, `codec_roundtrip_plain_data`, `canon_bits_table` (both quiet-NaN signs, payload NaN, signalling NaN, ±0, ±inf, f32 and f64), `codec_nested_nan_canonical` (via `encode_with(false, ..)`), `codec_nan_debug_asserts`, `codec_nan_release_canonical`, `decode_returns_rest`, `decode_canonical_rejects_{nan_payload,overlong_varint,trailing}`, `golden_codec_sample`, `golden_reports_first_diff`, `golden_missing_fails_without_bless`, `no_alloc_codec` (own test binary with `abi::Arena` as global allocator: encode, decode and `hash_value` of plain data leave `live_bytes` unchanged and allocate nothing in between). TS unit: `fnv1a64Hex vectors` (empty, `a`, `foobar`); `no_usize_in_serialized_types` (`scripts/lib/no-usize.test.mjs`, 0002 §2: in every `.rs` file under `packages/engine/crates/*/src`, `packages/engine/fixtures/*/src` and `games/*/sim/src`, a `struct` or `enum` whose `derive` list has `Serialize` or `Codec` and whose body names `usize` or `isize` fails with file and type name; a regex scan, not a parser). Cross-runtime: M02's `determinism: node matches golden`, the Bun leg and M03's `determinism @engines`, re-blessed.

## Exit criteria
- [x] Every test above passes by name.
- [x] `fx-hash` hashes part of its state through `Codec` + `Fnv64`; its `golden.json` matches natively, under Node, under Bun and in Chromium, WebKit and Firefox.
- [x] `grep -rn "0100_0000_01b3\|100000001b3" packages/engine/crates` finds the FNV prime in `hash.rs` only.
- [x] With `GOLDEN_BLESS` unset a deleted `.hex` fails its test; `pnpm golden:bytes` restores it byte-identically (`git diff --exit-code`).
- [x] `.claude/rules/determinism.md` names `Codec`, `ByteSink`, `decode_canonical` and the no-`usize`-in-state rule, and is under 40 lines.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t codec` · `pnpm test rust -t golden` · `pnpm test unit -t fnv1a64Hex` · `pnpm test wasm -t determinism` · `pnpm test browser -t determinism` · `pnpm golden hash && pnpm golden:bytes && git diff --exit-code` · `pnpm test && pnpm lint`.

## Budgets
Test-suite row of `PRE-PLAN.md` §7: every added Rust test stays under the demotion threshold of 0020. Allocation row: `no_alloc_codec` is the native guard the later zero-GC browser tests rely on.

## Context artifacts
Extends `.claude/rules/determinism.md` (created by M02); updates `packages/engine/CLAUDE.md` ("where goldens live", from M02) with the byte-golden pattern. No skill.

## Manual device checks
none

## Deviations

- **Test placement.** `tests/unit/fnv.test.ts` (brief) → `packages/engine/src/test/fnv.test.ts` (this package's convention: unit tests sit beside their source, `packages/engine/CLAUDE.md` "Where tests live"). `no_usize_in_serialized_types` lives entirely in `scripts/lib/no-usize.test.mjs` (no separate `no-usize.mjs`): Biome's `noExportsInTest` forbids exporting the scan function from a test file, and the existing `crate-policy.test.mjs` sets the precedent of keeping the logic un-exported in the test module itself.
- **`decode_canonical` re-encodes non-strict.** Not spelled out by the brief: `decode_canonical`'s internal re-encode-and-compare step must call `codec::encode_to_with(false, ..)`, not the public `encode` (which is `strict = cfg!(debug_assertions)`). Untrusted bytes can legitimately decode to a NaN, and that is exactly the case this function exists to reject as an ordinary `CodecError::NonCanonical`, not crash on `encode`'s debug assert (`decode_canonical_rejects_nan_payload` caught this).
- **Seam shapes as landed** (all in `packages/engine/crates/engine/src/`): `codec::{Codec, CodecError, canon_f32_bits, canon_f64_bits, encode, encode_to, encoded_len, decode, decode_canonical}` exactly as specified; `encode_to_with(strict: bool, ..)` is `pub(crate)`. `bytes::{ByteSink, SliceSink, CountSink, ByteReader}` exactly as specified; `ByteReader::rest()` is infallible (returns `&[u8]`, not a `Result`) since an empty tail is always valid — the brief's "all Result" is read as covering the accessors that can run past the end. `hash::{mix64, StateHash, hash_value}` and `impl ByteSink for Fnv64` as specified; `StateHash` has no blanket impl for `Codec` types (kept open for M07/M12/M21/M22's hand-written `hash_state`, which may not go through one `encode_to` call). `testing::golden_bytes::{check_bytes, check_hash}` back the `assert_golden_bytes!`/`assert_golden_hash!` macros (re-exported at `engine::testing::` via `pub use crate::{..}`, since `#[macro_export]` macros land at the crate root).
- **Postcard confirmed, not assumed:** read from the fetched `postcard` 1.1.3 source (`~/.cargo/registry/src/.../postcard-1.1.3`) rather than guessed: `f32`/`f64` serialize as 4/8 raw little-endian bytes (no varint); `Option` tag is one raw byte (0/1, not varint); the `u64` varint decoder (`try_take_varint_u64`) accepts an overlong encoding like `[0x80, 0x00]` for `0` without erroring — postcard does not police canonicality itself, which is why `decode_canonical`'s re-encode-and-compare is load-bearing, not redundant.
- **No ADR needed for `postcard`.** It was already on the `docs/decisions/0017-packaging-and-build.md` §7 allowed-crate list (and `scripts/lib/crate-policy.test.mjs`'s `ALLOWED`); only `Cargo.toml` needed the new `[dependencies]` line, `default-features = false, features = ["alloc"]` as §7 specifies.
- **Measured numbers.** `packages/engine/CLAUDE.md` 46 → 47 lines (cap 60). `.claude/rules/determinism.md` 23 → 25 lines (cap 40). `fx-hash` golden: 10 checkpoints, last `2fd8ac19d148e09d` (all prior checkpoints changed too, since `sim_hash` now mixes in `hash_value(&Sample)` in place of the old manual `tick`/`rng` writes — `golden/scenario.json` is byte-for-byte unchanged). `codec_sample.hex` = `071701060701090102030000c03f00000000000002c0` (23 bytes); `codec_sample_hash.hash` = `db8c83d5f184af3e`. `gc-loop`'s `sim` isolate stayed inside its 8 B/frame strict budget in `packages/engine/budgets.json` (untouched, per instruction) after the fixture change.
- **Orchestrator gate (2026-09-19):** `pnpm gate 6682458`: tree clean, 24 files, +1680/−21, no markers; goldens CHANGED lists only `packages/engine/fixtures/hash/golden/golden.json`, the re-bless this brief plans in step 5 and the orchestrator authorised before delegating (`scenario.json` untouched; the `.hex`/`.hash` files are new). `pnpm test` (`rust` 37, `unit` 64, `wasm` 23, `browser pass 20 tests 6.3s/25s`, which includes `gc-loop` against the unchanged `budgets.json` and determinism in three engines on the new golden) and `pnpm lint` green, run by the orchestrator. Every name under Tests added and Provides found by grep. The delete-and-restore check of exit criterion 4 accepted from the implementer's pasted lines.
