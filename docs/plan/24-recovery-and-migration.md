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
- ABI/region: `RegionId` 11 `Progress` (9 was taken by `GenIn`; Deviations) (12 B, sim role; read from a *dead* instance through `inst.region(11).u8` / `inst.mem.u32`, which call no export): `ProgressCursor { phase: u32, tick: u32, record: u32 }`, `phase ∈ { Idle, Admit, ApplyRecord, OnPlayer, Tick, BuildFrame, Snapshot, Replay }`, written by Rust before each step; during replay `record` is the byte offset of the record in its segment (the `offset` of 0005's `Skip { segment, offset }`).
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
- [ ] Import allowlist test still passes for `panicky` (no new imports); M02's ABI registry test includes `sim_log_skip`, `sim_test_trap` and `RegionId` 11 `Progress`.
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

**Scope actually landed: steps 1-3 only**, per the delegation prompt. Base `f41a1a2`. Step 4
(`recovery.ts`, sim worker wiring, browser test) is a second implementer's.

### RegionId conflict: `Progress` is 9, not 11

The brief's Seams said `RegionId` 9 for `Progress`, but `GenIn` already holds `9` (declared by
M08b, before this brief was written) and `RegionId` numbers are append-only, never reused
(`registry.rs`'s own rule; `REGION_COUNT` was already 11, ids 0-10 all taken). **Landed:
`RegionId::Progress = 11`** (`REGION_COUNT` 11 -> 12), in both `registry.rs` and `abi.ts`. Flagged
here rather than silently changing a stated seam number.

### Architectural finding: a genuine two-pass scan is unavoidable, and needed its own ABI pass

`Skip { segment, offset }`'s own target typically lives in an *earlier* frame than the `Skip`
record itself (0005 step 3: the host discovers the poisoned record, then *appends* a new `Skip`
frame naming it -- the original frame is untouched). Honouring it therefore requires seeing every
frame in a segment before applying any of them (a true two-pass scan, not a per-frame decision).

First attempt: fold the scan into `sim_replay_push` itself (buffer every decoded frame, defer all
application to `sim_replay_end`). This works in isolation but **broke `engine/test`'s
`replayWorld`/`runHeavy`** (`replay_world_checkpoints_node`, `heavy_wasm_n50`,
`replay_world_checkpoints_two_segment_real_pipeline`, `replay_world_detects_a_segment_boundary_
hash_mismatch`, the Bun leg -- caught immediately, `pnpm test wasm` red): `driveCell`
(`src/test/replay.ts`) drives `sim_replay_begin`/`push` **tick-by-tick**, interjecting between
calls (`runHeavy`'s own restore-mid-drive), and depends on each pushed frame being *applied
immediately*, not buffered. A buffer-everything-then-apply `sim_replay_end` cannot support that
without changing `replayWorld`/`runHeavy`'s own driving loop into multiple `begin`/`push`/`end`
rounds per segment -- and a *per-round* scan would miss a `Skip` target in a later round.

**Landed instead: a separate scan pass, its own three exports, run once over the whole segment
tail *before* the pre-existing `sim_replay_begin`/`push`/`end` (which keep their exact original
per-frame-immediate-apply contract, now consulting `self.replay_skip_targets`):**
- `sim_replay_scan_begin(segment) -> status`, `sim_replay_scan_push(len) -> status`,
  `sim_replay_scan_end() -> status` -- same in-region-as-receive-buffer shape as
  `sim_replay_push`; decodes with its own `FrameReader` (`Host::scan_reader`), collects every
  `Skip{segment,offset}` whose `segment` matches into `Host::replay_skip_targets`
  (`BTreeSet<u32>`), touches `self.sim` not at all. `sim_replay_begin` no longer resets
  `replay_skip_targets` (only `sim_replay_scan_begin` does).
- Callers (`Persistence.loadLatest`, `test/replay.ts`'s `scanSkipTargets`, one call per segment
  per instance) feed the **same** segment-tail bytes to the scan pass first, then proceed exactly
  as before. `packages/engine/src/host/persistence.ts` and `packages/engine/src/test/replay.ts`
  were touched for this (outside the brief's own Files list, unavoidable: the ABI's replay
  contract changed shape). `ABI_VERSION` 17 -> 18 covers all of this milestone's additions in one
  bump.
- **Known gap, not fixed here**: `runHeavy`'s own `restoreFresh` mid-drive swap builds a brand
  new instance via `sim_restore_*` that never goes through the scan pass, so `replay_skip_targets`
  is empty on it. No existing `runHeavy` test combines a mid-drive restore with a `Skip` record
  (heavy mode doesn't test recovery), so this is latent, not exercised -- flagged for whoever
  first needs both together.
- Per-record filtering needs each record's own byte offset, not just the frame's: `persist::
  frame::DecodedFrame` gained `frame_offset: u64` and `record_offsets: Vec<u64>` (both relative to
  the `FrameReader`'s own first-ever byte, the same basis `sim_replay_valid_end` already uses for
  `replay_base_offset`); `FrameReader` gained a private running `total_consumed: u64`;
  `bytes::ByteReader` gained `pos()`.
- **A `Skip`-only frame is written with `tick_delta = 0`** (`Host::sim_log_skip`, reusing
  `persist::FrameWriter` directly -- it carries no game-typed payload, so it doesn't need
  `sim_seal_frame`'s own hand-rolled encoding, which exists only to avoid a `G::Action: Clone`
  bound). `sim_replay_push`'s apply pass treats `tick_delta == 0` as "administrative, never a real
  elapsed tick": it is decoded (so its own record reaches the scan pass) but never stepped, and
  `self.last_logged_tick` is left untouched -- proven by
  `replay_of_a_segment_whose_last_frame_is_skip_then_more_live_frames`
  (`fixtures/panicky/tests/skip_replay.rs`), which appends a `Skip` frame as the *last* frame of a
  segment, then continues logging and ticking for real past it, and checks both the resulting hash
  and the exact tick count (3, not 4) against a from-scratch replay of the whole thing.

### Seam for step 4 (as requested, verbatim)

- **`Phase` numbering** (`persist::progress::Phase`, `u32`): `Idle=0, Admit=1, ApplyRecord=2,
  OnPlayer=3, Tick=4, BuildFrame=5, Snapshot=6, Replay=7`. `ProgressCursor { phase, tick, record }`
  is 12 raw LE bytes at `RegionId::Progress` offset 0 (`phase u32 | tick u32 | record u32`).
- **When each is written**: `Host::mark_progress(phase, tick, record)` runs immediately *before*
  the risky call it names, and every export that succeeds ends by calling `Host::mark_idle(tick)`
  (writes `Phase::Idle`) -- so `sim_test_trap` (which writes nothing of its own before panicking)
  is seen to have trapped in `Phase::Idle`, whatever the *previous* successful call left behind.
  `Admit`: in `Host::on_uplink`, right before each carried action's own `G::admit` call (`record` =
  that action's `seq`). `ApplyRecord`/`OnPlayer`/`Tick`: inside `Sim::step_with_progress` (new; the
  hook `Sim::step` itself never used, since `sim/` has no region to write into -- only `Host`
  does, via a small free function `progress_writer` the tick/replay paths pass a closure built
  from), called once per record before `G::apply`/`G::on_player`, and once more, `(Phase::Tick,
  0)`, right before `G::tick`. `BuildFrame`: in `sim_build_frame`, before `Host::build_frame`
  (`record` = `conn`). `Snapshot`: in *both* `sim_snapshot_begin` (before `SnapshotWriter::begin`,
  which does the real encoding work eagerly, M22's own Deviations) and `sim_snapshot_next` (before
  `writer.next`). `Replay`: in `sim_replay_begin` (before creating the reader) and in
  `sim_replay_push` (before each decode-and-apply pass over a pushed block) -- **not** written by
  the scan pass (`sim_replay_scan_*`), which never calls game code and can't meaningfully trap.
- **`ApplyRecord`'s `record` field**: while ticking live, the **0-based index** of the record
  within whatever slice `Sim::step_with_progress` was called with (`Host::tick`'s own
  `pending_records`) -- meaningless for `Skip` targeting, since a live trap always triggers a
  plain "recover and replay the tail" first, and only a *second*, replay-time trap at the same
  spot decides a `Skip` (Planning decisions 1). During replay (`sim_replay_push`'s own apply
  pass), it is the record's **absolute byte offset within the segment**
  (`replay_base_offset + DecodedFrame::record_offsets[i]`, truncated to `u32`) -- exactly what
  `sim_log_skip(segment, offset)` expects as `offset`. The hook closure in `sim_replay_push`
  remaps `(Phase, index)` to `(Phase, filtered_offsets[index])` for this reason; a live tick's own
  hook passes the index straight through.
- **`sim_log_skip`'s output**: writes into `RegionId::Persist` (same region `sim_seal_frame` uses),
  returns the byte length or `-(status)` (same shape as `sim_seal_frame`/`sim_segment_header`).
  The caller (TS) is responsible for `storage.append`-ing those bytes to the **currently open**
  segment (Planning decisions 1: "always the record's own segment") and re-running recovery.
  Needs no live `Sim` (`self.sim.is_none()` is fine) -- call it on whatever fresh instance is at
  hand, including one about to be discarded.
- **The `EngineFault` ack**: queued in a new `Host::pending_fault_acks: Vec<(PlayerId, u32)>`,
  pushed by `sim_replay_push`'s apply pass for every record whose byte offset is a skip target
  (only `FrameRecord::Action` records reach this -- `record_ack(who, seq)` first, which is what
  advances `last_seq`, *then* the push). **Delivered by `Host::connect`**: on every (re)connect it
  now drains every `pending_fault_acks` entry for that `PlayerId` into the fresh `ConnSlot`'s own
  `pending_results` as `Outcome { seq, result: Err(Rejected::Engine(EngineReject::EngineFault)) }`
  -- so it rides out on that connection's own next `sim_build_frame` call, satisfying "the
  player's first frame after recovery" *as long as step 4's recovery flow calls `sim_connect`
  again for every still-open connection right after a successful recovery* (replay never calls
  `Host::connect` itself, M22b Deviations: a recovered/loaded `Sim` starts with an empty
  connection table).
- **A skipped record still advances `last_seq`**: via `Authority::record_ack(who, seq)`, called
  directly (never through `apply`/`on_player`) for the skipped record before it's dropped from the
  filtered slice handed to `Sim::step_with_progress`. This is real sim state (`Store::last_seq`),
  so it round-trips through the hash and through `on_uplink`'s own pre-existing dedup floor
  (`store.last_seq(player)`) with no changes needed there at all -- proven directly:
  `replay_honours_skip_and_advances_seq` reconnects after replay and resends the skipped `seq`
  with a real (additive) action, and confirms it is silently dropped.
- **`panicky`'s phases**: `PanicInAdmit` and `OverflowStackInAdmit` both panic in `Phase::Admit`
  (never reach `apply` in a real run: `admit` traps first). `PanicInApply` panics in
  `Phase::ApplyRecord`, admitted and logged cleanly first. `ArmTickPanic{at}`/`ArmTickAlloc{at}`
  are admitted and applied cleanly (they only arm a `Global` flag); the panic (or, for
  `ArmTickAlloc`, the over-budget allocation -- see below) happens in `Phase::Tick`, once
  `Sim`'s tick counter reaches `at`. **`cx.tick()` inside `Game::tick` is always one behind the
  post-call counter** (`Sim::step`'s own `advance_tick()` runs last): arming `at: N` and reaching
  it takes `N + 1` total `sim_tick()` calls from genesis.
- **`OverflowStackInAdmit`'s real implementation is the raw `unreachable` WASM instruction**
  (`core::arch::wasm32::unreachable()`, `fx_panicky::trap_no_panic`), **not genuine stack
  overflow via unbounded recursion.** A first version used real non-tail recursion; under
  Vitest/Node it reliably crashed the whole worker process with `SIGABRT`
  ("`FATAL ERROR: Reached heap limit ... JavaScript heap out of memory`") rather than raising a
  catchable `WebAssembly.RuntimeError` -- an uncatchable process crash, useless as a test fixture.
  `unreachable` is 0014 §6's *other* named example of "a trap with no preceding `engine.panic`
  call" and produces the exact same observable property (`EngineTrap` whose `panicMessage` is the
  raw `RuntimeError`'s text, e.g. `"unreachable"`) with none of the risk. `ArmTickAlloc`
  over-allocates 512 MiB (`Vec::with_capacity`) rather than calling `panic!`: `abi::arena::Arena`'s
  own debug-build check (`grow_live`) reports that as a panic through `panic::fatal` *before* the
  real allocation runs, once a real `arenaBytes` budget is reserved (`engine_init`) -- inert
  natively (`RESERVED` stays 0 outside `engine_init`, so this milestone's own native tests never
  trigger it; step 4's own WASM test is where it first becomes a real trap).
- **`Global::apply_count: u32`** was added to `fx_panicky` beyond the brief's own action list: an
  "additive action" field (bumped once per successful, non-panicking `apply`) needed to prove a
  `Skip`-fenced or resent record was never (re-)applied -- neither `armed_tick_panic`/
  `armed_tick_alloc` (both `Option<u32>`, idempotent when set twice) could show a double-apply on
  their own.

### A second, unrelated infrastructure finding: `expect(engineInstance).not.toBe(...)` can OOM the Vitest worker

While writing `panicky-trap.test.ts`, `expect(a).not.toBe(b)` on two real `EngineInstance` values
(never on a *failing* assertion -- this one always passed) reliably crashed the whole `wasm`
Vitest worker (`SIGABRT`, heap trace showing `Reached heap limit ... JavaScript heap out of
memory`, `V8` mid `Object.entries`/pretty-print machinery). Root-caused by bisection (removing
every other difference from a passing minimal repro) to that one matcher call on that one value
shape: an `EngineInstance` holds `mem` (live `Uint8Array`/`Uint32Array` views over the WASM linear
memory) and `x` (every raw export function) -- Vitest's `toBe`/`not.toBe` appears to eagerly
pretty-print both operands regardless of outcome, and doing that for a WASM-memory-backed object
is pathological. **Fix: never hand an `EngineInstance` to `expect()`** -- every comparison in
`panicky-trap.test.ts` uses a plain `===`/property read instead (`expect(a === b).toBe(false)`,
`expect(a.dead).toBe(true)`, etc.), documented at the top of that file. Not otherwise reported or
investigated further (no time budget for a Vitest issue report); flagged here so no later
milestone's own WASM test rediscovers it the hard way.

### Anti-vacuity (inject/fail/revert; fail lines pasted verbatim)

- `call_path` test: injected `inst.x.sim_hash()` (a direct call) into `server.ts` ->
  `Error: raw export call(s) bypassing call0/call1/call2: server.ts:184: const status =
  inst.x.sim_hash()`. Reverted, `git diff` clean.
- `progress_cursor_written_before_each_phase`: removed the `Admit`-phase `mark_progress` call ->
  `Admit phase never written before the panic: []`. Removed *both* `Snapshot`-phase calls
  (`sim_snapshot_begin`'s alone was vacuous -- `sim_snapshot_next`'s own call still covered it) ->
  `Snapshot phase never written: [ProgressCursor { phase: Idle, ... }, ...]`. Removed the
  `Phase::Tick` hook call in `Sim::step_with_progress` -> `Tick phase never written before the
  panic: [ProgressCursor { phase: OnPlayer, ... }, ProgressCursor { phase: OnPlayer, ... },
  ProgressCursor { phase: ApplyRecord, ... }]`. All three reverted, green. (`Admit`, `ApplyRecord`
  and `Tick` are also independently proven by three real panics inside the same test, per phase;
  `BuildFrame`/`Replay` were not separately injection-tested, for lack of time -- flagged, not a
  gap in the writes themselves, which mirror the tested ones exactly.)
- `replay_honours_skip_and_advances_seq`: disabled the skip-target check
  (`if false && self.replay_skip_targets.contains(...)`) -> `assertion left == right failed: the
  skipped record must never reach apply\n  left: 1\n right: 0`. Reverted, green.
- `replay_with_skip_is_deterministic`: same injection -> `assertion left != right failed: a
  Skip-bearing replay must diverge from the Skip-free one -- otherwise the Skip proved nothing\n
  left: 9800360619973041494\n right: 9800360619973041494`. Reverted, green.
- `replay_of_a_segment_whose_last_frame_is_skip_then_more_live_frames`: disabled the
  `tick_delta == 0` administrative-frame guard -> `assertion left == right failed: the Skip-only
  frame must not itself advance the tick counter\n  left: 4\n right: 3`. Reverted, green.
- `skip_record_golden_bytes`: not independently injection-tested (a golden fails on any byte drift
  by construction, same reasoning M22/M22b gave for their own golden tests).

### Measured

`pnpm test`: `rust pass 528 tests` (520 native workspace + 8 `fx-panicky`), `unit pass 251 tests`,
`wasm pass 111 tests`, `browser` unchanged from base (no browser file touched). `pnpm lint`:
biome/rustfmt/clippy/tsc all green. No existing golden moved (`persist_frame_golden_bytes`,
`persist_snapshot_golden_bytes`, `persist_abi_log_parity.hex`, `puts_*`, `machines_*` all
untouched); `skip_record_golden_bytes` is new, blessed once (`100001020005000000d2040000381e1a7d`
-- a 17-byte frame: `len=16 | tick_delta=0 | count=1 | kind=Skip(2) | player_slot=0 | segment=5 |
offset=1234 | crc32`).

### Context artifacts

- `packages/engine/src/host/CLAUDE.md`: one new bullet (panic recovery: call-path rule, dead-read
  rule, recovery constants live in `recovery.ts`), kept at exactly the 60-line cap.
- `packages/engine/crates/engine/src/persist/CLAUDE.md`: replaced the stale "replay is
  single-pass" line with the real two-pass design and where each driver lives (31 lines, well
  under the cap).
- `packages/engine/crates/engine/CLAUDE.md`: patched the `ABI_VERSION`/export-list line (17 -> 18,
  names this milestone's six new exports and `RegionId::Progress`), same drift class M22/M22b
  already found and fixed for their own halves.

### Notes for the second implementer (step 4)

- `SimHost.recover(): Promise<'resumed' | 'skipped' | 'fatal'>`, `SimHost.onRecovered`/`onFatal`,
  the loop guard, and `recovery.ts` itself are all still to build -- nothing here wires a `Storage`
  failure or a real trap into any of that.
- After a successful recovery/replay, call `sim_connect` again for every still-open connection
  *before* the first real `sim_tick()`/`sim_build_frame()` -- this is what makes the queued
  `EngineFault` ack (already implemented, see above) actually reach the client, and what M22b's
  own Deviations already flagged as owed to M27/M28's "session resume after a load".
- `runHeavy`'s mid-drive `restoreFresh` not re-running the scan pass (above) is latent; only
  matters once something tests heavy mode against a `Skip`-bearing log, which nothing does yet.
- `engine/test.trapSim(inst: EngineInstance): void` takes the raw instance, not `SimHost` --
  `server.ts`'s own `SimInstance` seam is deliberately narrow (`wrapEngineInstance`'s doc comment),
  and widening it would ripple into every hand-written fake `SimInstance` in this repo's existing
  tests. Wire it into whatever `SimHost`-level call `M28b`'s `harness.panicServer()` needs.

### Step 4 (second implementer): `recovery.ts`, `SimHost` wiring, the sim worker, the browser test

**Seams landed, exactly:**
- `packages/engine/src/host/recovery.ts` (new): `Phase` (mirrors `persist::progress::Phase`),
  `readProgressCursor(inst): ProgressCursor | null` (no export call), `RecoveryDeps { instance:
  EngineInstance; newInstance: () => EngineInstance }`, `RECOVERY_LOOP_LIMIT = 3`,
  `RECOVERY_GOOD_TICKS_RESET = 1200`, `runPanicRecovery(persistence, newInstance):
  Promise<RecoveryOutcome>` (`{ kind: 'ok', sim, tick, skipped } | { kind: 'fatal', tick, message }`)
  -- the whole Planning-decisions-1 retry loop for *one* live-trap event: builds a fresh instance via
  `persistence.recover`, and on a repeat `EngineTrap` reads the *dead replaying instance's* own
  `Progress` cursor; `Phase.ApplyRecord` writes a `Skip` (`Persistence.appendSkip`, on a *third*,
  throwaway instance -- the dead one can never be called again) and retries; anything else is
  `'fatal'`. A defensive `MAX_SKIP_ITERATIONS = 10_000` backstop, never expected to bind (each
  `appendSkip` makes forward progress, proven never to bind by the anti-vacuity run below).
- `packages/engine/src/host/persistence.ts`: `loadLatest` gained a 5th, optional parameter
  `onReplaySegment?: (segment: number) => void`, called once, right before `sim_replay_begin` --
  `recovery.ts`'s only way to learn which segment a replay-time trap happened in (`ProgressCursor.
  record` is the byte *offset* within it, never the segment). New instance methods: `recover
  (newInstance, onReplaySegment?)` (wraps `loadLatest` over this live `Persistence`'s own storage/
  keys/manifest, then rebinds `segment`/`logOffset`/`tick` *and* `this.sim` -- see the bug below) and
  `appendSkip(segment, offset, sim)` (`sim_log_skip` + `storage.append` + `storage.sync`, Planning
  decisions 1's own three verbs). Both outside the brief's own Files list (unavoidable, same class as
  steps 1-3's own `persistence.ts` touch).
- `SimHost.recover(): Promise<'resumed' | 'skipped' | 'fatal'>` (no arguments, matching Seams
  exactly -- `'upgrade'` reason support is a `reason: 'panic'` literal baked in for now, M24b's own
  job to widen), `SimHost.onRecovered`/`onFatal` (plain mutable properties, `logSink`'s own
  convention). `createSimHostFromInstance` gained a 5th, optional `recoveryDeps?: RecoveryDeps`
  parameter (every 2-4-argument caller unaffected). `SimInstance.simReattach(conn): number` (wired
  in `wrapEngineInstance`), used only by `recover()`'s own re-attach loop.
- `worker/sim.ts`: `recoveryDeps: RecoveryDeps = { instance: inst, newInstance }` built once, passed
  to `createSimHostFromInstance`; every later reference to the raw instance (the `testCall`
  fallback) reads `recoveryDeps.instance`, never the old `inst` binding, so it survives a recovery.
  `simHost.onFatal` maps to `shell.fatal(\`sim fatal at tick ${f.tick}: ${f.message}\`)`. `body()`'s
  entire content is now wrapped in one `try`/`catch`: a caught `EngineTrap` still stores the same two
  words the happy path ends with (`CB_SIM_TICKS_RUN`, this wake's own `W_ACK`) -- **load-bearing**,
  not cosmetic: without it, `engine/test`'s `stepSimTickSync` (and thus `stepTick`) spins on a
  `W_ACK` that a caught-and-recovered wake would otherwise never write, until it hits its own
  `SPIN_LIMIT` and throws (found live, `sim-panicky.ts`'s own driver hit this before the fix) -- then
  `shell.runAsync(() => simHost.recover())`, the sanctioned "leave the loop, await, re-enter" path.
  No new SAB control word, no new `postMessage` type (Traps' own constraints): everything here is
  existing plumbing (`EngineTrap`, `shell.runAsync`, the two ack words).
- `tests/browser/support/page.ts`: `openPage` gained a 3rd, optional `opts: { allowConsoleError?:
  (text: string) => boolean }` parameter (every existing 2-argument call site unaffected). Needed
  because the loader's own default `onPanic` hook is `console.error` (`loader.ts`), and
  `instantiateFactoryForSetup` (the sim worker's real instantiation path) installs no custom hooks
  -- a deliberate in-browser trap is therefore an *expected* console error, and `openPage`'s own
  "fail on any console error" rule needed one narrow, predicate-gated exception to stay strict for
  everything else.

**A real bug found, not merely an anti-vacuity injection: `sim_reattach` was never forwarded through
`GameInstance<G>`.** `Instance`'s own default (`Status::Unsupported`) silently answered every call
for the `fx-panicky` fixture (a `GameInstance<Panicky>`, not a bare `Host<Panicky>`) until this was
found live by `connections_stay_open_across_recovery`: `sim_reattach` returned `8` (`Unsupported`),
never touching `Host::reattach` at all, so `build_frame` for the re-attached `conn` still saw *no*
slot and returned `0`. Fixed in `game_instance.rs`, next to `sim_connect`'s own forward (the same
one-line shape every other sim export there already has) -- `sim_log_skip`/`sim_test_trap`/
`sim_replay_scan_*` from steps 1-3 were already forwarded correctly; this was the one export step 4
itself added and initially missed. Diagnosed by a throwaway native test (`Host::reattach` +
`build_frame` alone, no ABI, `n2 = 22` -- correct) that isolated the bug to the `GameInstance`
dispatch layer, not `Host::reattach` itself; not left in the tree.

**A second real bug, found while writing the orchestrator-flagged heavy-mode test, in code that
predates this milestone:** `engine/test`'s `driveCell` (`src/test/replay.ts`) called `sim_replay_
begin(0, 0)` unconditionally, on every (re)arm -- harmless before this milestone (nothing ever
computed an *absolute* byte offset), but once `Skip` targeting matches against `replay_base_offset +
DecodedFrame::record_offsets[i]`, a hardcoded `offset = 0` makes every apply-time offset wrong by
exactly the segment's own header/base length, so a `Skip`'s own target is never matched --
`PanicInApply`'s poisoned record was genuinely *applied* here, panicking for real, inside
`replayWorld`/`runHeavy`. Fixed by threading the real `segmentIndex` into `driveCell` (a new,
required parameter, both call sites updated) and re-arming with the *true* absolute offset: `
startOffset` for the initial arm, a frame's own `f.start` after a mid-drive instance swap. Both
`replayWorld` and `runHeavy` were affected; the fix is one function.

**The orchestrator-flagged gap itself (`runHeavy`'s `restoreFresh` never re-running the scan pass):
fixed** by calling `scanSkipTargets(cell.sim, seg.index, logBytes, offset)` immediately after
`cell.sim = restoreFresh(bytes)`, inside `runHeavy`'s own `onTick` callback -- cheap (scan never
applies) and correct regardless of how far the drive has progressed. **Native `testing::heavy`/
`replay` (`crates/engine/src/testing/replay.rs`) do *not* have the same gap**: `to_record`'s own
`FrameRecord::Skip { .. } => None` arm (M22, "this milestone's own Non-scope") means neither run ever
implements target-skipping at all, not even in the always-uninterrupted case -- both `sim_a`/`sim_b`
in `heavy` treat every `Skip` identically (a no-op frame), so their own A-vs-B divergence check stays
meaningful without it. Left untouched: implementing real target-skipping there is new behaviour, not
a regression, and squarely out of scope here.

**Decision needed, not made here: `panic_in_admit_recovers_and_rejects_engine_fault`'s own "rejects
Engine(EngineFault)" half.** Planning decisions 2 states the outcome ("recovers and answers that
action `Rejected(Engine(EngineFault))`"), but the mechanism Planning decisions 4 gives the
`ApplyRecord` case (`pending_fault_acks`, populated during *replay*) cannot apply here: an
`Admit`-phase trap is *never logged* (0004: an admission rejection is not a record at all), so no
replay ever revisits it, and the panicking `G::admit` call itself never returns -- there is no
surviving (`who`, `seq`) pair once the instance is dead, and `ProgressCursor` (12 B: `phase`, `tick`,
`record = seq`) carries no `conn`/`who` to attach it to even if there were. This milestone's own test
(`panicky-recovery.test.ts`) instead proves what the existing seams *do* support: the trap recovers
cleanly (`'resumed'`, no `Skip`), storage is untouched by the doomed attempt, and the connection is
fully usable again immediately after (a distinct, real action from the same player admits and
applies normally). Delivering the actual `EngineFault` ack for the *original* seq would need either
a new `Progress`-adjacent field naming the connection, or a JS-side "admit in flight" marker read
back from the dead instance -- both new seams, not build-outs of an existing one. Flagged for the
orchestrator rather than guessed at.

**Anti-vacuity (inject/fail/revert; fail lines pasted verbatim), the five the orchestrator named:**
- No `Skip` written (commented out `persistence.appendSkip`'s own call, `MAX_SKIP_ITERATIONS`
  lowered to 5 for the run): `panic_in_apply_writes_skip_then_resumes` -> `AssertionError: expected
  'fatal' to be 'skipped'`; the same failure hit `skipped_action_acked_engine_fault`,
  `recovered_hash_equals_replay_with_skip`, `recovery_fires_onRecovered_once`,
  `connections_stay_open_across_recovery` and `heavy_mode_restore_mid_skip_matches_uninterrupted_
  replay` too (six tests, one injection). Reverted, green.
- Fatal branch writing a file (`persistence.snapshotNow()` inserted right before the `onFatal` call
  in `SimHost.recover()`): `panic_in_tick_is_fatal_and_files_untouched` and `alloc_failure_in_tick_
  is_fatal_and_files_untouched` -> `EngineTrap: ... trapped` (the dead instance `snapshotNow` tried
  to call on; either outcome -- a thrown trap or a bytes-changed assertion -- is the test catching a
  file touched from the fatal path). Reverted, green.
- `onRecovered` firing twice (the same call duplicated in `SimHost.recover()`):
  `recovery_fires_onRecovered_once` -> `AssertionError: expected 2 to be 1`; `test_trap_recovers_
  without_skip` (which also counts calls) failed identically. Reverted, green.
- Guard counter never reset (commented out `if (goodTicksSinceRecovery >= RECOVERY_GOOD_TICKS_RESET)
  recoveryCount = 0`): `recovery_loop_guard` -> `AssertionError: expected 'fatal' to be 'resumed'`
  (the "1,200 good ticks resets it" half). Reverted, green.
- Re-attach skipped (`if (conns[conn] && false) sim.simReattach(conn)`): `connections_stay_open_
  across_recovery` -> `AssertionError: expected 1 to be greater than 1` (no second frame ever sent);
  `skipped_action_acked_engine_fault` failed too (`expected X not to be X` -- with no `ConnSlot`, the
  "new seq should apply" resend is silently dropped, not silently applied, the opposite direction
  from what that assertion checks for). Reverted, green.

**A real race found and fixed in the browser test itself, not production code:** the first version
captured `ticksBeforeTrap` via a separate `page.evaluate(() => window.__simTicksRun?.())` call
*before* invoking `__trapSim`. Real-time pacing keeps advancing that counter during the round trip
to `__trapSim` itself, so the later `toBeGreaterThan(ticksBeforeTrap)` poll could pass on ordinary
pre-trap ticking alone, before the trap (or its recovery) had even happened -- caught live
(`page.evaluate: Error: ... trapped: sim_test_trap ...` from the *next* call, `__worldHashAndTick`,
racing an as-yet-unrecovered instance). Fixed by having `__trapSim` itself return the tick count
read *while parked*, immediately before triggering the trap (pacing cannot advance it further until
genuinely resumed) -- a caller polling `__simTicksRun() > (that value)` is then only ever satisfied
by a tick that ran on the fresh, recovered instance. 5/5 clean via `npx playwright test
sim-panicky.spec.ts --project=chromium` after the fix, isolated from the rest of the suite's own
unrelated environmental flakiness (a `browserContext`/CDP flake class already present before this
milestone, hit twice more across the repeat runs below, in `gc-loop` and `puts-ui` specs neither of
which this milestone touches).

**Measured:**
- `pnpm test`: `rust pass 528`, `unit pass 251`, `wasm pass 122`, `browser pass 200` (199 -> 200: one
  new spec). `pnpm lint`: biome/rustfmt/clippy/tsc all green.
- `sim_worker_recovers_from_panic` (Playwright, `chromium` only): ~2.0-2.1 s isolated (721 ms inside
  the full suite's own warm run), under the 3 s budget either way. `node scripts/repeat.mjs browser
  5`: `pass=5 fail=0 hang=0`; a second, manual `pnpm test browser` x5 also 5/5 on this spec (two
  unrelated specs each flaked once, see above).
- `pnpm gc -t singleplayer`: `zero_gc_singleplayer_with_snapshot` still green (1 passed) -- recovery
  adds no allocation assertion of its own and widens no budget.
- `ABI_VERSION` 18 -> 19 (`sim_reattach`, the only new export this step adds).

**Context artifacts:** `packages/engine/src/host/CLAUDE.md`'s existing "Panic recovery" bullet
(steps 1-3's own placeholder) rewritten with the real shapes, trimmed to keep the file at the 60-line
cap (`context-artifacts.test.mjs`); `packages/engine/crates/engine/CLAUDE.md`'s `ABI_VERSION` line
updated (18 -> 19, `sim_reattach` named, `GameInstance<G>` forwarding called out).

### M24 fix round 1

**1. Admit-phase `Rejected(Engine(EngineFault))` (Planning decisions 2), built.** New export
`sim_fault_ack(conn, seq) -> status` (`ABI_VERSION` 19 -> 20; `host::Host::fault_ack`, forwarded
through `GameInstance<G>` -- checked this time, see the anti-vacuity line below). `Host::fault_ack`
pushes `Outcome { seq, Err(Rejected::Engine(EngineReject::EngineFault)) }` straight onto `conn`'s own
(already-reattached) `ConnSlot::pending_results` and raises `ConnSlot::highest_admitted_seq` to at
least `seq`, so a resend of that exact `seq` is dropped at the `on_uplink` dedup floor rather than
re-admitted (and, for a deterministically-panicking action, re-trapped). Unlike the `ApplyRecord`
case (`pending_fault_acks`, drained by `connect`/`reattach` because replay has no live `ConnSlot` to
push into yet), an `Admit`-phase trap is discovered by the *live* caller *after* `reattach` has
already run, so this writes straight into the slot instead.

`server.ts`'s `SimHost` tracks `inFlightAdmitConn: number | null`, set immediately before and cleared
immediately after each `sim.simAdmit()` call inside `accept()`'s own `connection.onMessage` --
the one place that knows *which connection* an admit was for (`ProgressCursor.record` is the `seq`,
already correct since steps 1-3; the cursor never carried `conn`, exactly the gap the orchestrator's
ruling asked me to close on the TS side instead of widening the region). `recover()` reads (and
unconditionally clears) both this and the *original* dead instance's own `Progress` cursor before
`recoveryDeps.instance` is ever reassigned to the fresh instance -- the only point either is still
readable -- and, only when `phase === Admit`, calls `sim_fault_ack` once re-attach has finished.

**Loss window check (the orchestrator's own question):** actions admitted earlier in the same
`on_uplink` batch, or from an earlier batch in the same tick window, before the trap -- are they
lost? Yes: `Host::on_uplink` pushes each successfully-admitted action into `self.pending_records`
(in-memory only) and `sim_seal_frame` (which turns it into logged bytes) runs once per tick, at the
*start* of `SimHost.runOneTick`, not per `on_uplink` call -- so anything admitted since the last
`sim_seal_frame` dies with the instance, unlogged. This is exactly 0005's own stated loss window
("Tab close, worker or renderer crash, WASM panic | Admitted actions lost: 0 (at most the one
in-flight frame)") -- not a new gap, and not something this milestone builds resend for (0004/0013's
own reconnect-resend contract already covers "the client resends whatever it never got acked for
after a resync"; wiring that resync is M28b's, Non-scope here per the brief itself).

**Tests:** `panic_in_admit_recovers_and_rejects_engine_fault` now decodes the real downlink frame
(`decodeActionResults`: a fresh client-role instance's own `on_frame`/`client_poll_ui`, the same wire
path `client.ts`'s `pollActionResults` uses, not a hand-rolled JSON assertion) and asserts `{ seq: 1,
result: { Rejected: { Engine: 'EngineFault' } } }` is present -- confirmed against a real fork's own
read of `client.ts`'s `ActionOutcome` type, since no existing test decoded this shape before. New
`admit_fault_ack_resend_is_dropped_not_retrapped`: resends the same `PanicInAdmit` `seq` after
recovery and asserts no second trap and `onRecovered` never fires again. Both now go through
`admitViaConnection` (a real `connection.onMessage` call, not a raw `sim.call2`), since
`inFlightAdmitConn` tracking depends on the admit actually flowing through `SimHost.accept()`'s own
wiring.

**Anti-vacuity:**
- Disabled the whole `sim_fault_ack` call in `SimHost.recover()`: `panic_in_admit_recovers_and_
  rejects_engine_fault` -> `AssertionError: expected [] to deeply equally contain { seq: 1, ... }`;
  `admit_fault_ack_resend_is_dropped_not_retrapped` -> `AssertionError: expected true to be false`
  (the resend re-trapped). Reverted, green.
- Disabled only the `highest_admitted_seq` bump inside `Host::fault_ack` (kept the ack push):
  `admit_fault_ack_resend_is_dropped_not_retrapped` -> the same `expected true to be false` (the
  resend re-trapped even though the ack itself still arrived) -- isolates the dedup-floor half from
  the ack-delivery half. Reverted, green.
- The `GameInstance<G>` forward for `sim_fault_ack` was written correctly the first time (the
  earlier miss for `sim_reattach` was a live bug, not a rehearsed injection) -- checked by temporarily
  deleting it and confirming `sim_fault_ack` fell back to `Status::Unsupported` the same way
  `sim_reattach` originally did (`admit_fault_ack_resend_is_dropped_not_retrapped` failed the same
  way as the "no bump" injection above, since a no-op `fault_ack` never raises the dedup floor
  either). Reverted, green.

**2. Native `testing::replay`/`testing::heavy` now honour `Skip`, built.** `scan_skip_targets`
(collects every `Skip` record's own `offset` field over the whole log, mirroring `Host::sim_replay_
scan_push`'s reasoning exactly) and `filter_records` (the real apply pass: an `Action` record whose
own absolute `record_offsets[i]` -- already reader-relative-from-byte-0 for these functions, unlike
`Host`'s own `replay_base_offset`-adjusted version -- is a scan target is never applied, but still
returned so the caller can `record_ack` it) replace the old single-pass `to_record`. `replay` calls
`record_ack` on its one `Sim`; `heavy` calls it on *both* `sim_a`/`sim_b`, or their own A-vs-B
divergence check would trip for a reason having nothing to do with what it exists to detect.
`replay_rebuilds_last_seq`'s own hand-rolled replay loop updated the same way (it used `to_record`
too). New `fx-panicky` test `replay_with_skip_matches_generic_testing_replay`: builds one
`Skip`-bearing log (the same shape every other `skip_replay.rs` test uses), replays it through
`Host<Panicky>`'s own two-pass ABI drivers (the "recovering host") and through the generic
`engine::testing::replay`, and asserts the two independent implementations reach the identical hash.
Anti-vacuity: with `scan_skip_targets` forced to return an empty set, the new test failed with
`left: [(Tick(2), 9800360619973041494)] right: [(Tick(2), 8842685379741079622)]` (the generic path
applied the poisoned record for real). Reverted, green. No existing golden moved (`replay`/`heavy`
are test-only functions with no golden of their own; every fixture's own `golden.json`/`.hash` files
are untouched, confirmed by re-running `pnpm test rust`/`pnpm test wasm` with no `pnpm golden`/
`pnpm golden:bytes` call anywhere in this fix round).

**Measured (fix round 1):** `ABI_VERSION` 19 -> 20. `pnpm test`: `rust pass 529` (528 + the new
`fx-panicky` test), `unit pass 251`, `wasm pass 123` (122 + the new resend test;
`panic_in_admit_recovers_and_rejects_engine_fault` was strengthened in place, not added),
`browser pass 200`. `pnpm lint`: all green. `node scripts/repeat.mjs browser 5`: `pass=5 fail=0
hang=0`.

### M24 fix round 2

**Gap closed:** `SimHost.recover()`'s Admit-fault-ack path is guarded by two independent
conditions -- `originalCursor?.phase === Phase.Admit` and `admitConnAtTrap !== null` -- and nothing
proved that *both* are load-bearing. New `unrelated_trap_does_not_fault_ack_a_stale_admit_conn`
(`panicky-recovery.test.ts`): two connections; conn B admits and applies first, then conn A admits
and applies (the *last* successful admit before the trap, so a stale `inFlightAdmitConn` would be
stuck at exactly conn A's own id); a wholly unrelated `trapSim` trap (`Phase::Idle`, no `Skip`)
follows; after `recover()`, conn A's next frame is decoded for real (`decodeActionResults`) and
checked by *content*, not by a specific `seq` (`Phase::Idle`'s own cursor `record` is always `0`,
never the real `seq`, so a `seq`-specific check would miss a bug that fires with the wrong `seq`
attached -- found live, below); conn A's connection is then proven still fully usable (a new action
admits and applies, changing the hash).

**Anti-vacuity, all three combinations, exactly as asked:**
- **Both defects together** (clearing removed *and* the phase check loosened to `admitConnAtTrap !==
  null` alone) -> **fails**, but only once the assertion itself was fixed: the first version checked
  `not.toContainEqual({ seq: 1, result: { Rejected: { Engine: 'EngineFault' } } })` and *passed even
  with both defects injected*, because the spurious ack the loosened gate sends carries `seq: 0`
  (`Phase::Idle`'s own cursor `record`, always `0`) -- not `1`, so the seq-specific check missed it.
  Rewritten to check `resultsA.some(r => JSON.stringify(r.result).includes('EngineFault'))` instead;
  re-run with both defects still injected -> `AssertionError: expected true to be false`. Reverted,
  green. (This was a real near-miss the coordinator's own request surfaced: the first version of
  this very test could not fail either.)
- **Clearing removed alone** (phase gate intact): passes -- `Phase::Idle !== Phase::Admit` blocks it
  regardless of the stale `conn` value.
- **Phase gate loosened alone** (clearing intact): passes -- `inFlightAdmitConn` is correctly `null`
  by the time the unrelated trap happens, so `admitConnAtTrap !== null` alone blocks it.

**Neither check is redundant.** Each one alone stops the bug precisely when the *other* is broken;
only breaking both at once exposes it. This is deliberate defense in depth, not two names for the
same fact -- kept both, per the coordinator's own instruction not to delete either on a "redundant"
guess.

**`Phase::Replay`'s own write, noted as asked:** `sim_replay_begin` writes `Phase::Replay` once, at
the start of a replay session; `sim_replay_push` writes it again (with the real per-record `record`)
before every apply pass inside that same session. No test here writes zero records and then traps
inside `sim_replay_begin` itself before any `sim_replay_push` ever runs, so `sim_replay_begin`'s own
write is only ever observed transitively, through a value `sim_replay_push` immediately overwrites.
Accepted as harmless (both write the identical `Phase`, and `record` for `sim_replay_begin` is always
the segment's own starting `offset`, never read by anything this milestone's recovery logic branches
on) rather than built out further.

**Measured:** `pnpm test`: `rust pass 529`, `unit pass 251`, `wasm pass 124` (123 + the new test),
`browser pass 200`. `pnpm lint`: all green.

ADR note: 0009 `HostServices` had no member through which a *server* host learns of `onFatal` (0005 Panic recovery 4). 0024 §5 adds `HostServices.onFatal?`; this brief exposes `SimHost.onFatal` and M27 maps it.
