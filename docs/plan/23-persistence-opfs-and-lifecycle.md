# M23: Persistence in the browser: OPFS, Web Lock, lifecycle, export/import

Status: not started · After: 22b · Tyler-dependent: Q9, "what should a game do with a save it cannot load?" (unanswered; default assumed: engine offers `exportWorld` and `deleteWorld` on an unloaded world; the reference game shows both). Device check attached (**D**).

## Goal
A single-player world survives tab close and reload: the sim worker owns OPFS sync access handles and a Web Lock, a second tab gets `WorldBusy`, a browser without OPFS runs on memory storage and reports `durable: false`, and `exportWorld` / `importWorld` round-trip a world between browser and Node. The zero-GC test runs with persistence on and decides, by measurement, whether the periodic snapshot write stays inside the strict window.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0005-persistence-and-recovery.md` (Cadence; Storage: OPFS row, the *Browser* and *Export/import* bullets; Single-player to hosted)
3. `docs/decisions/0016-zero-gc-definition.md` (§1 table, §2 exempt list, §3 steps, last Consequences bullet)
4. `docs/decisions/0015-threads-memory-and-topology.md` (Sim worker row; Wake-ups paragraph: `Atomics.wait`, the `yield` flag, what `postMessage` may carry)
Mine from spikes: `spikes/zero-gc-webgpu` (worker CDP attach, sampling calls), `spikes/cross-origin-sab` (COOP/COEP page). Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
- `opfsStorage(worldId)`: the OPFS row of the 0005 Storage table, behind the M22 `Storage` interface; passes `runStorageConformance` in a page.
- Sim worker start-up order: Web Lock → OPFS probe → `Persistence.open` → tick loop. `WorldBusy` and `durable: false` paths.
- Main thread: `navigator.storage.persist()` once (0005 *Browser* bullet), storage status event.
- Browser clean boundaries: `visibilitychange → hidden` and `pagehide` → `SimHost.pause()`; `visible` → `resume()` (spec: a single-player world pauses when hidden).
- World archive format, `exportWorld` / `importWorld` / `deleteWorld`, in the sim worker and as plain functions over any `Storage` for servers.
- Zero-GC: persistence enabled in the single-player window of M04's test, plus the forced-snapshot measurement.
- A checked-in OPFS latency page for the device check.
- **World page `world.html`** (+ `src/world.ts`, fixture app, fixture `puts`, single-player with persistence on; `?world=<id>`, default `device`): M16's `slice.html` HUD and Paint control plus `hash` (`worldHash`, refreshed once a second), `durable` and `persisted` (from `client.onStorage`), a `WorldBusy` banner when `client.ready` rejects with `'world-busy'`, and Export, Import (file input plus a new-id field) and Delete buttons over `exportWorld` / `importWorld` / `deleteWorld`. The browser tests of this milestone that need a page use it, and the device items name it.

## Non-scope
Panic recovery and worker respawn (M24, M37). `SaveIncompatible` (M24b; this milestone only guarantees export/delete work on a world that failed to load). Game UI for any of it (reference game, M32+). The remaining engine events and `onFatal` (M37). Server-side import wiring in `games/reference-server` (M29).

## Files, packages and crates touched
- `packages/engine/src/storage/{opfs,archive}.ts`, `packages/engine/src/worker/sim.ts`, `packages/engine/src/client.ts` (events + three methods), `packages/engine/src/server.ts` (re-export archive functions)
- `packages/engine/tests/browser/pages/{opfs-latency.html, world.html, src/opfs-latency.ts, src/world.ts}` + the latency page's worker script (M02b's fixture app); browser tests beside M03's.
- No Rust changes expected.

## Seams
**Provides**
- TS: `opfsStorage(worldId: string): Promise<Storage>` (rejects with `OpfsUnavailable`); internal to the worker kind `sim`, opened inside `shell.runAsync`.
- TS on the client (main thread), following the `client.onLink` naming of M29: `WorldBusy` is a start failure, so `client.ready` rejects with `EngineStartError { code: 'world-busy' }` (M06b's union gains the code); `client.onStorage(cb: (s: StorageStatus) => void)` with `StorageStatus = { durable: boolean; persisted: boolean; usage: number; quota: number }`. M24b adds code `'save-incompatible'`; M37 adds `onFatal` and audits the set against 0005 Consequences. Carrier: `SimLifecycleMessage = { type: 'storage', ... } | { type: 'start-failed', code, detail }` over `postMessage` from the sim worker (lifecycle only, 0015; M06b's `postMessage` grep criterion gains these two types).
- TS methods: `client.exportWorld(): Promise<Blob>`, `client.importWorld(bytes: Blob | Uint8Array, opts?: { worldId?: string; overwrite?: boolean }): Promise<{ worldId: string }>`, `client.deleteWorld(worldId: string): Promise<void>`; all reject with `NotSinglePlayer` when there is no sim worker.
- TS functions from `engine/server`: `exportWorld(storage: Storage, worldId: string): Promise<Uint8Array>`, `importWorld(storage: Storage, bytes: Uint8Array, opts?): Promise<{ worldId: string }>`; archive = gzip (`CompressionStream`) of `magic | version u16 | count | (key, bytes)*` holding exactly the key set 0005 lists.
- Pages `opfs-latency.html` and `world.html` (`?world=<id>`; HUD adds `hash`, `durable`, `persisted` to M16's fields), the latter reused by M24's and M24b's browser tests if they need a persisted world page.
- `engine/test`: `forceSnapshot()` (advances the injected clock past the cadence so one snapshot lands in a measured window), `persistenceCounters()`.
- `budgets.json` lines: `simWorker.bytesPerFrame` now measured with persistence on; possibly `simWorker.snapshotEventBytes` (Planning decision 1).

**Consumes**
- M22 `Storage`, `runStorageConformance`, `Persistence`; M22b `Persistence.open`, `SimHost.pause/resume/stop`, `WorldLoadError`.
- M06b `W_YIELD` / park / resume protocol and `shell.runAsync(fn)` (leave the loop, await, re-enter); `EngineStartError`; `createClient({ host: { kind: 'local', world } })` (M06b/M13); M13 sim worker body and `SimHost.pause/resume`.
- M16 `slice.html` HUD fields and Paint control; M13 `worldHash`.
- M04 zero-GC harness and negative controls; M03 COOP/COEP fixture page and stepping API.

## Planning decisions
1. **Is the periodic snapshot `write` inside the strict zero-GC window? (PRE-PLAN §10, 0016.) Measured here, with the rule fixed now.** The test `zero_gc_singleplayer_with_snapshot` calls `forceSnapshot()` once inside the 600-frame window. If the sim worker still meets its 0016 §1 budget with zero GC events: **inside**, the default stands, and this test replaces the snapshot-free one. If not: the strict test runs without a snapshot, a second test asserts the snapshot as a *budgeted event* (`simWorker.snapshotEventBytes` = measured bytes + 25 %, hard cap 4 KB per snapshot, zero `MajorGC`), and the session writes a new ADR superseding the deferred sentence in 0016 (use the `write-adr` skill). Either way the log `append` and `sync` stay in the strict window and the failure output names the allocating call frames. Rationale: the only allocating part is the promise-only rename/reopen (a few promises per 60 s); a number decides, not an argument.
2. **Promise-only OPFS calls run behind `shell.runAsync`, never awaited by the tick path.** After the synchronous scratch write + `flush()`, the adapter queues the rename and the next scratch open; the sim worker body runs them through M06b's `shell.runAsync` in the gap after the current tick pass (the loop is left and re-entered once per snapshot); their failure reaches `Storage.onError`. If the next scratch handle is not open when the following snapshot is due, that snapshot is skipped and retried a tick later (counter `snapshotDeferred`, expected 0).
3. **Rename availability is checked first (the fallback is 0024 §4).** Step 1 of the work probes `FileSystemFileHandle.move()` in Playwright WebKit, Firefox and Chromium, and the device page probes it on iOS. If it is missing anywhere we support, the adapter uses *slot files* instead and no rename at all: snapshots go to pre-opened `snap.slot<k>` files whose first bytes are an adapter header `key_len u16 | key`; `list`/`read` resolve keys from slot headers; `delete` frees a slot. This is safe for the reason 0005 already gives (recovery trusts only the CRC). Record the outcome under Deviations; if slots are used, report it as an amendment to the 0005 OPFS row.
4. **`append` passes no options object.** Sync access handles keep a file position cursor; the adapter seeks once at open (`{ at }` on a reused options object) and then calls `write(view)` only. The zero-GC test is the proof.
5. **`persist()` trigger.** Called once from the first engine-observed `pointerdown`/`keydown` or the first `client.dispatch`, whichever comes first, and only when `Persistence.open` reported `created`. `client.onStorage` fires at load, after the `persist()` answer, and after each hidden-boundary snapshot; `estimate()` is never called on the tick path.
6. **Export/import run where the handles are.** Main parks the sim worker (`W_YIELD` + wake), posts the request; the worker pauses, takes a snapshot if dirty, awaits `flush()`, packs, and transfers the buffer back. Import writes under the archive's world id (or `opts.worldId`), takes lock `world:<id>` for the duration, refuses the running world's id and refuses an existing id without `overwrite`. The game then starts that world with a new `createClient`. Import never loads the world itself; the normal load path (and later the upgrade path, M24b) runs at that next start, as 0005 says.
7. **OPFS latency on iOS Safari (PRE-PLAN §10, 0005): scheduled here as a device check with the retune rule fixed now.** Tyler opens `opfs-latency.html` on the iPhone, served by M03's `pnpm device:serve --tunnel` (OPFS and cross-origin isolation need a secure context). The page's worker does 1,200 appends of 64 B with a `flush()` after every 20, then scratch writes of 1 MiB and 8 MiB with `flush()`, and prints p50 / p95 / max for `append`, `flush`, and both snapshot writes, plus `move()` and `navigator.locks` availability. **The retune number is `flush` p95.** ≤ 10 ms: keep the 1 s interval. 10–40 ms: raise the interval to 2 s (one hitch half as often; the power-loss window then equals the object-store row of 0005). > 40 ms (longer than the gap between ticks): `sync` only at snapshots and clean boundaries. Any change is a new ADR superseding that number in 0005. `append` p95 > 2 ms is reported but changes nothing (one append per tick).

## Order of work
1. Probe `move()`, `createSyncAccessHandle`, `navigator.locks` in the three Playwright browsers; settle decision 3.
2. `opfsStorage` + in-page conformance run.
3. Sim worker start-up order, `world-busy`, `durable: false`, `client.onStorage`.
4. Hidden/visible boundaries; reload test.
5. Archive + export/import/delete, Node round trip first, then browser ↔ Node.
6. Zero-GC with persistence; forced-snapshot measurement; budgets file; ADR if needed.
7. Latency page; confirm the `docs/plan/device-checks.md` section for this milestone matches what was built.

## Tests added
- Browser (Chromium unless noted): `storage_conformance_opfs` (also WebKit, Firefox), `world_survives_reload` (play, reload page, hash at resumed tick equals `replayWorld` of the exported log), `second_tab_gets_world_busy`, `no_opfs_falls_back_durable_false` (OPFS stubbed out by an init script), `storage_status_reports_estimate` (on `world.html`: `client.onStorage` fires at load with `durable`, a boolean `persisted` and numeric `usage` and `quota`; on a created world a spy sees `navigator.storage.persist` called exactly once, after the first injected gesture and not before; a reopened world never calls it: Planning decision 5), `hidden_pauses_and_snapshots`, `export_import_roundtrip_browser`, `delete_world_removes_all_keys`, `export_works_after_load_failure` (corrupt manifest), `zero_gc_singleplayer_with_snapshot`, negative control `neg_control_snapshot_allocates` (a test-hook adapter that allocates per `append` must fail on the sim worker only).
- Vitest (Node): `archive_golden_bytes`, `export_import_roundtrip_node`, `export_browser_import_node_same_hash` (archive fixture produced by the browser test, consumed under Node: the single-player → hosted path of 0005), `import_refuses_existing_world`.

## Exit criteria
- [ ] All tests above pass by name.
- [ ] Decision 1 is resolved in writing: either the default is confirmed (measured bytes recorded under Deviations and in `budgets.json`), or the superseding ADR exists and `budgets.json` carries `simWorker.snapshotEventBytes`.
- [ ] Decision 3 outcome recorded.
- [ ] `pnpm device:serve` lists `opfs-latency.html` and `world.html`; in desktop Chrome `world.html` shows `hash`, `tick`, `durable: true`, and a second tab on the same `?world=` shows the `WorldBusy` banner (`second_tab_gets_world_busy` runs on this page).
- [ ] The `docs/plan/device-checks.md` section for this milestone matches what was built.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t opfs` · `pnpm test browser -t zero_gc_singleplayer_with_snapshot` · `pnpm test wasm -t export_` · `pnpm test` · `pnpm lint`

## Budgets
- Allocation per isolate row (0016): sim worker strict budget with persistence on; snapshot per decision 1.
- Latency row (0005): `sync` ≤ 1/s asserted in-browser through `persistenceCounters()`.
- Memory, whole tab row (0015): `SnapshotBuffer` high-water mark reported by the reload test (informational).
- Test suite row: browser additions ≤ 3 s p95 each (0020 §4).

## Context artifacts
Extend `packages/engine/src/storage/CLAUDE.md`: OPFS adapter rules (no options objects, no promises on the tick path, self-yield). Extend the `gc-test` skill with "forcing a snapshot inside the window".

## Manual device checks
[device-checks.md, M23: OPFS and world lifecycle](device-checks.md#m23-opfs-and-world-lifecycle).
This milestone builds `opfs-latency.html` (Planning decision 7) and `world.html` (Scope: hash, tick, `durable`, `WorldBusy`, export / import / delete controls); both are listed by `pnpm device:serve --tunnel`.

## Deviations
(filled in during Phase 3)
