# M22b: Persistence: load, crash recovery from storage, `node:fs`, heavy mode in the test entry

Status: not started · After: 22 · Tyler-dependent: no

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
- [ ] All tests above pass by name; the crash matrix covers every byte cut of the final frame of the fixture log.
- [ ] `replayWorld` hashes under Node and Bun equal the native golden hashes checked in by M22.
- [ ] `engine/test` exports `replayWorld` and `runHeavy`; production entrypoints do not import them (exports-map test from M02/M35 pattern).
- [ ] `pnpm test` and `pnpm lint` are green.

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
(filled in during Phase 3)
