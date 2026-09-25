# M22b: Persistence: load, crash recovery from storage, `node:fs`, heavy mode in the test entry

Status: done · After: 22 · Tyler-dependent: no

Split from PLAN row 22 (see M22). M23 and M27 list 22b, not 22, under After.

## Goal
A world stored by M22 loads: the host picks the newest snapshot whose CRC verifies, replays the log tail, truncates at the first torn frame and resumes at the tick 0005 defines. Segments roll, snapshots are pruned, clean boundaries flush. The `node:fs` adapter passes the same conformance suite as memory, and `engine/test` exposes replay with checkpoint hashes and heavy mode over the built `.wasm`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0005-persistence-and-recovery.md` (Formats: pruning sentence; Cadence; Loss windows; Recovery; Storage table `fs` row and the paragraph "Recovery needs no atomic rename"; Idle pause)
3. `docs/decisions/0020-testing-strategy.md` (§4 demotion, §5 determinism assertions, §8 what the engine must expose)
4. `docs/decisions/0013-sessions-and-integrity.md` (World lifecycle paragraph only)
Mine from spikes: none. Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Scope
- ABI imports of bytes: restore a snapshot and replay log bytes in blocks through the receive region.
- `Persistence.open`: create-or-load, recovery from whatever a crash left, resume tick = max(latest snapshot tick, last logged frame tick) (0005 Loss windows).
- Torn-frame truncation, segment rolling, snapshot pruning, "previous snapshot kept until the new one verifies".
- Clean boundaries: M13's `SimHost.pause()` and `stop()` become async-complete: snapshot if dirty, then await `flush()` (0005 Cadence; 0013 World lifecycle: zero-player pause then idle snapshot. The 30 s idle timer and `onIdle` themselves are M27/M28b).
- `fsStorage(dir)` exactly as the `fs` row of the 0005 Storage table.
- `engine/test`: `replayWorld`, `runHeavy`.

## Non-scope
OPFS and browser lifecycle (M23). Epoch bump after recovery, `Skip`, re-instantiation after a trap (M24): this milestone recovers from *storage* state at process start only. Identity mismatch is reported, not handled (M24b). `createWorldServer` and `loadGame` wiring (M27 consumes `Persistence.open` and `fsStorage`; M35b re-exports `fsStorage` for Bun and Deno).

## Files, packages and crates touched
- `packages/engine/crates/engine/src/abi/sim.rs`, `.../src/persist/` (restore/replay drivers)
- `packages/engine/src/host/persistence.ts`, `packages/engine/src/storage/fs.ts`, `packages/engine/src/server-node.ts` (export only), `packages/engine/src/test.ts`
- `packages/engine/fixtures/persist/` (reused)

## Seams
**Provides**
- ABI (sim role): `sim_restore_begin(total_len: u32) -> status`, `sim_restore_push(len: u32) -> status`, `sim_restore_end() -> status`; `sim_replay_begin(segment: u32, offset: u32) -> status`, `sim_replay_push(len: u32) -> status`, `sim_replay_end() -> status`; `sim_replay_valid_end() -> u32` (byte offset in the segment just after the last frame whose CRC verified); `sim_tick_now() -> u32`. Status codes added: `STATUS_IDENTITY_MISMATCH`, `STATUS_CORRUPT`, `STATUS_CONTAINER_VERSION`, `STATUS_TORN_TAIL` (replay stopped at a truncated or CRC-failing frame; not an error for the last segment).
- TS: `Persistence.open(storage, cfg, newInstance: () => EngineInstance): Promise<{ persistence, sim, outcome: 'created' | 'loaded' | 'recovered', tick, truncatedBytes }>`; `class WorldLoadError { kind: 'identity' | 'corrupt' | 'container'; stored?: IdentityJson; running: IdentityJson }` (M24b turns `identity` into the upgrade path); `Persistence.loadLatest(newInstance)` (the snapshot + tail step on its own, reused by M24 after a trap); `SimHost.pause(): Promise<void>` and `stop(): Promise<void>` now resolve after snapshot-if-dirty + `flush()` (signatures from M13; `resume()` unchanged).
- TS: `fsStorage(dir: string): Storage` exported from `engine/server/node` (the name M27 and M35b use).
- `engine/test`: `replayWorld({ wasm, storage, worldId, checkpoints: number[] }): Promise<{ tick: number; hash: string }[]>` and `runHeavy({ wasm, storage, worldId, everyN }): Promise<{ firstDivergentTick: number | null }>` (hash strings are 16 hex digits; `u64` never crosses as a number, 0014 §2).

**Consumes**
- M22: everything under its Provides, in particular `SnapshotReader::push`, `FrameReader::push`, `MemoryStorage.crashClone`, `runStorageConformance`, `ManifestV1`, `worldKeys`.
- M13 `SimHost` (`start/stop/pause/resume`, `sim_genesis`); M02 loader `instantiate(module, role, config, hooks)` → `EngineInstance` (a fresh instance from a kept `WebAssembly.Module`, 0014 §6), `Rx` region for copy-in, `readU64Hex`.

## Planning decisions
1. **Truncation uses `Storage.write` (0024 §2).** `Storage` has no `truncate`. At load the host holds the whole last segment in memory (it just `read` it), so a torn tail is removed by `write(logKey, validPrefix)`; adapters must accept `append` after `write` on one key (0005: "calls on one key take effect in call order"; the conformance helper asserts it). This stays off the tick path.
2. **Segments roll by size at a snapshot boundary (0024 §2).** 0005 defines a segment by its base snapshot and identity but names only the upgrade as a roll trigger. Because `read(key)` returns a whole key and truncation rewrites one, the open segment is sealed and a new one opened when it exceeds `SEGMENT_ROLL_BYTES = 4 MiB` at the moment a periodic snapshot is written; that snapshot becomes the new segment's base and is therefore never pruned (0005 pruning rule). At the "active" rate of 0004 this is one roll per ~60 player-hours.
3. **Snapshot validity is CRC + identity + a log position that exists**, checked newest first; a snapshot naming a segment offset beyond the segment's valid end is skipped as if its CRC failed (covers a snapshot written just before a lost log tail). Pruning runs only after the newer snapshot has been read back and verified once (off the tick path, at the next clean boundary or load), which is the ADR's "kept until the new one verifies".
4. **Replay of a segment is two passes over bytes already in memory**: a scan pass that collects `Skip` targets (M24 gives them meaning; here the set is always empty but the pass exists), then the apply pass. A `Skip` always lives in the same segment as its target (rolls only happen at snapshots; M24 appends the `Skip` before any snapshot).
5. **Full-history verification comes free from segment bases**: `replayWorld` from genesis asserts, at every segment boundary of the same identity, that the state hash equals the base snapshot's `state_hash`. Segments with another identity are skipped with a note (0005: replayable only with their binary).
6. **`fs` adapter buffer**: one preallocated 1 MiB append buffer per open log key; `sync` or a full buffer starts `fs.write` + `fdatasync` and swaps to a second preallocated buffer (two buffers, no per-call allocation); a third pending flush while both are in flight copies into a grown buffer and counts `fsBufferGrows` (expected 0). Snapshot: temp file, `datasync`, `rename` (0005 table).

- **From M22's Deviations (read them for exact shapes).** Log frames carry `tick_delta` from the previous logged frame, so the load path must seed its reference exactly as the writer does: from a snapshot's `log_ref_tick` (0 = no frame logged yet in that segment) when resuming from a snapshot, and reset at every segment open (`sim_segment_header` resets the writer's `last_logged_tick`). Segment rolling is new here, so M22 has **no test that crosses two segments**: add one (genesis replay across a segment boundary, and a segment opened after an idle gap). `persist_fixture_log.hex` (M22 step 3) has a shape no real host writes (no `Connected` records); `persist_abi_log_parity.hex` and `replay_real_host_log_matches_live` are the real-pipeline references. The dirty flag is set by any put or any non-empty sealed frame (`Authority::mark_dirty`). The container formats are amended by the ADR that amends 0005 (`PLAN.md` "Plan-level decisions").

## Order of work
1. Restore/replay ABI drivers over M22 readers; Node test restoring an M22-written snapshot.
2. `Persistence.open` happy path (load, tail replay, resume tick), then crash matrix with `crashClone`.
3. Truncation, rolling, pruning, clean boundaries.
4. `fsStorage` + conformance + one real-directory crash test (tmpdir, truncate a file by hand).
5. `replayWorld`, `runHeavy` in `engine/test`; Bun script repeats `replayWorld` on the fixture log (0020 §3 "WASM under Node and Bun").

## Tests added
Vitest (WASM under Node) unless noted:
- `load_resumes_at_max_of_snapshot_and_log_tick`, `load_empty_storage_creates_world`, `load_ignores_config_params_when_world_exists` (0009 `WorldConfig.params` comment).
- Crash matrix (`crashClone`): `crash_mid_frame_truncates_and_resumes` (every cut point inside the last frame), `crash_torn_snapshot_uses_previous`, `crash_snapshot_without_log_tail_is_skipped`, `crash_before_manifest_rewrite_on_roll`.
- `recovered_hash_equals_uninterrupted_replay`, `resend_after_recovery_not_applied_twice` (last `seq` rebuilt, 0004).
- `segment_rolls_at_snapshot_over_limit` (limit lowered by test option), `prune_keeps_bases_and_latest_two`, `pause_flushes_and_snapshots_if_dirty`.
- `identity_mismatch_throws_world_load_error_and_writes_nothing` (storage byte-equal before/after).
- `storage_conformance_fs`, `fs_append_allocates_no_buffers` (counter), `fs_crash_truncated_file`.
- `replay_world_checkpoints_node`, `replay_world_checkpoints_bun` (script), `heavy_wasm_n50`, `heavy_wasm_n1` (`@slow`).

## Exit criteria
- [x] All tests above pass by name; the crash matrix covers every byte cut of the final frame of the fixture log.
- [x] `replayWorld` hashes under Node and Bun equal the native golden hashes checked in by M22.
- [x] `engine/test` exports `replayWorld` and `runHeavy`; production entrypoints do not import them (exports-map test from M02/M35 pattern).
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test wasm -t crash_` · `pnpm test wasm -t heavy_wasm` · `pnpm test wasm -t storage_conformance_fs` · `pnpm test` · `pnpm lint`

## Budgets
- Latency row (0005): loss windows are asserted structurally by the crash matrix (0 admitted actions lost when `append` returned).
- Test suite row (0020): `heavy_wasm_n50` and the crash matrix must stay under the §4 p95 limit; shrink the fixture log before demoting.

## Context artifacts
Update `packages/engine/crates/engine/src/persist/CLAUDE.md` with one line on the two-pass replay. Add a nested `packages/engine/src/storage/CLAUDE.md` (≤ 15 lines): adapter contract = 0005 Storage paragraph; every adapter must pass `runStorageConformance`; tick-path methods must not allocate or return promises in shipped adapters.

## Manual device checks
none

## Deviations

**Scope actually landed: steps 1-3 only** (base `c398030`, commits `0695d6e` step 1, `248530f`
step 2, `9d652a8` step 3). Steps 4-5 (`fsStorage`, `replayWorld`/`runHeavy`) are a second
implementer's, per the delegation prompt.

### ABI seam shapes, as built (sim role; `ABI_VERSION` 16 -> 17)

- `sim_restore_begin(total_len: u32) -> status`, `sim_restore_push(len: u32) -> status`,
  `sim_restore_end() -> status`: bytes flow through `RegionId::Persist`, reused as a receive region
  exactly the way `sim_admit`/`sim_replay_push` reuse `Rx`/`Persist` (numbers only cross; `total_len`
  is advisory, never used to preallocate). `sim_restore_begin` needs no prior `sim_genesis` (moves
  `Host::pending`'s `WorldParams` out to build the restore shell -- same terrain source/dims/cache
  capacity `Sim::genesis` uses, `sim::DEFAULT_CACHE_CHUNKS`, not `cache_chunks`, since the cache is
  excluded from a snapshot regardless). `sim_restore_end`, on `Status::Ok`, writes `logSegment`,
  `logOffset` (two LE `u32`) into the whole `Result` region -- an undocumented-in-prose but
  established ABI convention (`sim_conn_counters`/`sim_hash` do the same); TS reads them with a
  `DataView`. Identity is compared by `build_hash` alone (0005: "the running identity **hash**"),
  never the other `Identity` fields.
- `sim_replay_begin(segment: u32, offset: u32) -> status` (`segment` unused, like
  `sim_segment_header`'s own -- a segment's index lives in its storage key, never the wire), `sim_
  replay_push(len: u32) -> status`, `sim_replay_end() -> status`, `sim_replay_valid_end() -> u32`,
  `sim_tick_now() -> u32`. `Host::sim_replay_push` re-derives its own `Sim`/`FrameReader` borrows
  fresh per statement (`self.sim.as_mut().unwrap()` etc.) rather than holding one across the loop,
  sidestepping any disjoint-field-borrow subtlety against `self.last_logged_tick`/`self.replay_torn`
  -- this runs once at load, off `.claude/rules/hot-paths.md`'s tick/frame budgets. `last_logged_tick`
  is advanced to each applied frame's own tick as replay runs, not just seeded once, so live logging
  (`sim_seal_frame`) continues with the right `tick_delta` reference immediately after a load hands
  off to real ticking. `sim_replay_valid_end` = `replay_base_offset + fed_bytes -
  reader.buffered_len()` (a new `FrameReader::buffered_len()` accessor); a decode error leaves the
  malformed bytes in the reader's own buffer (never drained), so this stays correct after a torn
  block.
- New `persist::PersistError::ContainerVersion` (distinct from `Malformed`, only for a snapshot's own
  `container_version` mismatch) and `FrameReader::buffered_len()`. `Authority::from_snapshot` and
  `Sim::from_parts` are un-gated to plain `pub` (real production callers now).
- **Single-pass replay, not the two-pass "scan for `Skip` targets, then apply" of Planning decisions
  4**: with the target set always empty until M24 gives `Skip` real meaning, the scan pass has no
  observable effect, so it was not built. Flagged for M24, which will need to add it (`persist/
  CLAUDE.md` now says so).

### TS seam shapes, as built (`packages/engine/src/host/persistence.ts`)

- `Persistence.open(storage, cfg, newInstance, opts?: PersistenceOptions): Promise<{ persistence,
  sim, outcome: 'created'|'loaded'|'recovered', tick, truncatedBytes }>`. `PersistenceOptions =
  { segmentRollBytes?: number }` -- the brief's own "segment-roll option name tests use to lower
  `SEGMENT_ROLL_BYTES`" (default `4 MiB`); also accepted by `Persistence.create` (additive 4th
  param, every existing 3-arg caller unaffected).
- **`Persistence.loadLatest` is `static`, not an instance method**, and takes `(storage, keys,
  manifest, newInstance)`, not just `(newInstance)`: at the point `open` calls it there is no live
  `Persistence` yet (its own `segment`/`logOffset`/`tick` fields are seeded *from* this call's
  result), so there is nothing to call it *on*. M24 (reusing it after a trap, Non-scope here) would
  call it the same static way, with a fresh `newInstance` and the manifest its own now-garbage
  `Persistence` already holds.
- **Identity is checked once, up front, before any restore attempt**: `loadLatest` calls
  `sim_segment_header(0, GENESIS_BASE_TICK)` on the very first instance (needs no genesis) and
  compares its `buildHash` to `manifest.created.buildHash`, throwing `WorldLoadError('identity', ...)`
  immediately if they differ -- covers both the snapshot-based and genesis-replay-based load paths
  uniformly, so `identity_mismatch_throws_world_load_error_and_writes_nothing` never actually reaches
  `sim_restore_end`'s own `Status::IdentityMismatch` check. That Rust-side check is still real
  (defense in depth, and the only one M24b's segment-identity-diverges-from-manifest case would ever
  hit) but is exercised directly instead: a native test, `fixtures/persist/tests/
  restore_identity.rs` (`restore_rejects_a_mismatched_identity`/`restore_accepts_a_matching_
  identity`), calling `Host<Persist>` trait methods with no ABI/wasm boundary at all.
- **Storage call sequence at load** (`loadLatest`): `read(manifest)` -> `sim_segment_header` (no
  storage) -> `list(snap/)` -> per candidate, newest tick first: `read(snap key)`, `sim_restore_*`,
  `read(log(logSegment))` (validates `logOffset` against its length, Planning decisions 3) -> once
  picked: `read(log(logSegment))` again (only once more, for the actual tail), `sim_replay_*`, and
  -- only if torn -- **exactly one** `write(logKey, validPrefix)` (Planning decisions 1: `Storage`
  has no `truncate`; the conformance suite's `append_accumulates_in_call_order` check is what proves
  an adapter accepts `append` after this `write` on the same key). `healManifest` then does at most
  one more `write(manifest)`; `pruneSnapshots` (called by `open` after every load) does one
  `list(snap/)` plus a `delete` per pruned key.
- Segment rolling (`Persistence.rollSegmentIfNeeded`, private, called from `snapshotNow`): the new
  segment's `append(log(newSegment), header)` and the roll-triggering snapshot's own
  `write(snap(tick), bytes)` both land **before** the manifest rewrite, which is issued last, by
  `snapshotNow` itself once it has the bytes -- not immediately after computing the new segment, as
  a naive reading of Planning decisions 2 might do. This ordering is what makes `crash_before_
  manifest_rewrite_on_roll` a real crash point (both new-segment artifacts already durable, only the
  manifest stale) rather than a same-tick-chosen coincidence.
- Pruning (`Persistence.pruneSnapshots`, public): keeps every `segments[].base` that is a `number`
  (a segment's own base snapshot, 0005: "kept until the new one verifies") plus the lexicographically
  (= numerically, zero-padded) latest two `snap/` keys. Runs from `Persistence.open` (after a
  successful load) and from `SimHost.pause`/`stop` (after `snapshotIfDirty`, before `flush`) --
  **never** from the periodic `afterTick` cadence, since it needs `Storage.list` and 0005 places
  `list` "off the tick path only".
- `SimHost.pause()`/`stop()` are `async` now (`Promise<void>`): disarm the timer synchronously first
  (so their own prior synchronous behavior for a `persistence`-less host, e.g. `server.test.ts`'s
  `simhost_pause_stops_ticks`, is unaffected by an unawaited call), then `snapshotIfDirty()` ->
  `pruneSnapshots()` -> `flush()` when a `Persistence` is wired in. Grepped every `.pause(`/`.stop(`
  call in `src`/`tests`/`games`: the only `SimHost.pause()` caller (`server.test.ts`) is a
  fire-and-forget call whose assertions run before the first `await` inside `pause()`, so it needed
  no change; no `SimHost.stop()` caller exists yet. `worker/sim.ts` never wires a `Persistence` in
  (still M27's job), so no zero-GC page's steady-state path is touched; `pnpm test browser -t sim`
  (18 tests) confirmed.
- **Session/connection resume after a load is real, and is not this milestone's** (found by
  `resend_after_recovery_not_applied_twice`): a recovered/loaded `Sim` has an empty `Host::conns`
  table (replay only ever calls `Sim::step`, never `Host::connect`), so a caller must `sim_connect`
  again before any new `sim_admit` is anything but silently ignored -- flagged for M27/M28
  (`createWorldServer`/session resume), which own reconnecting a returning player after a load.

### Tests, by file

- `tests/wasm/persist-restore.test.ts` (step 1): raw-ABI restore/replay against a real M22-written
  snapshot/log (`restore_reproduces_an_m22_written_snapshot`, `restore_fails_a_corrupted_snapshot`),
  plus the two required-by-Deviations cross-segment cases built by hand at the ABI layer (segment
  rolling itself is step 3's): `genesis_replay_across_a_segment_boundary_equals_live`, `restore_
  after_an_idle_gap_then_more_frames_equals_live`.
- `fixtures/persist/tests/restore_identity.rs` (step 1): the native identity-mismatch pair above.
- `tests/wasm/persist-open.test.ts` (step 2): `Persistence.open`'s happy path (create, clean reload)
  and the crash matrix (`crash_mid_frame_truncates_and_resumes` -- every byte cut of a real two-frame
  world's final frame; `recovered_hash_equals_uninterrupted_replay`; `crash_torn_snapshot_uses_
  previous`; `crash_snapshot_without_log_tail_is_skipped`; `resend_after_recovery_not_applied_twice`
  using `Roll`, additive; `identity_mismatch_throws_world_load_error_and_writes_nothing`, byte-
  comparing every key before/after). All through a real `SimHost`+`Persistence` pipeline with real
  `Connected` records (`instantiate`/`buildSimInstanceConfig`/a client-role encoder instance for
  admitted actions) -- never `persist_fixture_log.hex`'s shape.
- `tests/wasm/persistence.test.ts` (step 3, added to the existing file): `pause_flushes_and_
  snapshots_if_dirty`, `stop_flushes_and_snapshots_if_dirty`.
- `tests/wasm/persist-rolling.test.ts` (step 3): `segment_rolls_at_snapshot_over_limit`, `prune_
  keeps_bases_and_latest_two`, `crash_before_manifest_rewrite_on_roll` -- all with `segmentRollBytes:
  64` so a roll costs six `sim_connect` frames, not 4 MiB.

### Anti-vacuity (inject/fail/revert; fail lines pasted verbatim)

- `restore_after_an_idle_gap_then_more_frames_equals_live`: seeded `last_logged_tick` from `info.
  tick` instead of `info.log_ref_tick` in `sim_restore_end` -> `AssertionError: expected 12 to be 7`.
- `genesis_replay_across_a_segment_boundary_equals_live`: removed `self.replay_fed = 0` from
  `sim_replay_begin` (segment 1's replay inherits segment 0's own byte count) -> `AssertionError:
  expected 79 to be 66` (`sim_replay_valid_end`).
- `restore_rejects_a_mismatched_identity`: disabled the `build_hash` comparison in `sim_restore_end`
  -> `assertion left == right failed\n left: Ok\n right: IdentityMismatch`.
- `crash_mid_frame_truncates_and_resumes`: skipped the on-disk `storage.write` truncation in
  `loadLatest` -> `AssertionError: expected 73 to be 62` (the log key's own byte length, still torn).
- `recovered_hash_equals_uninterrupted_replay`'s own path: disabled the `logOffset` vs.
  segment-length check (Planning decisions 3) -> `AssertionError: expected 'loaded' to be
  'recovered'` on `crash_snapshot_without_log_tail_is_skipped` (the snapshot was wrongly accepted).
- `crash_torn_snapshot_uses_previous`: made `loadLatest` accept any `endStatus` (ignore `Corrupt`) ->
  `Error: Persistence.loadLatest: sim_replay_begin failed: status 2` (garbage `Result` bytes from
  the failed restore fed straight into replay).
- `pause_flushes_and_snapshots_if_dirty`/`stop_flushes_and_snapshots_if_dirty`: removed the
  `snapshotIfDirty`/`pruneSnapshots`/`flush` calls from `pause()` -> `AssertionError: expected +0 to
  be 1`.
- `segment_rolls_at_snapshot_over_limit`: raised the effective roll threshold by `1e9` -> `AssertionError:
  expected null not to be null` (segment 1's log key never created).
- `prune_keeps_bases_and_latest_two`: disabled the segment-base keep rule -> `AssertionError:
  expected Set{ 'worlds/w1/snap/0000000007', …(1) } to deeply equal Set{ 'worlds/w1/snap/0000000006',
  …(2) }` (the base was pruned).
- `crash_before_manifest_rewrite_on_roll`: disabled `healManifest`'s own heal -> `AssertionError:
  expected [ { index: +0, …(4) } ] to have a length of 2 but got 1` (the load itself still succeeded
  correctly -- proving `loadLatest` never depended on the manifest being current -- but the manifest
  stayed stale forever without the heal).

### Measured

`cargo nextest run --workspace --features engine/testing,testing`: 518 tests, 518 passed, 2 skipped
(unchanged slow tests). `pnpm test`: `rust pass 518 tests`, `unit pass 233 tests`, `wasm pass 89
tests`, `browser pass 185 tests`. `pnpm lint`: biome/rustfmt/clippy/tsc all green. No existing golden
moved (nothing here touches a byte format; `persist_frame_golden_bytes`/`persist_snapshot_golden_
bytes`/`persist_abi_log_parity.hex` untouched).

### Context artifacts

- `packages/engine/crates/engine/src/persist/CLAUDE.md`: one line on replay being single-pass (not
  the two-pass design), flagged for M24.
- `packages/engine/src/storage/CLAUDE.md`: unchanged -- M22 already wrote exactly what this brief's
  own Context artifacts section asks for (adapter contract, `runStorageConformance`, tick-path
  no-alloc); nothing built in steps 1-3 changes any adapter.
- `packages/engine/src/host/CLAUDE.md`: extended with the load/roll/prune/async-pause sections above.
- `packages/engine/crates/engine/CLAUDE.md`: the stale `ABI_VERSION`/export list line patched to name
  this half's six new exports and version 17 (same drift M22 steps 4-6 found and fixed for its own
  four).

### Deferred / flagged for the orchestrator

- Steps 4-5 (`fsStorage`, `replayWorld`/`runHeavy`, the Bun leg) are the second implementer's.
- Session/connection resume after a load (above) is real and flagged for M27/M28.
- M36's own stall-measurement question about `SnapshotWriter`'s whole-buffer (not truly incremental)
  design, carried over from M22's own Deviations, is untouched by this half.

## Steps 4-5 (second implementer)

Base `dcf889b` (a new test added first, per the delegation prompt, before steps 4-5: see its own
commit, `M22b: load_after_roll_with_idle_gap_replays_new_segment_tail`). Commits: `30414ba` (step 4:
`fsStorage`), then `replayWorld`/`runHeavy` + the Bun leg (step 5, this commit).

### The uncovered test (before steps 4-5)

`load_after_roll_with_idle_gap_replays_new_segment_tail` (`tests/wasm/persist-rolling.test.ts`): six
real connects grow segment 0 past `TINY_ROLL_BYTES`, three idle ticks (so the roll tick and segment
0's own last-logged tick genuinely differ), `snapshotNow()` rolls to segment 1, then two more
connects with an idle tick between them, then `Persistence.open` a fresh instance. Asserts `outcome:
'loaded'`, `tick` and hash match the live host. Anti-vacuity: seeding `Host::sim_restore_end`'s own
`last_logged_tick` from `Tick(0)` instead of `info.log_ref_tick` -> `AssertionError: expected 11 to
be 12`. Reverted, green (no real production bug found here -- fix round 2's own `log_ref_tick`
already covers this shape correctly).

**A second injection tried per the brief's own suggestion turned out vacuous, a real finding.**
Removing `sim_segment_header`'s reset of `last_logged_tick` for a non-genesis `base_tick` (leaving it
at whatever segment 0's own last real frame left behind) does **not** fail this test: the same
now-stale `last_logged_tick` value is used both to seed the new segment's base snapshot's own
`log_ref_tick` *and* to compute every subsequent frame's `tick_delta` on the write side, so the two
errors cancel exactly the way M22's own "restore silently reuses the old `Sim`" finding did (checked
in that milestone's Deviations) -- a self-consistent bug is invisible to hash/tick comparison alone
when both sides of a relative encoding share the same wrong reference. The reset is still correct and
still matters (Planning decisions 2's own segment-base bookkeeping, and any future feature reading
`log_ref_tick` on its own rather than only through the tick_delta chain), but no test built here or in
the first half can catch its removal by hash comparison. Reverted; flagged for whoever next touches
`sim_segment_header`'s reset.

### `fsStorage` (step 4), as built

- `fsStorage(dir: string, debug?: FsStorageDebug): Storage` (`src/storage/fs.ts`), exported only from
  `engine/server/node` (`server-node.ts`). `debug` is an additive, test-only second parameter
  (`createFsStorageDebug()` builds the placeholder `fsStorage` fills in) reading the summed
  `fsBufferGrows` counter across every open key, without widening the `Storage` interface itself for
  one test's own assertion.
- Per log key: a two-buffer pool (`LogAppender`), not a fixed front/back pair -- `append` copies into
  whichever buffer is checked out as "front"; a full buffer or `sync()` hands the filled one to an
  async `fs.write` + `fdatasync` chain and checks a buffer out of the free pool for the next `append`;
  when the pool is empty (both mid-flush) a one-off grown buffer is allocated and counted. Same shape
  as Planning decisions 6, expressed as a pool rather than named front/back slots.
- **`read`/`list` await a live appender's own `sync()` first.** Not in the brief's own wording, but
  required for `append_accumulates_in_call_order` (`runStorageConformance`'s own read-right-after-
  append shape) to pass at all: a real `fs`-backed `read()` sees only what has actually reached disk,
  and 0005 groups `read`/`list` with `flush` as "off the tick path only", so awaiting a sync first
  costs nothing the interface promises elsewhere.
- `write` (snapshot/manifest/session, "atomic replace"): temp file (`<path>.tmp-<pid>-<counter>`,
  a per-process counter, not `Math.random()` -- `lint.no_ambient_random` forbids it outside
  `src/clock.ts`/`src/test/**`, and a first draft used `Math.random()` and failed that check, fixed
  before commit), `datasync`, `rename`. Drops (closes) any open appender for the same key first, so a
  subsequent `append` reopens cleanly against the new file (Planning decisions 1: "adapters must
  accept `append` after `write` on one key").
- `list(prefix)` is a full recursive walk from `dir` (tmpdir/test scale, not a real deployment's own
  key index) -- adequate for `storage_conformance_fs` and the crash test, flagged if a later milestone
  points `fsStorage` at a large real directory.
- Anti-vacuity: `fs_append_allocates_no_buffers` -- injecting an unconditional `this.fsBufferGrows++`
  at the top of `append` -> `AssertionError: expected 20 to be +0`. Reverted, green.
  `fs_crash_truncated_file` -- injecting a `write()` that returns without doing anything (matching the
  same class of defect `crash_mid_frame_truncates_and_resumes` guards against, but against a real file)
  -> `AssertionError: expected 'created' to be 'recovered'` (broke `Persistence.create`'s own manifest
  write too, since `write()` is shared -- still a genuine failure, not a vacuous pass). Reverted, green.

### `replayWorld`/`runHeavy` (step 5), as built

`src/test/replay.ts` (new), exported from `engine/test` (`test.ts`). Neither takes a raw log: both
take `{ wasm, storage, worldId }` and walk `manifest.segments` from genesis through the latest,
restoring each non-genesis segment's own base snapshot through the same `sim_restore_*` ABI
`Persistence.loadLatest` uses, and driving each segment's log tail tick-by-tick (not through
`sim_replay_push`'s own opaque multi-tick idle catch-up) so a caller can interject at an exact tick --
`runHeavy`'s own requirement.

- **`log_ref_tick` is derived from the manifest, not read off the wire.** `sim_restore_end`'s `Result`
  output is only `logSegment`/`logOffset` (Seams, unchanged here); this module instead uses the fact
  that for any segment this milestone's own `Persistence` produces, a roll's base snapshot is always
  taken *immediately* when the new segment opens, before any frame is logged in it -- so
  `manifest.segments[i].base` (the tick number) always equals that segment's own `log_ref_tick` too.
  Recorded as a real, if narrow, assumption: a future producer of `ManifestV1` that snapshots a
  segment's base at some *other* point (nothing does today) would break this module silently, not
  loudly -- flagged for whoever builds one.
  Documented in the module's own header comment.
- A small frame scanner (`scanFrames`) reads only the leading `len` varint and the body's own leading
  `tick_delta` varint per frame -- never a full record decode -- to find byte ranges and ticks in JS
  without duplicating `FrameReader`'s own decode logic. Bug found and fixed while building
  `replay_world_checkpoints_node`: the checked-in golden hex files (`assert_golden_bytes!`'s own
  format) wrap at 32 bytes per line, and a first draft that only `.trim()`ed the file (not stripping
  every whitespace byte) silently corrupted every byte after the first line -- caught immediately by
  a real `Status::TornTail` (14) from `sim_replay_push`, not a silent wrong-hash pass, and confirmed
  against a throwaway native probe (`engine::persist::FrameReader` decoding the same file) before
  fixing the JS side.
- **`runHeavy` replays only what the log actually holds** (native `heavy()`'s own shape: a raw log has
  no representation of an idle tail past the last real frame at all), stopping at the last logged
  frame's own tick rather than continuing to some caller-supplied ceiling -- `replayWorld` is the one
  that continues idling up to a requested checkpoint past the last frame (the M22 fixture's own tick
  320 checkpoint, well past its last real frame at tick 79).
- Both runs of `runHeavy` (A uninterrupted, B restoring every `everyN` ticks) are driven sequentially,
  not concurrently, comparing hash maps keyed by tick afterward -- they process the identical frame
  sequence by construction, so this needs no lock-step live comparison.
- Anti-vacuity: `replay_world_checkpoints_node` -- `frameTick = reference + tickDelta + 1` (an
  off-by-one in the tick-delta chain) -> `AssertionError: expected [ { tick: 8, ... } ] to deeply
  equal [ { tick: 8, ... } ]` (values differ under the collapsed diff). Reverted, green.
  `replay_world_detects_a_segment_boundary_hash_mismatch` (new, permanent test: Planning decisions 5,
  "make sure it is exercised and made failable" -- the single-segment cases can never reach this
  check at all) -- disabling the boundary-hash assertion and tampering with segment 1's own base
  snapshot (swapped for a valid-but-wrong one, a pristine genesis snapshot under the same identity) ->
  `Error: promise resolved [...] instead of rejecting`. Reverted, green.
  `heavy_wasm_n50`/`n1` (`runHeavy`'s own "never reuse the running instance") -- corrupting one byte
  of the snapshot `takeSnapshotBytes` captures before `restoreFresh` decodes it -> `Error: runHeavy:
  sim_restore_push failed: status 12` (`Status.Corrupt`), proving the swap path genuinely rebuilds and
  redecodes rather than skipping the work. **The more literal injection the brief itself suggested
  (skip `cell.sim = restoreFresh(bytes)` entirely, keep ticking on the same instance) passed
  vacuously** at both N=50 and N=1: `fx-persist` has no hidden state a live instance could carry that
  a correct restore wouldn't also reproduce (the exact class of gap M22's own Deviations already
  documented for its native heavy mode, "a skipped restore is behaviourally identical to a real one"
  with no deliberately-hidden state to exercise) -- the corrupted-bytes injection above is the one that
  actually exercises this pipeline's own independence.

### Two-segment real-pipeline coverage (Planning decisions 5)

`replay_world_checkpoints_two_segment_real_pipeline` (`tests/wasm/replay-world.test.ts`): a real
`SimHost` + `Persistence` run that actually rolls a segment (`segmentRollBytes: 64`), recording the
live host's own per-tick hash, then asserting `replayWorld`'s own checkpoints (at every one of those
ticks) match exactly -- no checked-in golden for this case (native and `.wasm` parity was not claimed
for it; the live run and `replayWorld`'s own read of the same in-memory storage are compared directly
within one test process). This is what exercises Planning decisions 5's cross-segment hash assertion
against a genuine two-segment world at all, and `replay_world_detects_a_segment_boundary_hash_mismatch`
(above) is what proves the assertion itself is real.

### The Bun leg

`tests/wasm/bun-leg.mjs` gained `runReplayLeg()` (`replay_world_checkpoints_bun`): the identical
`replay_world_checkpoints_node` shape (M22's own checked-in fixture log, wrapped in a synthetic
single-segment `MemoryStorage` with a real prepended segment-0 header), against `dist/` under
JavaScriptCore. `scripts/suites.mjs`'s `wasm` suite's `bun` leg gained the name in its own `tests`
list (used only for `-t` pattern matching, per `scripts/lib/adapters.mjs`'s `script` adapter) --
no new leg, no new runner, per the brief's own instruction.

### Exports-map test

No `exports-map` test exists yet (M35's own is unbuilt); `src/test.test.ts` (new) is the first one:
a direct-import source scan of every exports-map subpath's backing file plus `loader.ts`/`abi.ts` for
any `test.js`/`test/` import (mirroring the exact files the docs/plan/03-browser-harness.md
orchestrator gate once grepped `dist/` for by hand), plus a positive check that `replayWorld`/
`runHeavy` really are exported. Anti-vacuity: adding `import { replayWorld as _x } from './test.js'`
to `loader.ts` -> `Error: production entrypoints importing engine/test: loader.ts` (caught by
`vitest run src/test.test.ts` directly; the same injection also broke the `pages` build step outright
via a circular worker-import error, an even stronger real-world proof). Reverted, green.

### Measured

`cargo nextest run --workspace --features engine/testing,testing`: 518 tests, 518 passed, 2 skipped
(unchanged). `pnpm test`: `rust pass 518 tests`, `unit pass 235 tests`, `wasm pass 98 tests`,
`browser pass 185 tests` (31-33 s of the 48 s budget). `pnpm lint`: biome/rustfmt/clippy/tsc all
green. `pnpm test:slow wasm -t heavy_wasm_n1`: `wasm pass 1 tests 0.7s`. No existing golden moved
(nothing here writes a byte format; `persist_fixture_log.hex` and its checkpoint goldens are only
read, never regenerated).

### Context artifacts

- `packages/engine/src/storage/CLAUDE.md`: extended with an `fs.ts` bullet (buffer pool, `write`'s
  atomic-replace path, `read`/`list` awaiting a live appender's own sync first). 29 lines, under the
  file's own 60-line hard cap (`scripts/lib/context-artifacts.test.mjs`).
- `packages/engine/crates/engine/src/persist/CLAUDE.md`/`src/host/CLAUDE.md`: unchanged -- nothing in
  steps 4-5 touches Rust `persist::` or `Persistence` itself; `src/test/replay.ts` only calls the same
  ABI exports `Persistence.loadLatest` already does.

### Deferred / flagged for the orchestrator

- `replayWorld`/`runHeavy`'s own `log_ref_tick`-equals-`base` assumption (above) is narrow and
  undocumented anywhere but this module's own header comment -- flagged for M24 (`Skip`/panic
  recovery) and anything else that might one day snapshot a segment mid-stream rather than only at
  its own base.
- The segment-header-reset vacuity finding (above) is real: no test in either half of this milestone
  can catch that specific defect by hash comparison. Not fixed (the code is already correct); flagged
  for whoever next touches `sim_segment_header`.
- `fsStorage`'s `list()` is a full recursive directory walk -- fine at tmpdir/test scale, flagged if a
  later milestone (M27) points it at a real, larger deployment directory.

## Fix round 1

A review agent found four tests that could not fail or did not exist. All four fixed.

1. **`pause_flushes_and_snapshots_if_dirty`/`stop_flushes_and_snapshots_if_dirty` never proved
   completion, only that `storage.flush()` was called** (`flushCalls++` increments synchronously
   inside `Persistence.flush()` before its own `await`, regardless of whether `server.ts`'s
   `pause()`/`stop()` await the result). New `pause_is_still_pending_until_flush_resolves`/
   `stop_is_still_pending_until_flush_resolves` (`tests/wasm/persistence.test.ts`): a storage whose
   `flush()` returns a promise resolved by hand; asserts the snapshot already landed (re-reading
   storage) by the time `flush()` was called, that `pause()`/`stop()` are still pending after that,
   and that they resolve only once the flush promise does. Anti-vacuity: `persistence?.flush()`
   without `await` in both `server.ts` methods -> `AssertionError: expected true to be false` (both
   tests). Reverted, green.
2. **The exports-map test was one hop deep.** A production module importing a helper that itself
   re-exports `replayWorld` from `test/replay.js` would have passed the direct-scan version.
   `src/test.test.ts` rewritten: `reachableFiles` walks the whole relative-import graph from each
   production entrypoint (`.js` specifiers resolved back to `.ts` sources via `URL`, recursively),
   failing on any reachable file under `src/test/` or `src/test.ts` itself. Anti-vacuity: a throwaway
   `src/injected-leak-helper.ts` re-exporting `replayWorld` from `test/replay.js`, imported from
   `loader.ts` -> `Error: production entrypoints transitively reaching engine/test: client.ts ->
   test/replay.ts, worker.ts -> test/replay.ts, render.ts -> test/replay.ts, loader.ts ->
   test/replay.ts`. Reverted (file deleted, import removed), green.
3. **`load_ignores_config_params_when_world_exists` was never built.** New test (`tests/wasm/
   persist-open.test.ts`): creates a world under one seed with real `Roll` actions (so the seed
   genuinely drives `SimRng`-dependent state) and a mid-run snapshot (so reload restores, not
   genesis-replays), reopens with a *different* `cfg.params` *and* a `newInstance` built from those
   same different params (a careless caller, not merely an equivalent rewording), and asserts the
   reload reproduces the original seed's own history byte-for-hash while the manifest's own `params`
   (the whole manifest, in fact) is unchanged byte for byte. Not vacuous: an independent genesis run
   under the other seed, replaying the identical script, reaches a provably different hash. Anti-
   vacuity: `Persistence.open`'s load branch rewritten to overwrite the healed manifest's `params`
   with `cfg.params` -> `AssertionError: expected Uint8Array[...511 items] to deeply equal
   Uint8Array[...503 items]` (the manifest-equality assertion, at this test's own line). Reverted,
   green.
4. **`fs_append_allocates_no_buffers` never reached pool exhaustion** (20 tiny appends never fill a
   1 MiB buffer once, let alone force a third concurrent flush). `FsStorageDebug` gained `gate: Promise
   <void>` (every real `fs.write`/`fdatasync` awaits it, read fresh per write, default resolved) and
   `fs.ts` exports `FS_BUFFER_BYTES`. New `fs_pool_exhaustion_forces_a_grown_buffer`: a pending gate
   holds two flushes genuinely in flight while two full 1 MiB appends rotate both pooled buffers, a
   third append forces a grown one (`fsBufferGrows === 1`), then the gate releases and every byte
   (`a + b + c`, exact concatenation) is confirmed on disk in order. The existing steady-state test
   (asserting `0`) is kept unchanged. Anti-vacuity: commenting out the `fsBufferGrows++` in `rotate()`'s
   grown-buffer branch -> `AssertionError: expected +0 to be 1`. Reverted, green.

### Measured (fix round 1)

`pnpm test`: `rust pass 518 tests`, `unit pass 235 tests`, `wasm pass 102 tests`, `browser pass 185
tests`. `pnpm lint`: biome/rustfmt/clippy/tsc all green. No existing golden moved; no existing test
weakened (the two `pause`/`stop`/`fs_append_allocates_no_buffers` tests the review agent flagged are
unchanged, kept alongside their new, stronger siblings).

**Gate (orchestrator).** Cut 1-3 / 4-5, two implementers, one fix round, one review agent. `pnpm gate d17df87`: 3,644 lines, no golden or budget changed, no markers. The gate added `load_after_roll_with_idle_gap_replays_new_segment_tail` to the second half's work (the first half's roll test loaded straight after the roll with no frames in the new segment); it fails with a wrong seed (`expected 11 to be 12`). Two injections that passed without failing are accepted as explained: removing the segment-open reset changes writer and reader together, so no hash can see it (ledger: no byte golden pins a two-segment log), and restoring `runHeavy` into the running instance is hash-indistinguishable (the corrupted-snapshot injection is what proves restore reads the bytes). **The review agent found four gaps**: `pause()`/`stop()` passed with an un-awaited `flush()`; the exports-map test scanned one hop only; `load_ignores_config_params_when_world_exists` had not been built; `fs_append_allocates_no_buffers` never reached pool exhaustion. Fix round 1 closed all four; the orchestrator re-ran the un-awaited-flush injection (`expected true to be false`, fails as it must). Final gate: `rust` 518, `unit` 235, `wasm` 102, `browser` 185 at 32 s of 48 s, lint clean; `heavy_wasm_n1` (slow) `wasm pass 1` per the implementer.
