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

### Step 1: probe results, Decision 3 settled

Probed with `@playwright/test` 1.63.0 (Chromium 153, WebKit 26.6, Firefox 155) against the
`tests/browser/pages` app (COOP/COEP already global there via `engine()`'s Vite plugin, so no new
fixture page was needed for the probe itself), from inside a dedicated Worker (matches where the
adapter actually runs, 0015 "sim worker") plus a main-thread check for `getDirectory()` alone. Probe
code was throwaway (a page + worker script + spec, written, run, and deleted; not committed) --
paste below is the full captured output.

**Critical, load-bearing finding: WebKit's OPFS only works under a persistent browser context.**
Under Playwright's default `browser.newContext()` (what every existing project in
`playwright.config.ts` uses), WebKit's `navigator.storage.getDirectory()` itself throws
`UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).` --
on the main thread and inside a worker, before `move()`/`createSyncAccessHandle`/locks are ever
reached. Under `webkit.launchPersistentContext(userDataDir, ...)` (a real on-disk profile), the
exact same page succeeds completely. Chromium and Firefox work under the default ephemeral context
either way. This is a Playwright/WebKit test-harness limitation (WebKit's OPFS backing store needs a
real profile directory), not a real-Safari capability gap -- real Safari (desktop or iOS) always has
a persistent profile. **Consequence for step 2 and later browser specs that touch OPFS**: they need
a small fixture overriding `context`/`page` to use `launchPersistentContext` (all three browsers, for
one code path); `storage-opfs.spec.ts` (step 2) carries it in
`tests/browser/support/opfs-context.ts`, scoped to that file alone -- no other spec's fixtures
change. Every result below, and step 2's own conformance run, uses that persistent-context path.

| Browser | `move()` 1-arg | `move()` 2-arg (`move(dir, name)`) | overwrite via `move()` onto an existing name | `createSyncAccessHandle` | `navigator.locks` | OPFS at all, ephemeral context |
|---|---|---|---|---|---|---|
| Chromium 153 | works | works | works (dest bytes replaced) | works | works | works |
| Firefox 155 | works | works | works | works | works | works |
| WebKit 26.6 | **throws `TypeError: Not enough arguments`** | works | works | works | works | **fails** (`getDirectory()` itself throws; needs persistent context) |

**Decision 3 outcome: rename, not slot files.** `FileSystemFileHandle.move()` is available and
works in every browser we support, given the 2-arg form (`handle.move(directoryHandle, name)`)
called uniformly -- WebKit's implementation requires both arguments (the 1-arg `move(name)` form
throws `TypeError: Not enough arguments` there; both forms work in Chromium and Firefox). `move()`
onto an existing destination name overwrites it (measured: the destination's old bytes are gone,
replaced by the source's), which is what the scratch-file rename in Planning decision 2 relies on.
No slot files, no adapter header format. **Correction (fix round 1): no 0005 amendment at all.**
The earlier draft of this section called the 2-arg call form "a one-line ADR amendment, not a format
change" -- wrong: 0005's OPFS row already just says "rename"; it never specified the 1-arg vs. 2-arg
form, so nothing it says is contradicted or superseded. The 2-arg requirement is an implementation
fact of this adapter (`opfs.ts`'s own comments, `storage/CLAUDE.md`), not a decision Tyler made that
needs a superseding record. No ADR is written for Decision 3.

Device check callout for step 7 (not built here): the iOS probe (`opfs-latency.html`) should call
`move()` with the 2-arg form from the start, matching this finding, rather than discovering the same
`TypeError` on-device.

### Step 2: `opfsStorage`, `storage_conformance_opfs` (also WebKit, Firefox)

Built `packages/engine/src/storage/opfs.ts` (`opfsStorage(worldId): Promise<OpfsStorage>`,
`OpfsStorage extends Storage`, `OpfsUnavailable`) and `opfs-types.d.ts` (ambient
`createSyncAccessHandle`/`move`/`FileSystemSyncAccessHandle`, absent from TypeScript 6.0.3's
`lib.dom.d.ts`). Conformance page `tests/browser/pages/storage-opfs.html` + `src/storage-opfs.ts` +
`src/storage-opfs-worker.ts` (runs inside a dedicated Worker: every browser here only has working
OPFS from one, matching where the adapter runs in production, 0015 "sim worker"). Spec
`tests/browser/storage-opfs.spec.ts`, `storage_conformance_opfs @engines` -- passes in Chromium,
WebKit and Firefox (`pnpm test browser -t opfs` for Chromium/fast tier;
`pnpm test:slow browser -t opfs` runs the `engines` leg, 2 tests, 3.4 s).

**Second critical finding (test-harness only): Playwright's WebKit does not isolate OPFS per
`launchPersistentContext` profile directory.** A write to a bare key (no `worlds/<id>/` prefix,
exactly what `runStorageConformance`'s own `'log'`/`'k'` keys are) from one `launchPersistentContext`
call was still readable from a brand-new temp profile directory in a wholly separate Node process --
measured directly: after wiping nothing, a fresh `debug-append` world's first-ever `append('log',
'a')` read back as `"ababa"` (bytes from earlier, unrelated test runs) in WebKit; Chromium and
Firefox both read back exactly `"a"`. `storage-opfs-worker.ts` therefore wipes the whole OPFS root
(`navigator.storage.getDirectory()`'s own top-level entries, `removeEntry(name, {recursive:true})`)
once, before touching `opfsStorage` at all -- confirmed this makes the result independent of run
history and run order (10 consecutive three-browser runs, no flake). `opfsStorage` itself never does
this; it is test-page hygiene only, kept in `storage-opfs-worker.ts`, documented in
`storage/CLAUDE.md`. Root cause not fully isolated (plausibly WebKit's OPFS backing store is keyed by
origin alone on the host machine, independent of which profile directory launched the browser); worth
carrying into any later multi-browser OPFS spec (`world_survives_reload`, `second_tab_gets_world_busy`
etc., steps 3-4) since they will hit the same thing the moment they touch WebKit.

**Seam shapes for step 3 (verbatim, as requested):**
- `opfsStorage(worldId: string): Promise<OpfsStorage>`; `OpfsStorage extends Storage` adds
  `pendingAsync(): (() => Promise<void>) | null`, `scratchReady(): boolean`, `snapshotDeferred:
  number` (a plain writable field). `OpfsUnavailable extends Error { reason: string }`, thrown (the
  promise rejects) when `navigator.storage.getDirectory()` throws/is absent, or the first
  `createSyncAccessHandle()` (opening the initial `.scratch` handle, done eagerly inside
  `opfsStorage()` itself) fails.
- The hook: `write()`'s synchronous half (already-open `.scratch` handle: `truncate`, `write(bytes,
  {at:0})`, `flush()`) runs inline and `write()` returns `undefined`; it then builds one closure
  (close the scratch handle, `scratchFileHandle.move(destDir, destName)`, reopen the next scratch)
  and stores it as the adapter's own single pending slot. **The worker learns there is work** by
  polling `pendingAsync()` itself (not an event/flag) -- cheap on a `null` read, and it both returns
  and clears the slot in one call, so a body that polls every wake never double-runs it. Not wired
  into `worker/sim.ts`'s `body()` yet (that is step 3's job: call `pendingAsync()` after the tick
  pass, and if non-null, `shell.runAsync(fn)`). `snapshotDeferred` is a plain counter this adapter
  never increments itself; a future `Persistence` reads `scratchReady()` before a periodic snapshot
  and bumps `snapshotDeferred` itself if it chooses to skip rather than take the slower,
  promise-returning path (`write()` never itself skips -- see Planning decision 1's own "expected 0"
  language, which is about that future caller's choice, not this adapter refusing to write).
  Failure inside the queued closure calls `this.onError?.(e)` and is swallowed there, matching 0005's
  own error channel -- never rethrown to whatever calls `pendingAsync()`'s returned function, so a
  generic `shell.runAsync` wrapper's own `.catch(() => shell.fatal(...))` is not also triggered by
  the same failure through a second path.
- `append(key, bytes): void | Promise<void>` is a **plain, non-`async`** method: `undefined`
  synchronously once the key's sync access handle is open (a bare `handle.write(bytes)`, no options
  object, no copy -- the handle consumes `bytes` synchronously before returning), a real
  `Promise<void>` only for the first `append` to a given key (opens the handle, seeks once via a
  reused `{at}` object whose field is overwritten, never a fresh literal). `sync(key)` is `void`
  always, `handle.flush()` if the key's handle is open, a no-op otherwise (proven: `sync_never_throws
  _on_an_unknown_key`).
- No adapter header/slot format: Decision 3 (above) settled on rename.

**Negative-control hunt (delegation prompt):** injected three mutations into `opfs.ts`, ran
`storage_conformance_opfs` in Chromium, confirmed each failed, then reverted (verified `git diff`
clean afterward):
  - `append`'s fast path forced to `state.handle.write(bytes, { at: 0 })` (never advances) ->
    `append_accumulates_in_call_order: expected 'ab', got 98` (fails, caught).
  - `list()`'s final `.sort()` removed -> `list_returns_matching_keys_sorted: expected
    ["worlds/a/log/000000","worlds/a/manifest"], got ["worlds/a/manifest","worlds/a/log/000000"]`
    (fails, caught).
  - "write after append on one key, out of order" (the delegation prompt's third example): tried
    directly (`append('mixed','a')` then `write('mixed','replaced')` then `read`) -- succeeded
    correctly in Chromium (`move()` onto a name with another handle's own *different* file still open
    elsewhere is unaffected; the rename target here had no open handle of its own). **Gap found,
    not fixed here**: `runStorageConformance` has no check that mixes `append` and `write` on one
    key, and this adapter's own `#logHandles` entry for a key is not invalidated when a `write()`
    later replaces that same key's file out from under it -- a subsequent `append()` to that key
    would keep writing through the stale handle. Real 0005 usage never does this (append only
    targets log segment keys, write only targets manifest/snapshot/session keys, disjoint key
    spaces), so this is a documented adapter limitation, not a production bug, and not something
    `storage_conformance_opfs` would catch either way.

**Measured, per Constraints:** `append`/`sync`'s fast path is a plain method (not `async`), so it
allocates no Promise regardless of what the JS engine does with an empty `async` body -- this is a
by-construction claim (decision 1's own zero-GC *measurement* is step 6's job, not asserted here).
No options object appears on `append`'s fast path; the one seek is `APPEND_SEEK.at = size` (a field
write on a module-level, reused object) followed by `handle.write(EMPTY, APPEND_SEEK)`, once, at
open.

**Files:** `packages/engine/src/storage/{opfs.ts,opfs-types.d.ts}`,
`packages/engine/tests/browser/pages/{storage-opfs.html,src/storage-opfs.ts,
src/storage-opfs-worker.ts}`, `packages/engine/tests/browser/storage-opfs.spec.ts`,
`packages/engine/tests/browser/support/opfs-context.ts` (the persistent-context fixture every
OPFS-touching spec should use going forward), `packages/engine/tests/browser/pages/tsconfig.json`
(added `opfs-types.d.ts` to `include`), `packages/engine/src/storage/CLAUDE.md` (extended, trimmed to
stay under the 60-line cap `context-artifacts.test.mjs` enforces on every nested `CLAUDE.md`).

**Not done (later steps' own scope):** the `gc-test` skill's "forcing a snapshot inside the window"
extension (step 6); wiring `pendingAsync()`/`scratchReady()` into `worker/sim.ts` and `Persistence`
(step 3); `opfs-latency.html` (step 7).

### Open gate failures (orchestrator, from the review agent at the M23 gate)

1. **`flush()` can resolve while an OPFS rename is still in flight.** `OpfsStorageAdapter.pendingAsync()` (`storage/opfs.ts`) is a take; `worker/sim.ts`'s per-pass poll hands the taken fn to `shell.runAsync`, and `SimHost.pause()`/`stop()` → `persistence.flush()` → adapter `flush()` calls `pendingAsync()` again, gets `null` and returns while the rename runs elsewhere, so the `storage` ack after a hidden-boundary pause can precede the durable rename; `#queueRename`'s chaining can also be broken. `pauseHostWorker` (`client.ts`) has no guard for `W_PARKED = 1` set by an in-flight `runAsync`. Found by code trace, not reproduced.
2. **No automated test enforces the sim worker's `postMessage` allowlist** (0015 §2). "M06b's grep criterion" was a one-time checklist line; `worker/protocol.ts` says M23's types are covered by it "in prose". M23 added ten post-setup message types.
3. **`shell.test.ts` never exercises `stop()` during an in-flight `runAsync`**: removing `if (this.#stopped) return` from `#runQueued`'s `.finally()` passes 245/245.
4. **`runAsync` before the first `runBlockingLoop` silently drops `fn`** (`#loop` is `null`), contradicting its own "never dropped".
5. **No automated test that `window.__*` hooks are absent from production sources** (the exports-map test checks import reachability only).

### Gate fix round

1. **`flush()` vs an in-flight rename.** `OpfsStorageAdapter` gained `#renameInFlight` (a plain boolean, not a tracked `Promise`): `#queueRename`'s own closure sets it `true` as its first statement and `false` only after its `finally` (rename *and* scratch reopen) has fully finished. `flush()` checks it before the existing drain loop and, if set, awaits a `Promise` it registers on a new `#renameSettled` resolver array, woken by that same closure's `finally`. `pauseHostWorker`/`pollHostParked` (`client.ts`) needed no code change: documented instead -- `W_PARKED` reading `1` from an in-flight `runAsync` rather than a real park is harmless, since what actually gates `pauseHostWorker()`'s own promise is the `storage` ack, itself gated by `persistence.flush()` → `storage.flush()`, now fixed. New browser assertion `flushWaitsForInFlightRename` in `storage_conformance_opfs` (`storage-opfs-worker.ts`/`storage-opfs.spec.ts`): a gated `FileSystemFileHandle.prototype.move()`, `pendingAsync()`'s closure taken and started without being awaited (the exact shape `shell.runAsync` uses), `flush()` raced against it. Fails on the old take-and-forget `flush()`: `flushNotResolvedWhileRenameHeld: false` (expected `true`) after 5 microtask turns with the rename still gated open. **Two dead ends recorded, not left in the code:** (a) a `Promise`-wrapping version of `pendingAsync()`'s returned closure (tried two shapes, `.finally()` and a bound `.then()` handler) fixed the race but cost the sim isolate ~14.5 KB per forced snapshot in `zero_gc_singleplayer_with_snapshot` (delta 17372-17664 B against a 3600 B budget, both measured windows, fully reproducible across rebuilds) -- apparently the cost of installing *any* new wrapping function on this rarely-exercised path, not the specific promise machinery (near-identical cost with `.then()` instead of `.finally()`); the boolean fix above adds nothing to that path beyond two field writes inside the closure that already existed, and the budget passed unchanged. (b) The first version of `flush()`'s own wait, a `while (this.#renameInFlight) await new Promise(r => queueMicrotask(r))` poll, **livelocked a real headless Chromium outright** (`storage_conformance_opfs` timed out at 30 s, `page.waitForFunction` reporting "Target page, context or browser has been closed"): a tight microtask-only wait loop never yields to the task queue, so the real native `move()`'s own completion (posted as a task) never got a turn to run and `#renameInFlight` never went `false` -- reproduced with the monkey-patch removed too, isolating it to the poll shape itself, not the test's own patching. The resolver-array design replaced it; no polling anywhere in the fix.
2. **`postMessage` allowlist.** `worker/protocol.ts` exports `SETUP_PHASE_MESSAGE_TYPES` (`['ready']`) and `POST_SETUP_MESSAGE_TYPES` (the other nine `FromWorker` literals). New unit test `worker/protocol.test.ts`'s `postmessage_type_literals_are_allowlisted` scans every `.ts` file in `src/worker/` (minus `protocol.ts` itself and `*.test.ts`) plus `worker.ts`, comments stripped, for every `type: '<literal>'` string, and checks each against the allowlist -- conservative by construction (it does not trace whether a literal actually reaches a `post`/`postMessage` call; a `testCall`-style value returned by `test-call.ts`/`worker/sim.ts` and posted one call later by `worker.ts`'s own dispatcher is still caught this way). Failed as required with an injected `post({ type: 'bogus' } as unknown as FromWorker)` in `worker.ts`: `Error: posted message type(s) not in the postMessage allowlist: .../worker.ts: 'bogus'`; reverted, `git diff` confirmed clean.
3. **`stop()` during an in-flight `runAsync`.** New `shell.test.ts` case `shell.stop_during_inflight_runAsync_prevents_reentry`: `runAsync` armed mid-body-pass with a gated promise, `shell.stop()` called while it is still pending, then released. Failed as required with the `if (this.#stopped) return` guard removed from `#runQueued`'s `.finally()`: `AssertionError: expected 2 to be 1` (`bodyCalls`); guard restored, all shell tests green again.
4. **`runAsync` before the first loop.** Chose "queue it": `Shell` gained `#preLoopQueue`; `runAsync` pushes there instead of dropping when `#loop` is still `null`, and `setLoop` (called at the top of `runBlockingLoop`) drains it by calling `runAsync` again now that a loop exists -- one entry-drain pass, then leave, identically to a `runAsync` call from inside a body pass. Documented on `WorkerShell.runAsync`'s own doc comment. New test `shell.runAsync_before_first_loop_is_queued_not_dropped`.
5. **`window.__*` absent from production.** New unit test `src/window-globals.test.ts` duplicates `test.test.ts`'s own `PRODUCTION_ENTRYPOINTS`/`reachableFiles` walk (that file exports neither) and scans the reached files, comments stripped, for a literal `window.__`/`globalThis.__` assignment. Currently zero matches (this codebase's own real debug hooks -- `worker.ts`'s `dbg.__engineWorkerKind`, `worker/sim.ts`'s `leakSinkHolder.__engineSimLeakSink` -- go through a renamed local alias precisely so they don't match this shape). Failed as required with an injected `window.__gateFix5Proof = 1` in `client.ts`: `Error: production sources write window.__/globalThis.__: client.ts: window.__gateFix5Proof = 1`; reverted, `git diff` confirmed clean.

Verification: `pnpm gc -t "sim|connected|reference|world"` (33 tests, all pass, including `zero_gc_singleplayer_with_snapshot`/`neg_control_snapshot_allocates`); `pnpm test` (rust 518, unit 250, wasm 102, browser 199, all green) and `pnpm lint` both green in the foreground, no background loops started.
