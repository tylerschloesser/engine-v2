# M29: Net worker and reference server

Status: not started · After: 28b · Tyler-dependent: no (device check attached, non-blocking)

## Goal
Multiplayer runs in a browser: `createClient` with a remote `host` spawns a TypeScript net worker that owns the WebSocket and reconnect timing and pumps bytes between the socket and the client worker's rings, against a Node process built from `engine/server/node` + `ws`. The net worker's heap budget is asserted, a subset of the netcode suite runs over loopback `ws` with byte-identical traces, and `games/reference-server` exists as the deployable package.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0015-threads-memory-and-topology.md` (§1 net worker row and single- vs multiplayer, §2 rings, backpressure, wake-ups, what `postMessage` may carry)
3. `docs/decisions/0013-sessions-and-integrity.md` (Client policy, Build-hash handshake)
4. `docs/decisions/0016-zero-gc-definition.md` (net worker row and paragraph; assertions A and B)

Also cited, open only if needed: 0009 (Node: structural `ws` typing), 0020 §7 (loopback subset) and Consequences (spike C). Mine from spikes: `spikes/zero-gc-webgpu/` (worker CDP sessions, `postMessage` negative control), `spikes/cross-origin-sab/` (ring). Rules that apply: `.claude/rules/hot-paths.md`. Skill: `gc-test`.

## Scope
- **Net worker kind** in `engine/worker` `run()`: `createBytePump` (M27) + `createLink` (M28) + `wsConnection(url)`; event-driven, uplink drained on a `setInterval` (0015 §2). It never parses a message: reconnect policy comes from `CloseEvent.code` (`CloseCode`, M28), liveness from "any message on the current socket". A full downlink ring queues in the worker's own heap (0015 §2); `drops` stays 0.
- **`wsConnection(url): Connection`**: the browser `WebSocket` as a client-side `Connection` (0009 settings: binary, `arraybuffer`). The same function runs under Node 22's global `WebSocket` for the loopback tests, so the tests cover the shipped wrapper.
- **Lifecycle messages only** (0015 §2), added to M06b's setup-message family: net → main `{ type: 'link', state, code? }` on transitions; main → net `{ type: 'probe' }` on `visibilitychange → visible` and `online`, and `{ type: 'retry' }`; M06b's `stop` sends `Bye{Leave}` first. Nothing per frame. The uplink drain uses M06's poll period.
- **Remote host option:** M06b's `host: { kind: 'remote'; url }` gains `joinKey?` and becomes real: multiplayer topology of 0015 §1 (no sim worker). `readInvite(location): { joinKey }` parses `#k=`.
- **Link events:** `client.onLink(cb: (e: { state: 'connecting' | 'online' | 'reconnecting' | 'updating' | 'superseded' | 'rejected'; reason?: 'BadKey' | 'Full' }) => void)`, a per-event subscription in the style of `client.onUi` and M23's `client.onStorage` (there is no `EngineEvent` union; one reused event object). `Resyncing` is M28b's `client.onResyncing`. `reconnecting` is emitted only after the indicator delay of 0013; the game stays interactive.
- **Version mismatch:** default handler reloads once, guarded by `sessionStorage['engine.reloadedFrom'] = <own build hash>`; if the reloaded bundle has the same hash, state `updating` and `link.retry()` on the backoff schedule. `client.onVersionMismatch(cb)` replaces the default.
- **`attachWebSocketServer(wss, server)`** in `engine/server/node`, structurally typed (0009 Node); maps each socket to a `Connection`, close codes passed through; `perMessageDeflate` must be off (checked, readable error).
- **`games/reference-server`**: `ws` + Node adapter, about 60 lines. `--game <dir>` (default: the reference game's `buildGame` output), `--data <dir>`, `--import <archive>` (M23's `importWorld(storage, bytes)` before start: the single-player-to-hosted path of 0005), `PORT`, `JOIN_KEY`; exits 0 on `onIdle` when `--exit-on-idle`; exits 1 on `ready` rejection or `onFatal`. Game-agnostic so it is testable with a fixture before the reference game is multiplayer (M34).
- **Loopback subset + spike C:** `createNetHarness({ transport: 'ws' })` puts `conditionLink` around real sockets on `127.0.0.1:0`.
- **Browser tests** against a Node-side server on the manual timer of `engine/test`, stepped in lockstep with the pages.

## Non-scope
Interpolation (M30). Rates, hashes (M31, M31b). Bun/Deno adapters (M35b); pattern B for the net kind, size test (M35). Fly/Pages deploys (M38). Remaining engine events (M37).

## Files, packages and crates touched
- `packages/engine`: `src/worker/net.ts`, `src/net/ws-connection.ts`, `src/client.ts` (remote host, `Link` events, mismatch flow), `src/server-node.ts`, `src/test/net-harness.ts`, `tests/{netcode,browser}/`, `budgets.json` (`gc.pages` entry); `ws` as a devDependency for tests only
- `games/reference-server/` (new; nested `CLAUDE.md`, README with the run recipe)
- `packages/engine/fixtures/`: a multiplayer page for M16's action fixture

## Seams
**Provides:** `host: { kind: 'remote', url, joinKey? }` made real; `client.onLink`; the version-mismatch reload / `updating` flow and `client.onVersionMismatch`, `client.leave()`; `readInvite`; `wsConnection`; `attachWebSocketServer`; control-block words `CB_LINK_STATE` and `CB_LINK_GEN` (written by net; global words 4–5, reserved in M06's layout), which tell the client worker when to emit `client_hello`; harness `transport: 'ws'`; test helper `startTestServer({ fixture, manualTimer }): { url, stepTick(), stop() }` for Playwright; `client.debug.linkLog()` (test entrypoint only).
**Consumes:** byte pump, harness, `conditionLink`, `WorldServer.ready` (M27); `createLink`, `CloseCode`, `loadOrMintSecret`, `session_state` (M28); resume, `Resyncing`, `client.onResyncing` (M28b); `ClientOptions.host`, net worker idle shell, setup and lifecycle messages (M06b); rings, control block, uplink poll period (M06); `zeroGcSuite`, `gc.pages` with the `budgeted` class and `bytesPerMessage`, negative-control hook (M04); client worker shell (M15b); the lifecycle-message carrier and `client.onStorage` naming, server `importWorld` (M23); `pnpm device:serve --tunnel` (M03).

## Planning decisions
- **Spike C (PRE-PLAN §10) runs here.** Fast tier: one seed, 3 runs of a 10 s 4-client session over loopback `ws`, identical `trace()`. Slow tier: the full spike (0020 Consequences: run count and time target). If traces differ after a day's effort, the `ws` subset becomes a smoke test (join, action, reconnect) and the brief records it in Deviations; the design does not change.
- **iOS worker-socket resume (PRE-PLAN §10)** is a device check of this milestone; it tunes only the dead timeout and probe deadline of 0013. Procedure and decision rule below.
- **Close codes drive the pump, status words drive the client.** `Superseded` must stop reconnects before the client worker has parsed anything, otherwise two tabs fight at backoff step 0; the close code is available to a non-parsing worker.
- **The reload guard is keyed by the client's own build hash,** so no `Reject` parsing is needed on main and a second deploy during the session still gets its one reload.
- **GC test pacing.** Frames are stepped, so traffic is too: the test steps the server one tick, awaits the downlink ring counter, steps a frame, for the 0016 window. Real 20 Hz pacing would cost 30 s.

## Order of work
1. `wsConnection`, `attachWebSocketServer`, harness `transport: 'ws'`, loopback subset, spike C.
2. Net worker kind, control-block words, remote `host` in `createClient`.
3. `games/reference-server` + its smoke test.
4. Browser: two-page test, reconnect test, mismatch flow.
5. Zero-GC multiplayer topology test + negative control.

## Tests added
Netcode (`ws`): `ws/join-converges`, `ws/reconnect-resume`, `ws/version-mismatch`, `ws/trace-identical`; slow: `ws/spike-c`. Node: `reference-server/smoke` (spawn, headless client joins over `ws`, `--exit-on-idle` exits 0 after the idle path). Browser: `mp/two-pages` (action on A, converged replica on B), `mp/reconnect` (server-side socket kill → `reconnecting` → `online`, pending action applied once), `mp/superseded` (second page, same storage state; first gets `Link` `superseded` and opens no socket), `mp/version-mismatch-reloads-once` (then `updating`), `mp/coep-worker-error-message` unchanged from M06, `gc/multiplayer-topology` (0016 budgets for main, client, gen, net; `memory.buffer.byteLength` unchanged), `gc/net-negative-control` (an injected per-message parse in the net worker fails that isolate only).

## Exit criteria
- [ ] Named tests pass; `gc/multiplayer-topology` is a `zeroGcSuite` page whose ceilings come from `budgets.json` `gc.pages`.
- [ ] `grep` test: no frame parsing in `src/worker/net.ts` (no `DataView`, no imports from the codec).
- [ ] `node games/reference-server --game <fixture dir>` serves two browser tabs by hand.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test netcode -t ws/` · `pnpm test browser -t mp/` · `pnpm test browser -t gc/` · `pnpm test:slow -t spike-c` · `pnpm lint`

## Budgets
PRE-PLAN §7 "Allocation per isolate" (net worker row and the unchanged main/client rows under multiplayer): `gc/multiplayer-topology`. "Test suite": browser and netcode suite budgets still met (apply the demotion rule of 0020 §4 to `ws` repeats first).

## Context artifacts
`games/reference-server/CLAUDE.md`; `gc-test` skill: the multiplayer topology and lockstep pacing; `.claude/rules/hot-paths.md` globs extended to `src/worker/net.ts`.

## Manual device checks
[device-checks.md, M29: Net worker and reconnect](device-checks.md#m29-net-worker-and-reconnect).
This milestone builds the fixture multiplayer page with `?linklog=1` (an on-page view of `client.debug.linkLog()`), and the server's `/ws` proxied on the HTTPS origin of `pnpm device:serve --tunnel` (M03), since an `https` page cannot open `ws://`.

## Deviations
