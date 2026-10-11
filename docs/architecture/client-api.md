# Client API

The TypeScript surface a game programs against: `createClient` and the `Client` it returns (`packages/engine/src/client.ts`, main thread only, never instantiates WASM: `main.no_wasm_instantiate`), the engine events a game can subscribe to, `checkSupport` (`src/support.ts`), and the package's `exports` map. The Rust side a game writes is the `Game` trait and `ClientSide` (`crates/engine/src/client/texel.rs`, `FrameView` in `client/frame_view.rs`, `FrameCx` in `client/frame_cx.rs`); the client reaches it only through rings and SAB blocks ([threads-and-boundary.md](threads-and-boundary.md)). The worked example is `games/reference/src/`: `main.ts` (entry), `mode.ts` (host choice), `game.ts` (`startGame`: wiring), `ui/*.ts` (DOM panels), `bindings/*.ts` (generated types).

Renderer: [renderer.md](renderer.md). Camera, input, picking, overlay (`client.camera`, `client.input`, `client.pick`, `client.overlay`): [camera-input-overlay.md](camera-input-overlay.md). Wire, sessions, prediction internals: [sync-and-netcode.md](sync-and-netcode.md). Storage and `exportWorld`: [persistence.md](persistence.md).

## Starting a client

`createClient(options): Client` is synchronous; spawning workers is asynchronous and tracked by `client.ready`. On a page that is not cross-origin isolated it does not throw: it returns a stub `Client` whose `ready` rejects with `EngineStartError('not-isolated')` and whose `uploadRing`/`writeCameraAndWake` throw it. `ClientOptions`:

- `canvas`, `wasm: { url, buildHash }` (the default export of `virtual:engine/wasm`, typed by `engine/virtual`).
- `host`: `{ kind: 'local', world: WorldConfig, connect?, persist? }` runs a sim worker in the tab (single-player). `connect: true` links the client worker to it over a ring pair, which is the real single-player topology; unset gives a zero-connection sim for tests. `persist: true` adds Web Lock, OPFS and recovery. `{ kind: 'remote', url, joinKey? }` dials a server through a net worker; the world comes from `Welcome` ([0042](../decisions/0042-remote-client-world-config-from-welcome.md)). `WorldConfig` is the server's, minus `buildHash`, which `createClient` fills.
- `createWorker` (pattern B, [0017](../decisions/0017-packaging-and-build.md) §3: the game builds the worker itself with `engine/worker`'s `run()`), `arenas`, `genWorkers` (default 2 when `hardwareConcurrency >= 8`, else 1), `cameraKey`.
- `assets: { tiles, sprites? }` and `render: RenderOptions`: stored for the renderer helpers in `engine/render`; `createClient` does not read them. `overlay: OverlayOptions`.
- `test`: clock, scheduler and flags for `engine/test`; a game never sets it.

`readInvite(location)` parses `#k=<joinKey>`; `wsUrl(location)` gives `ws(s)://<host>/ws`; the reference game's `selectHost` combines them (no key: a local world; key: remote).

## What a game gets

- **`client.ready`** resolves when the worker set is up, and for `{ local, connect: true }` also when the session is live. For a remote host it does not wait for a `Welcome` (a bad key or a dead server would hang it): use `onLink` `'online'`. Start failures reject it with `EngineStartError` (`code`: `not-isolated`, `worker-blocked`, `compile-failed`, `abi-mismatch`, `arena-config`, `worker-fatal`, `world-busy`, `load-failed`, `save-incompatible`; `detail` carries `{ reason, stored, running }` for `save-incompatible`). They are never events. After `load-failed`/`save-incompatible`, `exportWorld`/`deleteWorld` still work.
- **`dispatch(action): number`** JSON-encodes the action into the action ring and returns its `seq`, which main assigns itself (seeded from `Welcome`, never reset while the page lives). The parameter is `unknown`: type the call with the game's generated `Action` binding. It throws `engine: dispatch before ready` before the session is live, and `engine: action queue full` when more than 32 actions are unacked or the ring is full (the seq counter does not advance). Never queued, never waits on the connection ([0066](../decisions/0066-phase-3-decisions-client-renderer-input.md) §5). JSON encoding is allowed here (human rate, exempt from [0016](../decisions/0016-zero-gc-definition.md)); the zero-GC path is `engine/test`'s `dispatchRaw`. `FrameCx` has no `dispatch`: a Rust client cannot issue actions. After `onFatal`, `dispatch` still returns a seq whose result is `Rejected: { Engine: 'EngineFault' }`.
- **`onActionResult<Reject>(cb(seq, outcome))`** delivers one `ActionOutcome` per action, in ring order, never coalesced: `'Confirmed'`, `{ Rejected: { Game: Reject } }`, `{ Rejected: { Engine: 'RateLimited' | 'StateBudgetFull' | 'EngineFault' } }` (hand-mirrored `EngineRejectReason`), `'NotPredictable'`, `'Lost'`. `Lost`: the host processed the action but its ack died with the old connection; the resync shows the outcome in state.
- **`onUi<Ui>(cb(ui))`** is how a game reads state. The client worker calls `ClientSide::ui` into a reused `G::Ui`; when it differs (`PartialEq`) the engine writes its JSON to the UI ring, and main calls `cb` with the newest value at most once per rAF. Within one drain `onUi` fires before `onActionResult` ([0066](../decisions/0066-phase-3-decisions-client-renderer-input.md) §6). There is no pull-style read of replica state from TypeScript; only what `ui` publishes. Per-frame values (anchors, camera, progress) do not travel in `Ui`: use `client.overlay`, `client.camera.read`, and `client.clock()`.
- **`clock(): ClockSnapshot`** returns one reused object `{ authoritative, predicted, ticksPerSecond, tickFraction }` (ticks, not seconds). Do not keep it past the next call. `authoritative + tickFraction` is the host-clock estimate, which keeps moving between frames ([0073](../decisions/0073-own-timer-bars-on-the-host-clock.md)). A progress bar is derived from a `done_at` tick in `Ui` and this pair; a player's own timer runs until `authoritative + tickFraction` reaches its predicted `done_at` (the reference game's `src/ui/own-timer.ts`). `revealed()` is true once every chunk of the visible rectangle is held and generated; the frame loop uses it to gate terrain drawing.
- **Provisional and predicted status.** TypeScript is told only `'NotPredictable'` (once, at dispatch: no ghost, not a rejection). A local predicted `Rejected` is a hint that is never surfaced as an outcome; only the host's ack produces `Confirmed`/`Rejected`. Predicted state (overlay over replica) is visible to the game only through `ClientSide::ui`/`extract` reading `FrameView`. A provisional entity id (bit 31 set) must never be put into an action: address a predicted entity by tile ([0022](../decisions/0022-entity-ids-and-provisional-ids.md) §5-6, [.claude/rules/prediction.md](../../.claude/rules/prediction.md)). The reference game's `ui/build.ts` ignores `NotPredictable` and waits for the ack.
- **World operations (single-player only):** `exportWorld(): Promise<Blob>`, `importWorld(bytes, { worldId?, overwrite? })` (never loads it; refuses the running id), `deleteWorld(worldId)` (refuses the running id). All reject with `NotSinglePlayer` when there is no sim worker.
- `destroy()`, and the free function `attachHostLifecycle(client)`, which snapshots and flushes a persisted world when the tab hides and returns a disposer.
- Pass-through members for the renderer helpers: `drawListSlot`, `uploadRing`, `assets`, `cameraState`, `writeCameraAndWake`, `setFlags`, `raiseRendererLost`, `debug.linkLog()`.

## Engine events

One style: `client.on<Name>(cb)` returning an unsubscribe function. There is no `EngineEvent` union ([0050](../decisions/0050-engine-failure-surface.md) §1). `src/engine-events.test.ts` (`engine event surface`, unit suite) audits the list: a new event adds a row with its behaviour tests and the reference game's answer (`games/reference/src/ui/status.ts`, wired in `game.ts`).

| Member | Payload | Fires |
|---|---|---|
| `onLink` | `{ state, reason? }` | Remote hosts only. `state`: `connecting`, `online` (a `Welcome` applied and session live), `reconnecting` (only after the 1 s indicator delay, [0013](../decisions/0013-sessions-and-integrity.md)), `updating` (build mismatch survived one reload), `superseded` (same player took over; no auto-reconnect), `rejected` with `reason` `BadKey`, `Full` or `WorldMismatch`. The game stays interactive on last-known state while `reconnecting`. |
| `onVersionMismatch` | none | Replaces the default handler (reload once, guarded by `sessionStorage['engine.reloadedFrom']`, then `updating` and backoff). One handler, not a list; the unsubscribe restores the default. Remote only. |
| `onResyncing` | none | A second `Welcome` on an online session (host restart, panic recovery, upgrade). Linked topologies only. |
| `onDesync` | `DesyncReport` (`src/desync.ts`: `tick`, `scope` `chunk`/`global`/`ownPlayer`, `cx`, `cy`, `hostHash`, `clientHash`) | Once per report, after the frame that carried the hash; the resync is already requested. Not replayed to a late subscriber. Linked topologies only. |
| `onFatal` | `{ tick, message }` | At most once: the world cannot continue (second tick panic, failed `memory.grow`, storage write failure, repeated instance traps, a chunk trapping a gen worker twice). The engine stops ticking. A listener added later is called at once. Servers: `HostServices.onFatal`. |
| `onStorage` | `StorageStatus` `{ durable, persisted, usage, quota }` | `{ local, persist: true }` only: at load, after the persist() answer, after each hidden-boundary snapshot. |
| `onRendererLost` | `{ reason: 'no-adapter' \| 'repeated-loss' }` | The renderer gave up after a WebGPU device loss ([0018](../decisions/0018-renderer.md) §8); sim and link continue; the game offers a reload. |

`onUi`, `onActionResult`, `onLink` and the other non-fatal events do not replay, so subscribe synchronously after `createClient` and before the first `await` (`startGame`'s `onClient` hook exists for this).

## Support check

`checkSupport(): Promise<SupportReport>` returns `{ ok, failures, warnings }`. Failure `code`s: `not-isolated`, `no-sab`, `no-wasm`, `no-module-worker`, `no-webgpu`, `no-adapter`, `limits-too-low` (4096 px texture edge, 256 layers). Warnings (the game runs with less): `no-opfs` (a world is `durable: false`), `no-web-locks` (no cross-tab lock). A game branches on `code`, never `message`. The reference game shows `ui/capability.ts` before touching WebGPU or workers. Tier 1 is current and previous Chrome (desktop, Android) and Safari (macOS, iOS 26+); Tier 2 is Firefox desktop; anything else gets the capability screen (Tyler's requirement; the checks above are what enforce it).

## No engine UI

The engine renders no UI widgets: game UI is a game-owned DOM overlay. The engine supplies world-to-screen transforms, tile/entity picking, anchoring (`client.camera`, `client.pick`, `client.overlay`) and the low-GC `onUi` stream. `src/no-engine-ui.test.ts` scans `src/` and fails if engine code builds DOM beyond the page stylesheet/viewport meta (`input/page-css.ts`) and the anchor layer `div` (`overlay/anchors.ts`); it never sets text or markup.

## Package exports

`packages/engine/package.json` `exports` (pinned by `src/exports-map.test.ts`; add a subpath only with the file behind it):

| Import | File | For |
|---|---|---|
| `engine` | `client.ts` | `createClient`, `Client` and its types, `EngineStartError`, `NotSinglePlayer`, `checkSupport`, `attachHostLifecycle`, `readInvite`, `wsUrl` |
| `engine/render` | `render.ts` | `createGpuHost`, `createRealFrameLoop`, `attachClientDrawables`, `loadTileArt`, `initDevice`, `installPageStyles`, `systemClock`/`systemScheduler`, `attachVisibilityHandling`, `createTerrainRenderer`, `createUploadDrain` ([renderer.md](renderer.md)) |
| `engine/worker` | `worker.ts` | `run()`: the one script for every worker kind (pattern B) |
| `engine/vite` | `vite.ts` | `engine()` plugin, `buildGame`, `exportBindings` ([runtime-and-hosting.md](runtime-and-hosting.md)) |
| `engine/server`, `/server/node`, `/server/bun`, `/server/deno` | `server*.ts` | `createWorldServer` and the runtime adapters, with no DOM or `node:` in the core |
| `engine/test` | `test.ts` | Test harness (`stepFrame`, `dispatchRaw`, `clientTestHandle` users). Not game API |
| `engine/virtual` | `virtual.d.ts` | Types only for `virtual:engine/wasm`; add `"types": ["engine/virtual"]` |

Everything not in the table is internal, including `client.ts`'s `clientTestHandle`, `ClientTestHandle` and the arena helpers it also exports for tests.

## Rust side, as TypeScript sees it

- `Action`, `Reject`, `Ui` and `Worldgen::Params` derive `TS`; the build writes `src/bindings/*.ts` into the game ([0017](../decisions/0017-packaging-and-build.md)). `EngineRejectReason` in `client.ts` is the hand-mirrored TS type of the Rust `EngineReject` (`sim/mod.rs`). Adding an action end to end: [add-action-type](../../.claude/skills/add-action-type/SKILL.md); bump `SCHEMA_VERSION`.
- `ClientSide<G>` (`Default`, never replicated or hashed): `frame`, `extract`, `tile_visual`, `ui`, and `on_init(seed, params)`, called exactly once after `Default` ([0035](../decisions/0035-clientside-on-init.md), amended by 0042 for remote clients). Its `ui` output is the `onUi` payload; `client/ui.rs` holds the Rust side of the diff (changed value, then JSON to the UI ring). Other `client/` modules: `core.rs` (`ClientCore`, prediction and outbox), `replica.rs`, `camera.rs`, `input.rs`, `drawlist.rs`, `upload.rs`, `terrain_feed.rs`, `remote_presence.rs`, plus `texel.rs`, `frame_cx.rs`, `frame_view.rs` above. Genesis writes are unlogged and may arm timers ([0046](../decisions/0046-genesis-writes-unlogged-and-timers.md)); that is host-side and invisible here.
- The design of `Game`, `WorldRead`/`WorldWrite` and `Unknown`: [0003](../decisions/0003-game-facing-api.md) (amended by 0023, 0024 §7/§9, 0046).

## Tests

- `unit` suite (`src/*.test.ts`): `client.test.ts` (dispatch errors, ready, queue full), `engine-events.test.ts`, `support.test.ts`, `exports-map.test.ts`, `no-engine-ui.test.ts`.
- `browser` suite (`packages/engine/tests/browser/`): `mp.spec.ts` (link events), `framecx.spec.ts` and `puts-ui.spec.ts` (Ui and results), `prediction-no-flicker.spec.ts`; `games/reference/tests/browser/` (`status.spec.ts` walks every event, `capability.spec.ts`, `*-flow.spec.ts`). `scripts/suites.mjs` registers them.

## Gotchas

- `dispatch` is main-thread and synchronous; never call it from a hot path or a per-frame callback.
- `onUi` is coalesced newest-wins; do not infer events from it. Compare values or use action results.
- `Ui` equality is Rust `PartialEq`, so a field that changes every frame defeats the "no garbage while nothing changes" property ([0003](../decisions/0003-game-facing-api.md)).
- A listener that must see `onLink`/`onUi` from the start registers before any `await`.
