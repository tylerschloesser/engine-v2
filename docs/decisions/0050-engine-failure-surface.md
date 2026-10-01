# 0050: Engine failure surface

Status: Accepted (2026-10-01). Settles the "snapshot → reload → restore so a Rust edit keeps the world" item [0017](0017-packaging-and-build.md) deferred to Phase 3; completes [0005](0005-persistence-and-recovery.md) "Panic recovery" and Consequences for the client, gen and sim-worker roles and links [0024](0024-planning-amendments.md) §5 for the server. Implemented by M37 (`docs/plan/37-robustness-events.md`, Deviations hold the shapes and measurements); `rendererLost` by M37b ([0018](0018-renderer.md) §8).

## Context

0005 and 0014 §6 say what an owner does with a dead instance, and 0013 promises the game a handful of events (version mismatch, `superseded`, desync). By M36 each had landed in its own milestone with its own delivery shape. M37 made one surface and one set of reactions out of them. Four things were decided on the way and a further set only became visible while building them; none can be read back from the code.

## Decision

**1. One delivery style: per-event subscriptions.** Engine events reach the game as `client.on<Name>(cb)` returning an unsubscribe function, the style of `client.onUi` / `client.onActionResult`: `onStorage`, `onResyncing`, `onLink`, `onVersionMismatch`, `onRendererLost`, `onFatal`, `onDesync`. There is no `EngineEvent` union and no `client.onEngineEvent`; the audit test fails if one appears. Start failures (`world-busy`, `save-incompatible`) stay rejections of `client.ready`, never events. Most events do not replay to a late subscriber (`onFatal` does), so a game registers all of them before its first `await` (the reference game does in `game.ts`).

**2. Rust edit keeps the world through persistence; nothing new is built.** A Rust edit changes the build hash; the full reload takes 0005 "Upgrades" ([0024](0024-planning-amendments.md) §3: snapshot, then the log tail re-executed under the new code when `SCHEMA_VERSION` is equal). No admitted action is lost; at most action-free progress since the last snapshot, which 0005's loss-window table accepts. Client-only state (camera, open menus) does not survive; a game that wants it uses `sessionStorage` through `client.camera.read` / `moveTo`. A dev-only in-memory hand-off would be a second restore path to keep correct, so it is not built. A state-layout or action-layout change without a `SCHEMA_VERSION` bump is the author's error and surfaces as `save-incompatible`. Proof: `dev-reload-keeps-world @slow` (plugin dev server on a temp copy of the scratch game, three actions, one `.rs` constant edited, `full-reload`, same pings, tick not backwards, new build running; Deviations).

**3. `rendererLost` is not `onFatal`.** A reload fixes a lost renderer and the sim keeps saving; `onFatal` means the world is wedged under this build and the engine has stopped (workers parked, no snapshot, files untouched, `dispatch` yields an `EngineFault` rejection). `rendererLost` fires only when a rebuild cannot recover (`'no-adapter'`, `'repeated-loss'`: two losses within 10 s of the injected clock).

**4. A fatal server adds no protocol.** It reports through `HostServices.onFatal` ([0024](0024-planning-amendments.md) §5), stops, and closes sockets. Clients fall into the ordinary reconnect policy of [0013](0013-sessions-and-integrity.md) and a fixed deploy answers with a version mismatch. A close code that stops reconnection would strand players when the deployer's supervisor brings the fix up.

**5. Reactions per role.**
- *Client instance trap*: the client worker builds a new instance from the kept `Module` and asks for a full resync **in band**: a new `Hello` on the already settled connection makes the host re-handshake it (`reopenOnHello`). No link is reopened: the ring pair, socket and memory pair stay, and the net worker is untouched. For a local link main bumps `CB_LINK_GEN` after a sim respawn so the client sends `Hello` again. Prediction and pending actions drop (pending seqs resolve as `Lost`); the main thread keeps drawing the last DrawList until the rebuilt client has a frame.
- *Gen instance trap*: fresh instance, re-queue the in-flight request; the same chunk twice is fatal (worldgen is pure).
- *Sim worker death*: main respawns it with the kept `Module` through the ordinary load path; the epoch bumps and clients resync through the second `Welcome`. **A dead sim worker of an unpersisted world is fatal at once**: a new worker would start a different world.
- *Loop guards run on main's injected clock*, not in workers (they have none): two client traps, or two sim-worker deaths, within 10 s (`LOOP_GUARD_WINDOW_MS`) are `onFatal`. The gen "twice" rule involves no time and lives in the worker.

**6. Two locks, and `pagehide` wakes the sim worker.** A reload during load must not be refused `world-busy` by the old document's still-dying sim worker. The main thread takes `world-owner:<id>` (it dies with its document, so an unavailable lock means another live document and the worker is told not to wait); the sim worker takes `world:<id>` with one waiting request, whose wait (`WORLD_LOCK_WAIT_MS`) is a ceiling, not the mechanism. A worker blocked in `Atomics.wait` is ended by Chromium only after about 2 s, so on `pagehide` (not bfcache) main wakes it out of the wait (`wakeOutOfWait`, the same sequence as destroy and as a dead worker): reload during load went from 2.45 s to 0.75 s (Deviations, "Fix round"). No early lock release is possible from main, and none is attempted.

**7. The reference game answers every row, and the walk feeds synthetic states.** `ui/status.ts` is the one place engine events are handled. `reference: status walks every event` drives what a real run can reach (not-durable storage, desync, resync after traps, two device losses on the manual clock, `onFatal`) and feeds the rest straight into `StatusUi`: link states `reconnecting`, `updating`, `superseded`, `rejected`; the `no-adapter` reason; the `world-busy` and `save-incompatible` start-failure screens. Those need a server or a `test-hooks` build and are proven where they arise (the audit table names those tests). The Reload buttons are asserted present, not clicked.

**8. The event table is the audit.** `packages/engine/src/engine-events.test.ts` (`engine event surface`) pins, per row, the `Client` members (types and interface text), the exact behaviour-test titles (declared, not skipped) and the reference `StatusUi` answer. A new engine-to-game event adds a row and a behaviour test.

| Event | ADR | Milestone | Behaviour tests |
|---|---|---|---|
| `SaveIncompatible` | 0005 Upgrades | M24b | `no_migrate_hook_save_incompatible_files_untouched`, `save_incompatible_rejects_ready_and_export_still_works`, `reference_save_incompatible_leaves_files @slow` |
| `WorldBusy` | 0005 Storage | M23 | `second_tab_gets_world_busy`, `reference_world_busy_second_tab` |
| `durable: false`; `{ persisted, usage, quota }` (`onStorage`) | 0005 Storage | M23 | `no_opfs_falls_back_durable_false`, `storage_status_reports_estimate` |
| `onResyncing` | 0005 Panic recovery | M28b (host hook M24) | `reconnect/panic-recovery-resync`, `trap: client instance recovers and resyncs` |
| `onFatal` | 0005, 0015 §5, 0024 §5 | M24, M37 | `panic_in_tick_is_fatal_and_files_untouched`, `fatal: two client traps`, `fatal: storage error`, `fatal: server onFatal stops world and closes sockets` |
| `onRendererLost` | 0018 §8 | M37b | `two losses raise rendererLost`, `null adapter raises rendererLost` |
| version mismatch → reload once → `updating` | 0013 | M29 | `version-mismatch`, `mp/version-mismatch-reloads-once` |
| `exportWorld` / `importWorld` | 0005 Storage | M23 | `export_import_roundtrip_browser`, `reference_export_import_roundtrip` |
| `EngineFault` action result | 0005 | M24 | `panic_in_admit_recovers_and_rejects_engine_fault` |
| `Lost` action result | 0005 | M28b | `reconnect/lost-ack-reports-lost` |
| `superseded` stops auto-reconnect | 0013 | M29 | `mp/superseded` |
| reconnect indicator delay | 0013 | M29, test M37 | `mp/reconnect-indicator-delay` |
| desync report (`onDesync`) | 0013 | M31b, M37 | `desync: onDesync fires once per report` |

## Alternatives rejected

- **An `EngineEvent` union or `client.onEngineEvent`:** a second delivery path beside `onUi` / `onActionResult`, with a switch every game must keep exhaustive.
- **An in-memory hand-off on Rust edit:** a second restore path, correct only as long as it tracks the persistence one.
- **Reopening the link on a client trap:** redials a socket and restarts the net worker for a fault that is local to one instance; the in-band `Hello` reuses the reconnect resync.
- **Guards inside workers:** no injectable clock there, so the test would need real time.
- **A close code that stops reconnection on a fatal server:** strands players behind a supervisor that restarts a fixed build.
- **Releasing the world lock from main on `pagehide`:** a lock held by a worker can only be released by that worker, which is in `Atomics.wait`.
- **A longer lock wait instead of waking the worker:** it only moved the failure (3 s wait over a 2 s teardown left no margin on a loaded machine).

## Consequences

- A trap in a role is recovered without a reload; what cannot recover raises `onFatal`, in a browser and on a server, and the engine stops with every file untouched.
- Tick-panic recurrence is guarded by the loop guard's fourth `recover()` ([M37 Deviations](../plan/37-robustness-events.md#deviations)); `SimHost.accept`'s `sim_connect` fallback and the rejected-Hello-settle stall stay open (ledger rows unchanged).
- Revisit the dev-reload decision if a game needs camera or menu state across edits and `sessionStorage` is not enough.

## Sources

`docs/plan/37-robustness-events.md` Deviations and Planning decisions; `docs/plan/37b-device-loss.md`; [0005](0005-persistence-and-recovery.md), [0013](0013-sessions-and-integrity.md), [0014](0014-js-wasm-boundary.md) §6, [0017](0017-packaging-and-build.md), [0018](0018-renderer.md) §8, [0024](0024-planning-amendments.md) §3, §5. Chromium's ~2 s worker teardown measured in this repo, 2026-10-01.
