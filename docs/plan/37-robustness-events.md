# M37: Robustness: trap reactions, `onFatal`, and the engine-event surface audit

Status: not started · After: 34, 34b, 37b · Tyler-dependent: no

Split: WebGPU device loss, `rendererLost` and the test device-loss flag are `37b-device-loss.md`. Earlier briefs handed this milestone more than the PLAN row shows (M24: client-role and gen-role trap reactions and sim-worker respawn; M31b: the desync event), which pushed the reading list to five files. 37b runs **first** so the audit here sees every event.

## Goal
A trap in the client or gen instance, or the death of the sim worker, is recovered from without a reload; a world that cannot recover raises `onFatal` in the browser and on a server. Every engine-to-game event the ADRs promise is on the TypeScript surface through one delivery path, handled by the reference game and pinned by a named test. The "keep the world across a Rust edit" question of 0017 is closed.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0005-persistence-and-recovery.md` ("Panic recovery" 1–4, "Storage": `onError` and the browser bullet, "Upgrades", Consequences: the event list)
3. `docs/decisions/0014-js-wasm-boundary.md` (§6 panics: what each role's owner does with a dead instance; §4 the call wrapper)
4. `docs/decisions/0013-sessions-and-integrity.md` ("Build-hash handshake", "Client policy", desync report in "Per-chunk desync hashes")

Hand-overs to read in place: M24 Non-scope (second bullet) and its ADR note; M23 Seams (the TS paragraph); M29 "Link events"; M31b "Desync report". Rules that apply: `.claude/rules/hot-paths.md` (worker shells are touched; the healthy path must not change).

## Scope
- **Client-role trap** (0014 §6): the client worker's shell catches `EngineTrap`, instantiates a fresh instance from the kept `Module`, re-runs `engine_init`, and asks for the full resync used for reconnect: it closes and reopens its end of the link, sending a `Hello` without a resume hint (ring pair in single-player, `createLink` in multiplayer). Prediction, interpolation and pending actions are dropped; pending `seq`s resolve as M28b's `Lost`. The main thread keeps drawing the last DrawList meanwhile.
- **Gen-role trap:** fresh instance, re-queue the in-flight request. The same chunk trapping twice is fatal (worldgen is pure, so it will trap forever).
- **Sim worker death** (0005 Panic recovery 2, last sentence): on the worker's `error` event or a `fatal` message with no recovery left, main respawns the sim worker with the kept `Module`; start-up is the ordinary load path (snapshot + log tail), the epoch bumps, clients resync through M28b's second `Welcome`.
- **Loop guards.** Two client traps, or two sim-worker deaths, inside 10 s of injected-clock time → `onFatal`. (M24 already guards the sim *instance*.)
- **`onFatal` on the public surface:** `client.onFatal(cb: (e: { tick: number; message: string }) => void)`. Sources, each with a test: M24's `SimHost.onFatal` (tick-panic recurrence, failed `memory.grow`), `Storage.onError` (0005 Storage), the loop guards above. Afterwards the engine stops ticking, keeps every file untouched, and `dispatch` returns a rejected result. Server: `HostServices.onFatal?` from M27's ADR, then `stop()`; sockets close and clients fall into the ordinary reconnect policy (0013), so a fixed deploy is picked up by the version-mismatch path with no new message.
- **Desync event** (M31b's hand-over): `client.onDesync(cb: (r: DesyncReport) => void)` fed from M31b's report ring, rate-limited to one call per report; the host-side twin is a field on the server's stats, not an event.
- **Event-surface audit** (table below). One `unit` test, `engine event surface`, (a) type-asserts every member on the public `Client`, `EngineStartError` and `HostServices` types and (b) asserts the named behaviour test for each row exists in the test tree. Events landed earlier are audited, not rebuilt; a missing or untested one gets the smallest fix and a line in Deviations.
- **Reference game:** extend `games/reference/src/ui/status.ts` (M34, M34b) to cover every row: `world-busy`, `save-incompatible` (Export, Delete), `durable: false` notice, storage line, link states incl. `resyncing` / `updating` / `superseded`, `rendererLost` reload prompt, `onFatal` screen with the message, a dev-only desync counter. Plain text, one button each.
- **Dev reload keeps the world:** `dev-reload-keeps-world @slow` (Planning decisions).

## Non-scope
Sim-*instance* recovery, `Skip`, `EngineFault` (M24). Migration (M24b). Storage lifecycle, export/import (M23). Handshake, epochs, `Lost` (M28, M28b). Link state machine (M29). Hash comparison and `ResyncChunk` (M31b). Device loss and `rendererLost` (37b). `checkSupport` (M35). Any snapshot-on-reload mechanism.

## Files, packages and crates touched
`packages/engine` (`src/worker/{client,gen,shell}.ts`, `src/client.ts`, `src/server.ts`, `src/test.ts`, tests), `games/reference` (`src/ui/status.ts`, bootstrap). Fixture `panicky` (M24) gains client-role and gen-role trap hooks if it lacks them; no engine-crate change otherwise.

## Seams
**Provides:** `client.onFatal`, `client.onDesync`, `DesyncReport` (TS mirror of M31b's record); `TestFlags` `trapClientAtFrame`, `trapGenAtChunk`, `killSimWorkerAtTick`; `src/engine-events.test.ts` (the audit); ADR "Engine failure surface".
**Consumes:** `EngineTrap`, `dead`, `panicMessage`, `instantiate` (M02); `shell.fatal`, setup message, `EngineStartError`, kept `Module` (M06b); `SimHost.onFatal`, `onRecovered`, `recover()`, fixture `panicky` (M24); `'save-incompatible'` (M24b); `client.onStorage`, `StorageStatus`, `world-busy`, `exportWorld` / `importWorld` (M23); `HostServices.onFatal?`, `nodeHostServices`, `WorldServer` (M27); `createLink`, `CloseCode` (M28); second-`Welcome` resync, `Resyncing`, `Lost` (M28b); link events, `client.onVersionMismatch` (M29); desync report ring (M31b); `client.onRendererLost` (37b); `status.ts` (M34, M34b); injected `Clock` (M03); plugin dev server and `watchCrate` (M02b).

Audit table (ADR name → owner → landed by; the behaviour test's name is filled in by the session):

| Event | ADR | Milestone |
|---|---|---|
| `SaveIncompatible` | 0005 Upgrades | M24b |
| `WorldBusy` | 0005 Storage | M23 |
| `durable: false`; storage estimate `{ persisted, usage, quota }` | 0005 Storage | M23 |
| `Resyncing` | 0005 Panic recovery | M24, M28b |
| `onFatal` | 0005, 0015 §5 | M24 (host), **M37** (surface, servers, guards) |
| `rendererLost` | 0018 §8 | M37b |
| version mismatch → reload once → `updating` | 0013 | M29 |
| `exportWorld` / `importWorld` | 0005 Storage | M23 |
| also promised by ADRs though absent from PRE-PLAN §4: `EngineFault` and `Lost` action results (0005, M28b), `superseded` stopping auto-reconnect (0013), reconnect indicator delay (0013), desync report (0013) | | M24, M28b, M29, **M37** |

## Planning decisions
- **One delivery path, names as landed.** The briefs disagree on the carrier: M23 specifies `client.onStorage` plus `EngineStartError` codes, while M28b, M29 and M34b refer to an `EngineEvent` union on `client.onEngineEvent` that no brief defines. Rule for this session: whatever landed is kept; if a union carrier exists, `onFatal`, `onDesync` and `onRendererLost` are thin registrations filtering it, so there is one queue and one ordering; if only per-event registrations exist, add no union. Unify call sites only if fewer than about ten change; otherwise record it for Phase 4. Start failures stay rejections of `client.ready` (M06b), never events.
- **Snapshot → reload → restore on Rust edit (0017, deferred to Phase 3): decided now, do not build.** Persistence already is that mechanism. A Rust edit changes the build hash; on reload the single-player world takes 0005 "Upgrades": latest snapshot, log tail re-executed under the new code, new segment. No admitted action is lost; at most the action-free progress since the last snapshot is, which 0005's loss-window table accepts, and `pagehide` usually snapshots anyway. What does not survive is client-only state (camera, open menus), which a game can keep in `sessionStorage` through `client.camera.read` / `moveTo`; the reference game does not. A dev-only in-memory hand-off would be a second restore path to keep correct. Proof: `dev-reload-keeps-world @slow`: plugin dev server on a copy of a persistent fixture in a temp dir (M02b's rule: never edit tracked files), perform actions, edit a `.rs` line that changes the module bytes but not the state layout, await `full-reload`, assert the actions' effects are present and the tick did not go backwards. A layout change without a `SCHEMA_VERSION` bump is the author's error and surfaces as `save-incompatible` (M24b's test, audited here). If the test cannot pass, the decision reopens as a plan edit.
- **`rendererLost` is not `onFatal`.** A reload fixes the first and the sim keeps saving; the second means the world is wedged under this build.
- **A fatal server adds no protocol.** It reports through `HostServices.onFatal`, stops, and closes sockets; clients reconnect with backoff until a fixed build answers with a version mismatch. A close code that stops reconnection would strand players when the deployer's supervisor brings up the fix.
- **ADR "Engine failure surface"** (next free number) records the four decisions above and the final event table, and links M27's `HostServices.onFatal` ADR instead of repeating it.

## Order of work
1. Trap hooks in `panicky`; client-role reaction; gen-role reaction. 2. Sim-worker respawn; loop guards. 3. `client.onFatal` + sources; server path. 4. `client.onDesync`. 5. Audit test; close gaps. 6. `status.ts`. 7. `dev-reload-keeps-world`. 8. ADR, context artifacts.

## Tests added
`browser`: `trap: client instance recovers and resyncs` (replica hash equals host hash afterwards; main kept presenting), `trap: gen instance recovers and chunk arrives`, `trap: gen twice is fatal`, `sim worker death respawns and resyncs` (no admitted action lost, by log comparison), `fatal: two client traps`, `fatal: storage error` (files byte-identical afterwards), `reference: status walks every event` (driven by `TestFlags`). `netcode`: `fatal: server onFatal stops world and closes sockets`, `trap: headless client resyncs`. `unit`: `engine event surface`. Slow: `dev-reload-keeps-world @slow`.

## Exit criteria
- [ ] The trap, respawn and fatal tests above pass by name; the M04 zero-GC tests still pass untouched (healthy path unchanged).
- [ ] `pnpm test unit -t "engine event surface"` passes with every table row present and every named behaviour test found.
- [ ] The reference game shows a distinct, test-visible state for each event.
- [ ] `pnpm test:slow -t dev-reload-keeps-world` passes; the ADR "Engine failure surface" exists.
- [ ] `grep -n postMessage packages/engine/src` still shows only M06b's lifecycle messages plus M23's.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm lint` · `pnpm test browser -t "trap:"` · `pnpm test -t "fatal:"` · `pnpm test unit -t "engine event surface"` · `pnpm test:slow -t dev-reload-keeps-world`

## Budgets
PRE-PLAN §7 "Allocation per isolate": unchanged zero-GC tests (recovery is a rare discontinuity, 0016 §2). "Test suite": every new test within the 0020 §4 p95 limits; guards use the injected clock, never real time.

## Context artifacts
`packages/engine/CLAUDE.md`: where the audit test lives and the rule "a new engine-to-game event adds a row and a behaviour test". `games/reference/CLAUDE.md`: `status.ts` is the one place engine events are handled. No new skill or rule file.

## Manual device checks
none of its own (37b carries the device entry).

## Deviations
(filled in during Phase 3)
