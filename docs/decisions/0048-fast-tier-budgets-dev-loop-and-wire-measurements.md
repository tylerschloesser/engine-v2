# 0048: Fast-tier budgets, dev loop and wire measurements

Status: Accepted (2026-10-01). Amends [0045](0045-build-profiles-measured.md) §3 (`split-debuginfo`); closes the 0020 §3 / §4 audit, the build-cache item of [0020](0020-testing-strategy.md), the byte-diffing deferral of [0011](0011-wire-format-and-deltas.md) and the `wasm-opt` / `+simd128` deferral of [0002](0002-determinism-same-wasm-everywhere.md); implemented in M36b.

## Context
M36b measured instead of guessing: `pnpm test:timings` (K warm runs of the fast tier, p95 per test), `pnpm measure:rebuild`, a cold build in a fresh worktree, the CI build time, `feature-matrix @slow` and `busy-furnace-field @slow`. Machine: Tyler's Mac (Apple M3 Max), shared with other sessions, so every timing was taken at 1-minute load 5-28 with the CPU-busy fraction recorded beside it (`test-results/timings/`). The brief's per-run records, not this ADR, hold the raw runs.

## Decision

**1. Fast-tier budgets hold; the audit table.** Ten warm runs after the demotions below: `pnpm test` wall p50 **48.5 s**, max 48.9 s (the Requirement's one minute: met, build included; was 49.4 s before M36b). Suite wall p50 / p95 against the 0020 §3 budget: rust 1.40 / 1.52 s (10), unit 1.26 / 1.29 (3), wasm 2.97 / 3.02 (7), netcode 3.96 / 4.35 (10), browser 41.0 / 41.5 (48); build 5.6 s (10). Demotions and shrinks (each an existing assertion kept):

| test | p95 before | action |
|---|---|---|
| `exports-map: pnpm pack ...` | 1,966 ms | `@slow` (spawns `pnpm pack`; the `files` assertion stays fast) |
| `reference_full_game_two_players_ws` | 868 ms | `@slow` (0020 §4 rung 2, real-socket repeat of a test that stays fast) |
| `ring.spsc_sequence` | 1,085 ms | 200,000 -> 50,000 messages (780 laps of the 64-slot ring) |
| `zoomout/baseline-256x144`, `-oscillate-48-tiles-cap144` | 843, 546 ms | 55,000-entity fill moved to `beforeAll` |
| `reference_race_same_spot`, `_same_ingots`, `_last_unit` | 648 / 505 / ~620 ms | `test.each` over (latency, order): six ids each of 45-120 ms, body unchanged; one inject-fail-revert each |

**Left over the 0020 §4 limit, exempt, each the only fast test of its feature** (10 runs, in-suite p95): `build: a crate reached through a symlink builds (realpath)` 783 ms (a real cargo build is the feature), `plugin-dev: nested touch triggers rebuild` 513 ms (waits for a real `fs.watch` event and a rebuild), `seqlock.no_torn_read` and the two `[gc-reference] reference_single_player neg object` controls are right at or just under the limit inside `pnpm test` (cross-thread race detection power; the measurement window is the runtime). `rates/join-dense-visible-first`, `rates/bucket-refill-exact` and `reference_subscription_edge_not_predictable` were over only under contention and are not now.

**2. `unit` runs first.** `unit` measured 3.3-3.8 s in `pnpm test` (over its 3 s WARN) and **1.3 s alone**: the tests were not slow, the CPU was contended by three Vitest runs, nextest and Playwright starting together. `scripts/suites.mjs` gives it `first: true`: it runs alone before the concurrent suites. Result: `unit` 3.35 -> 1.26 s, total wall unchanged (49.5 -> 48.5 s, the others got faster). Rejected, each measured: `VITEST_MAX_WORKERS` 2/4/8, Vitest `fsModuleCache`.

**3. The dev loop: `split-debuginfo = "packed"` in `[profile.dev]` (amends 0045 §3).** On macOS the default `unpacked` keeps every `.rcgu.o` beside the binaries (4.6k per engine edit, 80k after a day) and each freshly linked test binary took 0.5-0.9 s to first launch against 0.16 s: the one-line engine edit drifted 38 -> 60 s and beyond (the M30b recurring tax). `"off"` is flat (35.7 s) but drops the file:line of native backtrace frames; `"packed"` is flat and keeps them, at 1.6 s of `dsymutil` and a larger `target/`. Measured, five reps, flat: engine edit (`hash.rs`) **37.6 s** (37.1-39.5), reference `sim` edit (`noise.rs`) **17.0 s**. The sim edit meets the 30 s compile budget; **the engine edit misses it by ~7.6 s**. Lever 1 (`line-tables-only`) is already pulled; the remaining lever is a crate split, a milestone of its own. This ADR records the miss and does not decide a split or a new budget: that is [Q17](../plan/questions-for-tyler.md) for Tyler.

**4. Build cache: nothing.** M02's triggers: a cold build in a fresh worktree over 3 minutes, or the cached CI build over 5. Measured: fresh worktree, per-worktree `target/`, cold to unit starting **94 s**; CI cached `buildMs` 208-254 s (max 4.2 min, 85 % of the trigger: worth a glance if CI grows). Neither fired: no `sccache`, no shared `CARGO_TARGET_DIR`, no config change.

**5. `wasm-opt` and `+simd128` stay off.** `feature-matrix @slow` builds the reference game and the three golden fixtures on release (a) plain, (b) `wasm-opt -O3` (binaryen 132), (c) `RUSTFLAGS=-C target-feature=+simd128`, replays every golden (`fx-hash`, `fx-worldgen`, `fx-persist` log, the reference full-game log) under Node, Bun and, through `determinism.html`, Chromium, WebKit and Firefox. Local result on arm64: **every golden equal in every variant and runtime**; the same test runs in CI's slow step on x86-64 (read it there below). Equality was not the question; the gain was, and the rule asked for at least 10 % brotli or 10 % median tick time:

| variant | reference raw | brotli | tick median (`tick-large-save node`, 4 interleaved runs) |
|---|---|---|---|
| plain | 713,183 | 194,946 | 10.78 ms |
| `wasm-opt` | 634,752 (-11.0 %) | 191,528 (**-1.75 %**) | 10.65 ms (**-1.2 %**) |
| `+simd128` | 706,288 (-1.0 %) | 194,603 (**-0.18 %**) | 10.74 ms (**-0.4 %**) |

Run-to-run spread inside a variant 0.03 ms; load 4-6. Neither variant earns a second build identity, and `+simd128` would also change the target-features guard and the support floor. `wasm-opt` remains an opt-in deploy choice exactly as 0045 §1 has it. No amendment to 0002. The target-features allowlist test is taught the `simd128` exception for case (c) only (`allowedTargetFeatures('simd128')`); every other module still has none.

**6. Byte diffing: not needed, remains a non-API option.** Cargo feature `measure-diff` (engine, forwarded by `reference-sim` and `fx-busy-field`; compiled out of every normal build, proved by `tests/wasm/measure-diff.test.ts`) counts, per connection and beside the real encoding, `diff_bytes_whole` (tag + id + the entity's encoding, every put actually sent) and `diff_bytes_masked` (tag + id + a bit-per-byte mask + the bytes that changed since the connection's last encoding of that entity, seeded from chunk snapshots; the smaller of that and whole). Reference game, 200 lit furnaces with staggered timers in one client's view (the observer), two players taking once a second, 60 s after all chunks arrived, production hashing: observer downlink **839 B/s** (50,369 B; ChunkDeltas 37,057 B), whole put bytes 33,457, masked 23,296 (**0.696**, 30 % smaller); 117 of 120 takes confirmed, degrade level 1, no collapse; identical on a second run of the seed. At 1,000 furnaces (scale only): 3,148 B/s, 170,518 vs 120,919 (0.709). `rates/steady-busy-field`'s twin: 7,046 B in 5 s, 5,746 vs 4,146 (0.722). The test of [M15's question](../plan/36b-suite-audit-and-measurements.md) needs both (a) steady downlink above the 16 KB/s soft cap or over twice the 1-5 KB/s typical range, and (b) masked at least 40 % below whole. **Neither holds**: 0.84 KB/s is below the typical range even at 200 machines (3.1 KB/s at 1,000), and a mask saves 30 % of put bytes, which is about 20 % of the frame. M36 step 5b removed the O(all entities) encode that made the question urgent, and the tick sits near its 3 ms proxy, so extra per-put work is a cost without a need. No `36c` milestone. The numbers use the byte-mask stand-in; a per-field mask pays about the same (seven fields, one mask byte, four changed fields per smelt completion). Revisit if a game's steady downlink at its own typical view passes 10 KB/s.

## Alternatives rejected
- **`split-debuginfo = "off"`:** 1.9 s faster, but native backtraces lose file:line on macOS.
- **Raising the `unit` budget to 4 s:** the 3 s was met once the suite stopped competing; scheduling fixed it.
- **sccache or a shared target directory:** no trigger fired; a shared directory serialises exactly the parallel agent worktrees it would serve.
- **Allowing `wasm-opt` for release builds:** 1.75 % brotli does not pay for a second build identity and a deploy-skew risk (0017 Consequences).
- **Building byte diffing as a milestone:** see decision 6.

## Consequences
- The engine-edit rebuild is 37.6 s against 30 s until Q17 is answered. A crate split is a new milestone with its own ADR.
- `target/` is about 11 GB with `.dSYM` bundles on macOS.
- `feature-matrix` runs in CI's slow step (`pnpm test:slow`; binaryen 132 on PATH, `REQUIRE_WASM_OPT=1`). Read it from the `test-results` artifact: `test-results/wasm/feature-matrix.json` (arch, per-variant sizes, buildHashes, per-runtime golden verdicts) and `test-results/feature-matrix/<chromium|webkit|firefox>.json` (null is equal); the slow step's `wasm` and `browser` lines say pass or FAIL. Any mismatch there keeps that variant off, never a golden change.
- `measure-diff` stays in the engine crate as a measurement tool; a game that wants the counters forwards the feature like the reference game.

## Sources
- `test-results/timings/` (M36b, 2026-10-01), `test-results/netcode/busy-furnace-field.json`, `test-results/wasm/feature-matrix.json`, CI runs 36829288212, 36814449595, 36794461098, 36788505830.
- [docs/plan/36b-suite-audit-and-measurements.md](../plan/36b-suite-audit-and-measurements.md) Deviations: raw tables.
