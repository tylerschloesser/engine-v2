# M05: Codec and state hash

Status: not started · After: 04 · Tyler-dependent: no

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
- Frame header, sections, section ids, overlay run format: M14. Snapshot and log containers, crc32: M22. Per-chunk desync hashes: M31. `SimRng`: M12. Heavy mode and replay equality: M22/M36.
- `sim_hash`, `runHashScenario`, `golden.json` and `pnpm golden`: M02/M03 own them; this milestone only changes what the `hash` fixture feeds its hasher.
- A canonicalising *deserializer* (Planning decisions 2).

## Files, packages and crates touched
- `packages/engine/crates/engine/`: `src/codec.rs`, `src/bytes.rs`, `src/hash.rs` (extended), `src/testing/golden_bytes.rs` (under M02's `testing` feature), `tests/codec.rs`, `tests/no_alloc_codec.rs`, `tests/golden/*.hex`.
- `packages/engine/` TS: `src/test.ts` (`fnv1a64Hex`), `tests/unit/fnv.test.ts`; root script `golden:bytes`.
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
1. **`determinism.md` is created by M02, and that is right** (0021 §1: "the milestone that creates the first code it governs"; M02's `hash` fixture and `Fnv64` are that code, and its globs already cover the crate, the fixtures and `games/*/sim`). This milestone appends what only now has a name to point at: state and hashes are built only from `Codec` and `ByteSink` bytes; never hash with `std::hash`; floats in state are finite; `usize` never enters encoded state; untrusted bytes go through `decode_canonical`. The file stays under 40 lines.
2. **Canonicalisation is a delegating serde `Serializer` wrapper** (`CanonSerializer<S>`, overriding `serialize_f32`/`serialize_f64` and wrapping every compound serializer so nested values pass through it), not float newtypes and not a postcard `Flavor` (a flavor sees bytes, not types). No new dependency. Decoding is *not* wrapped: a delegating `Deserializer` must wrap every `Visitor` and is several times the code. Untrusted bytes (uplink actions, M16) go through `decode_canonical`, which decodes, re-encodes into a scratch slice and rejects any difference; that also rejects overlong varints and trailing bytes, so logged bytes are always canonical.
3. **The `debug_assert!` is switchable in tests.** `encode` runs the wrapper with `strict = cfg!(debug_assertions)`; a crate-private `encode_with(strict, ..)` lets dev-profile tests drive NaN through nested types. One `#[should_panic]` test under `cfg(debug_assertions)` proves the assert fires; one `cfg(not(debug_assertions))` test covers the release path when M36 runs the suite on the release profile. The fixture never holds a NaN (a dev-profile `.wasm` would trap, as intended).
4. **Hash = the writer fed to a different sink.** Every canonical writer in the engine takes `&mut impl ByteSink`; passing `Fnv64` hashes without a buffer, passing `SliceSink` produces the snapshot bytes. "The state hash is FNV-1a over canonical snapshot bytes" (0002 §3) is then true by construction. M07, M12, M21 and M22 implement `StateHash` this way.
5. **One varint.** `put_varint` is unsigned LEB128 exactly as postcard encodes `u64`, asserted by test, so hand-framed and serde-framed integers share one form. Signed values in engine framing are fixed-width (0011 Encoding).
6. **Two golden kinds, two commands.** Checkpoint hashes that must hold *across runtimes* stay in a fixture's `golden.json`, written only by `pnpm golden <fixture>` from the `.wasm` run (M02, 0020 §5). Native byte-format goldens are new here: lower-case hex, 32 bytes per line, at `<calling crate>/tests/golden/<name>.hex` (the macro expands `env!("CARGO_MANIFEST_DIR")` in the caller), or one 16-digit line in `<name>.hash`. A mismatch prints one line: name, first differing offset, 16 bytes either side. Files are written only under `GOLDEN_BLESS=1` (`pnpm golden:bytes`); a missing golden fails. M07, M12, M14 and M22 reuse the macros.
7. **`usize` cannot be policed by serde** (it arrives as `u64`); it stays a lint and review rule, stated in `determinism.md`.

## Order of work
1. `bytes.rs` with tests (varint boundaries against postcard). 2. `hash.rs`: `impl ByteSink for Fnv64`, `StateHash`, `mix64`. 3. `codec.rs`: canon functions, `CanonSerializer`, the postcard flavor over `ByteSink`, encode/decode functions, `decode_canonical`. 4. `testing/golden_bytes.rs` and `pnpm golden:bytes`; first golden: a sample plain-data struct. 5. Fixture `hash`: move part of its state into a `Codec` struct (ints, enum, `Option`, fixed array, finite `f32` and `f64`) hashed with `hash_value`; `pnpm golden hash`; confirm native, Node, Bun and three browsers agree. 6. `fnv1a64Hex` and its vectors. 7. `determinism.md` additions; `packages/engine/CLAUDE.md` (both golden kinds, both commands).

## Tests added
Rust: `varint_matches_postcard`, `slice_sink_overflow_is_error`, `reader_truncation_is_error`, `fnv64_is_a_byte_sink`, `hash_value_equals_hash_of_encoded_bytes`, `codec_roundtrip_plain_data`, `canon_bits_table` (both quiet-NaN signs, payload NaN, signalling NaN, ±0, ±inf, f32 and f64), `codec_nested_nan_canonical` (via `encode_with(false, ..)`), `codec_nan_debug_asserts`, `codec_nan_release_canonical`, `decode_returns_rest`, `decode_canonical_rejects_{nan_payload,overlong_varint,trailing}`, `golden_codec_sample`, `golden_reports_first_diff`, `golden_missing_fails_without_bless`, `no_alloc_codec` (own test binary with `abi::Arena` as global allocator: encode, decode and `hash_value` of plain data leave `live_bytes` unchanged and allocate nothing in between). TS unit: `fnv1a64Hex vectors` (empty, `a`, `foobar`). Cross-runtime: M02's `determinism: node matches golden`, the Bun leg and M03's `determinism @engines`, re-blessed.

## Exit criteria
- [ ] Every test above passes by name.
- [ ] `fx-hash` hashes part of its state through `Codec` + `Fnv64`; its `golden.json` matches natively, under Node, under Bun and in Chromium, WebKit and Firefox.
- [ ] `grep -rn "0100_0000_01b3\|100000001b3" packages/engine/crates` finds the FNV prime in `hash.rs` only.
- [ ] With `GOLDEN_BLESS` unset a deleted `.hex` fails its test; `pnpm golden:bytes` restores it byte-identically (`git diff --exit-code`).
- [ ] `.claude/rules/determinism.md` names `Codec`, `ByteSink` and `decode_canonical` and is under 40 lines.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t codec` · `pnpm test rust -t golden` · `pnpm test unit -t fnv1a64Hex` · `pnpm test wasm -t determinism` · `pnpm test browser -t determinism` · `pnpm golden hash && pnpm golden:bytes && git diff --exit-code` · `pnpm test && pnpm lint`.

## Budgets
Test-suite row of `PRE-PLAN.md` §7: every added Rust test stays under the demotion threshold of 0020. Allocation row: `no_alloc_codec` is the native guard the later zero-GC browser tests rely on.

## Context artifacts
Extends `.claude/rules/determinism.md` (created by M02); updates `packages/engine/CLAUDE.md` ("where goldens live", from M02) with the byte-golden pattern. No skill.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
