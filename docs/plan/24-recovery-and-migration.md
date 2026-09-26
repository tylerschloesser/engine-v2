# M24: Panic recovery by re-instantiation (sim role)

Status: not started · After: 23 · Tyler-dependent: no

Split: PLAN row 24 held two subsystems with a reading list over the limit. This brief is panic recovery. `24b-upgrade-and-migration.md` is `SCHEMA_VERSION`, `migrate`, `OldStore`, `SaveIncompatible`, the Tick rescale helper and the upgrade path. The file keeps its original name.

## Goal
A Rust panic or any other trap in the sim instance no longer ends the world: the host catches it, builds a fresh instance from the kept `Module`, reloads snapshot + log tail, signals the epoch seam and resumes with connections open. A panic that recurs in one record's `apply` is fenced off by a logged `Skip` record and acked `EngineFault`; one that recurs in `tick` stops the world with every file intact and a fatal report.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0005-persistence-and-recovery.md` (Panic recovery 1–4; Recovery; Formats: record kinds)
3. `docs/decisions/0014-js-wasm-boundary.md` (§3 `engine.panic`, §4 the call wrapper, §6 Panics)
4. `docs/decisions/0004-action-timing-and-rejection.md` (`Ack`, `EngineReject::EngineFault`, "acks ride on deltas")
Mine from spikes: none. Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Scope
- Loader: M02 already implements 0014 §6 at the instance level (`EngineTrap`, `dead`, `panicMessage`). Here: audit that every sim-host export call goes through `call0/1/2`, and wire the *sim* owner's reaction.
- Rust: a progress cursor the host can read from a dead instance's memory; `Skip` semantics in the replay scan/apply passes (pass structure exists from M22b); queued `EngineFault` ack.
- Host: the recovery state machine of 0005 Panic recovery 2–4, a loop guard, the `onRecovered` seam, a test trap hook.
- Fixture game `panicky`.

## Non-scope
- The epoch itself (manifest field, `Welcome.epoch`), the fresh `Welcome` on live connections, the client's `Resyncing` state and what `onActionResult` reports for pending actions at or below `last_processed_action_seq`: **M28b**, which wires `SimHost.bumpEpoch()` + `resyncAll()` to this brief's `onRecovered`. Until M28b lands, the browser test here asserts host state only.
- Client-role and gen-role owners' reactions to a trap (fresh instance + resync; re-queue requests) and respawning a dead sim *worker* from main (0005 Panic recovery 2, last sentence): **M37**, which reuses `instantiate` with the kept `Module`. `client.onFatal` on the public surface: M37 (this milestone delivers the fatal report through M06b's `shell.fatal` with the tick prefixed).
- Upgrade path, `migrate` (M24b).

## Files, packages and crates touched
- `packages/engine/src/host/recovery.ts`, `packages/engine/src/server.ts` (`SimHost` wiring), `packages/engine/src/worker/sim.ts` (fatal report), `packages/engine/src/test.ts`, `packages/engine/src/abi.ts` (registry)
- `packages/engine/crates/engine/src/{abi/sim.rs,persist/replay.rs,panic.rs}`
- `packages/engine/fixtures/panicky/`

## Seams
**Provides**
- ABI/region: `RegionId` 9 `Progress` (12 B, sim role; read from a *dead* instance through `inst.region(9).u8` / `inst.mem.u32`, which call no export): `ProgressCursor { phase: u32, tick: u32, record: u32 }`, `phase ∈ { Idle, Admit, ApplyRecord, OnPlayer, Tick, BuildFrame, Snapshot, Replay }`, written by Rust before each step; during replay `record` is the byte offset of the record in its segment (the `offset` of 0005's `Skip { segment, offset }`).
- ABI: `sim_log_skip(segment: u32, offset: u32) -> len` (a frame holding one `Skip` record, `tick_delta = 0`, in the `Persist` region); `sim_test_trap()` (panics in phase `Idle`; test-only by convention, reached only through `engine/test`).
- TS host: `SimHost.onRecovered: ((r: { reason: 'panic' | 'upgrade'; tick: number; skipped: number }) => void) | null` (M28b points it at `bumpEpoch()` + `resyncAll()`; M24b fires it with `'upgrade'`), `SimHost.onFatal: ((f: { tick: number; message: string }) => void) | null` (M27 maps it to `HostServices.onFatal?` for servers, 0024 §5; the sim worker maps it to `shell.fatal`), `SimHost.recover(): Promise<'resumed' | 'skipped' | 'fatal'>`.
- `engine/test`: `trapSim(host): void` (calls `sim_test_trap`; this is the "M24 test trap hook" M28b's `harness.panicServer()` uses).
- Fixture `panicky`: actions `PanicInAdmit`, `PanicInApply`, `ArmTickPanic { at: Tick }`, `ArmTickAlloc { at: Tick }` (the tick rule allocates past the arena), `OverflowStackInAdmit` (deterministic panics in each phase; `sim_test_trap` exists for harnesses running other fixtures).

**Consumes**
- M02 loader: `instantiate`, `EngineInstance.{call0,call1,call2,dead,panicMessage,mem,region}`, `EngineTrap`, ABI registry; M06b `shell.fatal`; M13 `SimHost` ("a trap marks the host dead": replaced here); M22 `RecordKind::Skip`, `Persist` region, `Persistence`; M22b `Persistence.loadLatest`, two-pass replay, `MemoryStorage.crashClone`; M16 ack path (`Ack`, `EngineReject`).

## Planning decisions
1. **"Recurs" is decided from the progress cursor, not from the message.** First trap: recover. If recovery's replay traps with `phase = ApplyRecord` at `(segment, offset)`, that record is poisoned: append `sim_log_skip(segment, offset)` to the open segment (always the record's own segment, M22b decision 4), `sync`, restart recovery. If replay or the first live `sim_tick` after recovery traps with `phase = Tick` at the tick that trapped before: wedged → `onFatal`, stop, touch no file. `OnPlayer` and `Replay` (container code) traps on replay are treated like `Tick`. A write-ahead frame that was appended but never applied live is handled by the same rule, because replay reaches it.
2. **Non-deterministic phases never write `Skip`.** A trap in `Admit` recovers and answers that action `Rejected(Engine(EngineFault))` (unlogged, like every admission failure, 0004). A trap in `BuildFrame` or `Snapshot` recovers; the loop guard below catches repetition.
3. **Loop guard:** more than 3 recoveries without 1,200 successfully ticked ticks in between is fatal. The number is a constant in `recovery.ts`, not config.
4. **A skipped record still advances that player's last processed `seq`** and queues `Ack { seq, Rejected(Engine(EngineFault)) }` for the player's first frame after recovery, so replay stays exact and a resend is not applied (0004, 0013). Whether the client still holds that pending action after its resync is M28b's concern.
5. **A failed `memory.grow` and allocation failure** arrive as a panic through the alloc-error path and take the same route (0005 Panic recovery 4); no separate detection.
6. **The panic text** is what M02's `LoaderHooks.onPanic` already decoded; recovery logs it once at `error` level and puts it in `onFatal`. Nothing new is decoded on a steady-state path.

- **From M22b's Deviations.** Replay is **single-pass**: M22b did not build 22b Planning decision 4's `Skip`-target scan pass because the set is always empty until this milestone. Giving `Skip` meaning here means adding that scan pass (collect `Skip` targets in a segment, then apply) to the restore/replay drivers and to `engine/test`'s `replayWorld`/`runHeavy`. `testing::replay`'s `Skip` arm is covered by `replay_skip_records_decode_as_noop` (M22). A loaded or recovered `Sim` has an empty connection table (replay never calls `Host::connect`). `Persistence.loadLatest(storage, keys, manifest, newInstance)` is static (M22b Deviations hold the exact shape).

- **From M23's Deviations.** The sim worker in the browser holds Web Lock `world:<id>` for its whole life and owns OPFS sync access handles (`opfsStorage`); re-instantiation inside the same worker must keep both (never re-take the lock or reopen handles a live adapter holds). Every main-thread park/unpark of the sim worker goes through `hostWorkerLock` (`client.ts`) together with lifecycle pause/resume and world ops, because they share `W_YIELD`/`W_PARKED`; anything this milestone adds that parks the sim worker must take the same lock. `Shell.runAsync` queues FIFO and leaves the loop after the current pass. `CB_FORCE_SNAPSHOT_REQ` used the **last free global control word**: a new control word needs the control block widened. The sim worker's `postMessage` types are enforced by `worker/protocol.test.ts` against `SETUP_PHASE_MESSAGE_TYPES`/`POST_SETUP_MESSAGE_TYPES`: add new types there.

## Order of work
1. Call-path audit (one grep-style test: no `inst.x.` use outside `loader.ts`); `panicky` fixture; `sim_test_trap`.
2. `Progress` region writes in Rust; reading it from a dead instance.
3. `Skip` in scan/apply passes, queued `EngineFault` ack; native tests.
4. `recovery.ts` state machine under Node with memory storage; then the sim worker lifecycle messages and one browser test.

## Tests added
- Vitest (`ts`/`wasm`): `host_never_calls_raw_exports` (source scan), `dead_instance_memory_still_readable`, `trap_without_panic_uses_runtime_error_message` (stack overflow action in `panicky`), `fresh_instance_reuses_module`.
- Rust native: `skip_record_golden_bytes`, `replay_honours_skip_and_advances_seq`, `replay_with_skip_is_deterministic` (two replays, equal hashes), `progress_cursor_written_before_each_phase`.
- Vitest (WASM under Node, `panicky` fixture): `panic_in_admit_recovers_and_rejects_engine_fault`, `panic_in_apply_writes_skip_then_resumes`, `skipped_action_acked_engine_fault`, `recovered_hash_equals_replay_with_skip`, `panic_in_tick_is_fatal_and_files_untouched` (storage byte-equal), `alloc_failure_in_tick_is_fatal_and_files_untouched` (`ArmTickAlloc`: the allocation failure arrives as a panic, `onFatal` fires, storage byte-equal: Planning decision 5), `recovery_fires_onRecovered_once`, `test_trap_recovers_without_skip`, `recovery_loop_guard`, `connections_stay_open_across_recovery` (in-host `Connection` object identity unchanged, next frame arrives).
- Browser: `sim_worker_recovers_from_panic` (single-player page: sim hash via `engine/test` after recovery equals the Node result for the same script; `memGrows() === 0` on the new instance).

## Exit criteria
- [ ] All tests above pass by name.
- [ ] Import allowlist test still passes for `panicky` (no new imports); M02's ABI registry test includes `sim_log_skip`, `sim_test_trap` and `RegionId` 9 `Progress`.
- [ ] Panic recovery stays out of the zero-GC window by construction (0016 §2 exempt list): no test asserts allocation here, and `zero_gc_singleplayer*` is still green.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test wasm -t trap` · `pnpm test rust -t skip` · `pnpm test wasm -t panic_in_` · `pnpm test browser -t sim_worker_recovers` · `pnpm test` · `pnpm lint`

## Budgets
- Latency row (0005 loss windows): `panic_in_apply_writes_skip_then_resumes` asserts zero admitted actions lost other than the skipped one.
- Allocation per isolate: unchanged (recovery is an exempt discontinuity, 0016 §2).

## Context artifacts
Add to `packages/engine/src/host/CLAUDE.md` (create if absent, ≤ 15 lines): every export call goes through `call0/1/2`; a dead instance is only ever *read* (`mem`, `region`); recovery constants live in `recovery.ts`.

## Manual device checks
none

## Deviations
(filled in during Phase 3)

ADR note: 0009 `HostServices` had no member through which a *server* host learns of `onFatal` (0005 Panic recovery 4). 0024 §5 adds `HostServices.onFatal?`; this brief exposes `SimHost.onFatal` and M27 maps it.
