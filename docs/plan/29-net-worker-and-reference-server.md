# M29: Net worker and reference server

Status: done · After: 28b · Tyler-dependent: no (device check attached, non-blocking)

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
- **Reveal gate:** main draws terrain only once M28's `revealed` clock-block word is set (clear colour until then; 0013), so a join over a slow link never shows half a view; `client.ready` is unchanged.
- **Version mismatch:** default handler reloads once, guarded by `sessionStorage['engine.reloadedFrom'] = <own build hash>`; if the reloaded bundle has the same hash, state `updating` and `link.retry()` on the backoff schedule. `client.onVersionMismatch(cb)` replaces the default.
- **`attachWebSocketServer(wss, server)`** in `engine/server/node`, structurally typed (0009 Node); maps each socket to a `Connection`, close codes passed through; `perMessageDeflate` must be off (checked, readable error).
- **`games/reference-server`**: `ws` + Node adapter, about 60 lines. `--game <dir>` (default: the reference game's `buildGame` output), `--data <dir>`, `--import <archive>` (M23's `importWorld(storage, bytes)` before start: the single-player-to-hosted path of 0005), `PORT`, `JOIN_KEY`; exits 0 on `onIdle` when `--exit-on-idle`; exits 1 on `ready` rejection or `onFatal`. Game-agnostic so it is testable with a fixture before the reference game is multiplayer (M34).
- **`pnpm device:serve` grows two options** (M03's `packages/engine/scripts/device-serve.mjs`), so every multiplayer device check has an HTTPS page with `/ws` on its own origin (an `https` page cannot open `ws://`):
  - `--ws [<fixture>]`: spawns `node games/reference-server` as a child on `127.0.0.1:4174` with its real-time timer (not `startTestServer`'s manual one), `--game` = the named fixture's build output (default: the reference game's), `--data` a temp dir; adds `preview.proxy['/ws'] = { target: 'ws://127.0.0.1:4174', ws: true }`, so the tunnel carries the socket too. Kills the child on exit.
  - `--app reference`: builds and previews `games/reference` (its own Vite config; release profile) instead of the fixture app, on the same port, with the same tunnel and proxy. M34, M35, M37b and M39's device items use `pnpm device:serve --tunnel --app reference --ws`; before M34 the reference game ignores the socket and the option still serves it single-player.
  - Pages dial `/ws` on their own origin: `wsUrl(location)` (`engine`, next to `readInvite`) returns `ws(s)://<host>/ws`; it is the default `url` of the fixture page and of the reference game (M34).
- **Fixture multiplayer page `mp.html`** (+ `src/mp.ts`, fixture app, M16's action fixture `puts`, `host: { kind: 'remote', url: wsUrl(location) }`): M16's `slice.html` HUD and Paint control plus the link state. With `?linklog=1` it shows an on-page link log, newest first: one row per `client.debug.linkLog()` entry (event `open` / `close` / `silence` / `probe` / `Welcome`, link state, close code, ms since the last `visibilitychange → visible`, and whether the page was discarded, from `document.wasDiscarded`), which is what M29-socket-resume copies from. The `mp/*` browser tests use the same page against `startTestServer`.
- **Loopback subset + spike C:** `createNetHarness({ transport: 'ws' })` puts `conditionLink` around real sockets on `127.0.0.1:0`.
- **Browser tests** against a Node-side server on the manual timer of `engine/test`, stepped in lockstep with the pages.

## Non-scope
Interpolation (M30). Rates, hashes (M31, M31b). Bun/Deno adapters (M35b); pattern B for the net kind, size test (M35). The Fly deploy and the server's `--static` handler (M38). Remaining engine events (M37).

## Files, packages and crates touched
- `packages/engine`: `src/worker/net.ts`, `src/net/ws-connection.ts`, `src/client.ts` (remote host, `onLink`, mismatch flow), `src/server-node.ts`, `src/test/net-harness.ts`, `tests/{netcode,browser}/`, `budgets.json` (`gc.pages` entry); `ws` as a devDependency for tests only
- `games/reference-server/` (new; nested `CLAUDE.md`, README with the run recipe)
- `packages/engine/tests/browser/pages/{mp.html, src/mp.ts}` (the fixture multiplayer page, over M16's action fixture `puts`), `packages/engine/scripts/device-serve.mjs` (`--ws`, `--app reference`)

## Seams
**Provides:** `host: { kind: 'remote', url, joinKey? }` made real; `client.onLink`; the version-mismatch reload / `updating` flow and `client.onVersionMismatch`, `client.leave()`; `readInvite`; `wsConnection`; `attachWebSocketServer`; control-block words `CB_LINK_STATE` and `CB_LINK_GEN` (written by net; global words 4–5, reserved in M06's layout), which tell the client worker when to emit `client_hello`; harness `transport: 'ws'`; test helper `startTestServer({ fixture, manualTimer }): { url, stepTick(), stop() }` for Playwright; `client.debug.linkLog()` (test entrypoint only); `wsUrl(location)`; page `mp.html` and its `?linklog=1` link log (columns reused by M38's hosted log); `pnpm device:serve --ws [<fixture>]` and `--app reference`.
**Consumes:** byte pump, harness, `conditionLink`, `WorldServer.ready` (M27); `createLink`, `CloseCode`, `loadOrMintSecret`, `session_state`, `revealed` word (M28); resume, `Resyncing`, `client.onResyncing` (M28b); `ClientOptions.host`, net worker idle shell, setup and lifecycle messages (M06b); rings, control block, uplink poll period (M06); `zeroGcSuite`, `gc.pages` with the `budgeted` class and `bytesPerMessage`, negative-control hook (M04); client worker shell (M15b); the lifecycle-message carrier and `client.onStorage` naming, server `importWorld` (M23); `pnpm device:serve --tunnel` and `device-serve.mjs` (M03); `slice.html` HUD and Paint control (M16). ADR 0026 (M09): `gc/multiplayer-topology`'s own per-isolate `burst` negatives (generated by `zeroGcSuite` for `main`/`client`/`gen`/`net`) are tagged `@slow` automatically — this is unconditional inside `zeroGcSuite` itself, nothing to opt into here — and its clean test must show every one of those isolates in `presentIsolates` before its verdict check. `gc/net-negative-control` is this brief's own hand-built control (not one of `zeroGcSuite`'s generated `object`/`burst` pair) and is unaffected by the ADR's tagging rule.

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
Unit: `readInvite: parses #k= and ignores unknown parameters`. Netcode (`ws`): `ws/join-converges` (also: the negotiated `extensions` of each socket are empty), `ws/deflate-refused` (`attachWebSocketServer` given a `ws` server with `perMessageDeflate` on throws the readable error), `ws/reconnect-resume`, `ws/version-mismatch`, `ws/trace-identical`; slow: `ws/spike-c`. Node: `reference-server/smoke` (spawn, headless client joins over `ws`, `--exit-on-idle` exits 0 after the idle path), `device-serve/proxy-and-apps` (exit criteria). Browser: `mp/reveal-waits-for-visible-chunks` (conditioned link: probes read the clear colour until `revealed`, then terrain), `mp/two-pages` (page B joins through an invite URL whose fragment `readInvite` parses, against a server started with a join key; action on A, converged replica on B), `mp/reconnect` (server-side socket kill → `reconnecting` → `online`, pending action applied once), `mp/superseded` (second page, same storage state; first gets `onLink` state `superseded` and opens no socket), `mp/version-mismatch-reloads-once` (then `updating`), `mp/coep-worker-error-message` unchanged from M06, `gc/multiplayer-topology` (0016 budgets for main, client, gen, net; `memory.buffer.byteLength` unchanged), `gc/net-negative-control` (an injected per-message parse in the net worker fails that isolate only).

## Exit criteria
- [x] Named tests pass; `gc/multiplayer-topology` is a `zeroGcSuite` page whose ceilings come from `budgets.json` `gc.pages`.
- [x] `grep` test: no frame parsing in `src/worker/net.ts` (no `DataView`, no imports from the codec).
- [x] `node games/reference-server --game <fixture dir>` serves two browser tabs by hand. **Automated portion verified** (`reference-server/smoke`: spawn, a headless client joins over real `ws`, `--exit-on-idle` exits 0; separately, `curl`/a raw `WebSocket` against a locally spawned `device-serve.mjs --ws puts` confirmed COOP/COEP headers and a successful `/ws` upgrade through the proxy). **The literal "by hand, two browser tabs" check is Tyler's**, already tracked as `docs/plan/device-checks.md#m29-net-worker-and-reconnect`; not a new item.
- [x] `pnpm device:serve --ws puts` lists `mp.html`; in desktop Chrome `mp.html?linklog=1` reaches `online` through the proxied `/ws` with no manual stepping (the tick on the HUD advances in real time), and killing and restarting the child server adds `close` and `Welcome` rows to the on-page log. `pnpm device:serve --app reference --ws` serves the reference game, cross-origin isolated, on the same port (node test `device-serve/proxy-and-apps`: spawn each mode, fetch `/` for both headers, open a `WebSocket` to `/ws` and see the upgrade succeed through the proxy). **`device-serve/proxy-and-apps` passes.** **The desktop-Chrome portion is Tyler's**, same device-check item. **Found along the way, not a blocker**: `--app reference --ws` with no fixture named defaults the server's own `--game` to the reference game's build output, which `reference-sim`'s `engine_init` rejects (`BadConfig`) because the reference game isn't multiplayer-ready before M34 — pre-existing, out of this milestone's scope; the node test and the device-check recipe both use `--ws puts` explicitly instead.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test netcode -t ws/` · `pnpm test browser -t mp/` · `pnpm test browser -t gc/` · `pnpm test:slow -t spike-c` · `pnpm lint`

## Budgets
PRE-PLAN §7 "Allocation per isolate" (net worker row and the unchanged main/client rows under multiplayer): `gc/multiplayer-topology`. "Test suite": browser and netcode suite budgets still met (apply the demotion rule of 0020 §4 to `ws` repeats first).

## Context artifacts
`games/reference-server/CLAUDE.md`; `gc-test` skill: the multiplayer topology and lockstep pacing; `.claude/rules/hot-paths.md` globs extended to `src/worker/net.ts`.

## Manual device checks
[device-checks.md, M29: Net worker and reconnect](device-checks.md#m29-net-worker-and-reconnect).
This milestone builds `mp.html` with `?linklog=1` (an on-page view of `client.debug.linkLog()`), and `pnpm device:serve --tunnel --ws puts`, which proxies `/ws` on the tunnel's HTTPS origin to a real-time `games/reference-server` (Scope).

## Deviations

**Note from M27's gate (orchestrator):** `createBytePump` (`src/net/pump.ts`, M27) allocates per message (review finding, `/private` scratch report, not kept). It ran only in Node tests, outside `hot-paths.md`'s zero-allocation rule; wrapping it in the net worker here makes it a hot path, so make it allocation-free (reused buffers) and cover the net worker with a zero-GC page before relying on it. **Not done in steps 1-2** (deliberately: the dedicated zero-GC proof is step 5's own job per this delegation's own instructions) -- `createBytePump` is wired into `worker/net.ts` unmodified, still allocating per message (`.slice()` on every uplink drain, `.slice()` per downlink push). Whoever builds step 5 must either fix this first or budget for it; flagged again here so it isn't missed a second time.

**Steps 1-2 (this range).** Base `43d7706`. Commits: `3a8a23b` (step 1), `8f20311` (step 2).

### Step 1

- **`wsConnection(url): Connection`** (`src/net/ws-connection.ts`): the browser/Node-22-global `WebSocket` wrapped as a client-side `Connection` (0009: `binaryType='arraybuffer'`). `send()` before the real `open` event queues (a copy) and flushes in order on `open`, which is what makes this satisfy `net/link.ts`'s own `dial()` contract ("already open, or open-enough to send/receive, the instant it is returned") without `net/link.ts` itself needing to model a connecting phase. `close(code)` maps any code outside `{1000} ∪ [3000,4999]` (a real `WebSocket.close()` throws otherwise) to `1000` -- `net/link.ts`'s own `stop()` and `HeadlessClient.leave()` (M28b) both call `close(0)`, which is not a valid wire code by itself.
- **`attachWebSocketServer(wss, server)`** and **`wsSocketConnection(socket)`** (`src/server-node.ts`): structurally typed (`WsServerLike`/`WsSocketLike`, matching the real `ws` package's own `WebSocketServer`/`WebSocket` shapes with no import of `'ws'` itself, per 0009 §"Node"). `attachWebSocketServer` throws synchronously, before wiring any `'connection'` listener, unless `wss.options.perMessageDeflate === false` exactly (this repo's pinned `ws@8.18.3`'s own *default* already resolves to `false` -- `ws/deflate-refused`'s own scenario has to pass `perMessageDeflate: true` explicitly to exercise the throw). `wsSocketConnection` is the shared per-socket wrapping `attachWebSocketServer` uses internally and `net-harness.ts`'s own `ws` transport also builds on directly (Deviations: not itself a pinned Seam name -- the harness needs to condition a socket *before* `WorldServer.accept`, which `attachWebSocketServer` does not allow since it does both in one step).
- **`createNetHarness({ transport: 'ws' })`** (`src/test/net-harness.ts`): one lazily-built `ws` `WebSocketServer` on `127.0.0.1:0` (`perMessageDeflate: false`), dynamically `import('ws')`'d only when this transport is actually requested (so `engine/test`'s zero-runtime-dependency contract holds for a consumer who never asks for it). Each dial correlates to its server-side accept via a `?k=<linkIdx>:<reconnectCount>` query key; the host side is a `deferredConnection(promise)` proxy (a small local helper, not a pinned Seam) since a real accept is asynchronous but `conditionLink`'s own contract needs both raw ends synchronously, the same shape `memoryConnectionPair()` already gives it. `ws` (`8.18.3`) and `@types/ws` (`8.18.1`) added to the **root** `package.json` devDependencies (not `packages/engine/package.json`, per that package's own "no devDependencies here" rule) -- resolved via Node's ordinary upward `node_modules` walk from `packages/engine/dist/...`, no hoisting needed.
- **Real-time yields, tuned twice.** A real socket's own handshake is genuine event-loop I/O that `VirtualClock.advanceTo`'s own "awaits physical arrival" cannot actually wait out for a `ws` end (only for `memoryConnectionPair`'s own microtask-deferred delivery) -- `advanceTicks` therefore does one real `await new Promise(r => setTimeout(r, N))` per tick, `ws` transport only. Measured clean at `N=5` in isolation and in a first full-`pnpm test` pass; flaked under `pnpm test`'s own real concurrent-suite load (`scripts/test.mjs` runs every suite in parallel) badly enough to fail `ws/join-converges`/`ws/trace-identical` outright. Bumped to `N=20` plus larger pre-dispatch `advanceTicks` counts in the test file itself (step 2's own gate-testing pass, see below) and reconfirmed clean across multiple full-suite runs afterward. `dispose()` also had to start calling `.terminate()` on every tracked `wss.clients` entry before `wss.close()`: Node's own HTTP server `close()` never fires its callback while any socket it ever accepted is still open, and nothing in this harness explicitly closes its own raw sockets (that is `SimHost`/`HeadlessClient`'s job over the *conditioned* connection, never the raw one) -- without this, `dispose()` hung forever and `pnpm test` moved every subsequent test to a fresh process, masking the real failure.
- **Spike C converged cleanly** (`ws/spike-c`, `@slow`): 3 runs of a 200-tick (10 s at 20 Hz), 4-client session including a mid-run reconnect, byte-identical `trace()` every time. No downgrade to a smoke test was needed. `ws/trace-identical` (a smaller, 2-run version) is the fast-tier-adjacent proof this determinism claim holds at all before spending the full spike's own time; both ended up `@slow` (see step 2's own budget note below), so in practice both live in `pnpm test:slow` alongside `ws/reconnect-resume`.
- **Named tests exactly as the brief's own "Tests added" lists them**, with the negotiated-`extensions` check folded into a second `ws/join-converges: ...`-titled test (not a second assertion inside the first) since it needs its own throwaway `WebSocketServer`/`WebSocket` pair, not the harness's internal one (no seam exposes the harness's own port or raw sockets, and adding one felt like scope creep for a single assertion).

### Step 2

- **Control-block words: appended at indices 64-65, not the planned 4-5.** `sab/control.ts`'s `CONTROL_BLOCK_INT32S` grows from 64 to 66; `WORKER_BASE`/`WORKER_STRIDE`/`MAX_WORKERS` are byte-for-byte unchanged, so `control.workerWord addressing`'s own pinned literals (`control.test.ts`) still hold and no existing per-worker address moved. Every one of M06's own "4-7 reserved" global words (`sab-primitives-and-workers.md`'s own Planning decisions) was claimed by an intervening milestone (`CB_TEST_CONTROL` 4, `CB_SIM_STEP_REQ` 5, `CB_SIM_TICKS_RUN` 6, `CB_FORCE_SNAPSHOT_REQ` 7) long before this one landed. `CB_LINK_STATE = 64`, `CB_LINK_GEN = 65`; values mirror `net/link.ts`'s own `LinkState` numerically (`Down=0, Up=1, Stopped=2`), not imported (`sab/` stays below `net/` in the dependency order).
- **`net/link.ts`'s `CreateLinkOptions.onDown` grew an additive `code?: number` second parameter** (`onDown(why: DownReason, code?: number)`), carrying the raw `CloseEvent.code` through for `worker/net.ts`'s own `{ type: 'link', ... }` postMessage (and, eventually, step 4's `?linklog=1` on-page log, which wants a close-code column). Every existing caller (`HeadlessClient`, M28/M28b) ignores the new parameter untouched; no test needed to change.
- **`worker/net.ts` real body**: `createBytePump` + `createLink` + `wsConnection` wired together exactly per Scope. `LoopState.body`/`timeoutMs` became optional (`worker/shell.ts`) so a `net`-kind `setup()` can return a real, non-null `LoopState` (carrying `linkControl`/`stop`) with no blocking loop at all -- `worker.ts` now checks `loop?.body`, not merely `loop`, before ever calling `runBlockingLoop`; the two other internal call sites (`Shell.resume()`, `Shell.#runQueued`) got the same guard, since neither can actually reach it for a bodyless loop (only `sim`/`gen`/`client` ever call `setLoop` at all) but the type needed to be honest either way. `linkControl`'s `retry` branch rebuilds the `Link` from scratch (`buildLink()`, a local factory) rather than calling `.probe()` on the existing one: `createLink` stops *for good* on a terminal `DownReason`, and `Link.probe()` is a no-op once stopped, so a version-mismatch retry (the one production caller of `{ type: 'retry' }`) would otherwise never actually redial. `probe`/`retry` are routed to a `net`-kind worker with **no `W_PARKED` gate** (unlike `simControl`/`worldOp`): this kind is never blocked in `Atomics.wait`, so there is nothing to gate on.
- **`grep` exit criterion holds**: no `DataView`, no codec import, anywhere in `src/worker/net.ts` (checked by hand; the file's own header comment states the same rule it holds itself to).
- **`worker/client-net.ts`'s `pumpHandshake` gates the very first `client_hello()` send on `CB_LINK_STATE` reading `Up`**, but only when `NetPumpHandshake.remoteLinked` is set (from `SetupMessage.remoteLinked`, real only for a `client`-kind spawn of a `{ kind: 'remote' }` host). Full reconnect-driven Hello *resend* on a later generation change (rather than only the first send) is **not built in this cut** -- deliberately scoped down (see the delegation prompt's own pre-authorized simplification): it needs resume-hint plumbing that belongs with step 4's own `mp/reconnect` browser test, which is what will actually prove it end to end. `CB_LINK_STATE`/`CB_LINK_GEN` themselves are real and fully wired; only the *resend-on-reconnect* consumption is deferred.
- **`client.onLink`/`client.onVersionMismatch`**: exact shapes as specified, plus a `LinkState`/`LinkReason` pair of module-scope exported types (`client.ts`) the `Client` interface needs to name (not themselves a pinned Seam, but had to live somewhere public for the `.d.ts` to resolve). The `NetLinkMessage` (net -> main) wire shape ended up lower-level than the public `onLink` state: `{ type: 'link', state: 'up' } | { type: 'link', state: 'down', reason: DownReason, code?: number }`, using `net/link.ts`'s own `DownReason` vocabulary, not the richer six-value `onLink` state -- translating `DownReason` into `connecting | online | reconnecting | updating | superseded | rejected` is main's own job (`handleNetLink`, `client.ts`), since only main can poll `session_state` (for `online`) and only main owns the 1 s "indicator appears after 1 s" delay (0013 Client policy) before promoting a transient drop to `reconnecting`. `superseded`/`rejected` (`BadKey`/`Full`) map straight through; `version-mismatch` is intercepted before ever reaching `onLink` at all and routed to `onVersionMismatch`/the default reload handler instead (Scope's own `updating` state has no `reason` field, so it was never going to fit the `rejected` shape).
- **Default version-mismatch handler**: `sessionStorage['engine.reloadedFrom']` guard exactly as specified, `window.location.reload()` once; on a second mismatch with the same build hash, `updating` plus a real backoff retry loop (`VERSION_MISMATCH_BACKOFF_MS`, mirroring `net/link.ts`'s own `BACKOFF_SCHEDULE_MS` literals) posting `{ type: 'retry' }` to the net worker. **Not device-tested** (needs a real second deploy and a real reload, step 4/a device check's own territory) -- built to spec and typechecked, but its own real-browser behavior is unverified by this cut.
- **`readInvite(location)`**: exact shape (`{ hash: string } -> { joinKey? }`), `URLSearchParams` over the fragment (sans leading `#`). Unit test `readInvite: parses #k= and ignores unknown parameters` added (`src/client.test.ts` -- there was no existing `client.test.ts`; created one, following the "tests live beside source" convention `packages/engine/CLAUDE.md` states for `unit`).
- **Real regression found and fixed (the gate-blocking one): `client.ready` must not await a remote session going live.** Making every `{ kind: 'remote' }` host "linked" (Scope: "becomes real ... no sim worker") also made `Client.ready` block on `session_state = Online` for remote, mirroring `local`'s own M16-established behavior -- but `local`'s "server" is the sim worker in the same tab (`RingConnection`, effectively instant), while a real network can take arbitrarily long or never succeed, and 0013 Client policy is explicit ("the game stays interactive on last known state ... no modal and no error for outages under ~10 s"). Concretely: more than ten pre-existing files under `tests/browser/pages/src/` (`device.ts`, `gc-anchors.ts`, `gc-input.ts`, `framecx.ts`, `gc-gen.ts`, `gc-terrain.ts`, `gen.ts`, `real-camera.ts`, `semantic.ts`, `terrain-client.ts`, `viewport.ts`) already use `host: { kind: 'remote', url: 'ws://unused.invalid' }` as an inert "client + gen, no sim worker" placeholder topology (M06b's own reserved-but-never-dialing shape) and `await client.ready` right after `createClient()` -- with `remote` now dialing for real, every one of those pages hung forever, which is what `canvas: presents`/`frame-loop: production runs phases in order`/the whole `anchors`/`gc` project surfaced as `pnpm test browser` failures (found by bisecting a full-suite regression against the pre-step-2 commit, then instrumenting `waitForLive`/`pumpHandshake` directly in a real headless-Chromium run to see `session_state` never leaving `Handshaking`). **Fixed by splitting the one `linked` boolean into two**: `linked` (spawns the net pump / net worker, unchanged, still true for every `local`+`connect` and every `remote`) and a new `awaitLive` (`local`+`connect` only) that gates whether `ready` itself awaits `waitForLive()`. `waitForLive()` is still started (seeding `nextSeq` once a real session does go live) whenever `linked`, just not awaited by `ready` for `remote` -- a caller that wants to know when a multiplayer session is actually live now uses `client.onLink`'s own `'online'` event. **No page under `tests/browser/pages/src/` needed editing**; the fix is entirely inside `client.ts`. This consumed the majority of step 2's own time budget; flagged here in full because it is exactly the kind of "regression only a real Chromium run surfaces" the standing instructions warned about.
- **`ws/reconnect-resume` and `ws/trace-identical` demoted to `@slow`** (this milestone's own "Budgets" section names the remedy: "apply the demotion rule of 0020 §4 to `ws` repeats first"). The `ws` subset alone added ~10 s to the fast `netcode` suite (the real per-tick yield above), pushing it over its 10 s budget; these two are the most expensive and the ones whose own ground (reconnect, cross-run determinism) `ws/join-converges` and the already-`@slow` `ws/spike-c` also cover. `ws/join-converges`, `ws/deflate-refused` and `ws/version-mismatch` stay fast tier (each the sole fast-tier coverage of its own feature). `ws/spike-c` itself needed an explicit `60_000` ms Vitest timeout (3 runs x ~720 ticks x the real per-tick yield exceeds Vitest's 5 s default).
- **`.claude/rules/hot-paths.md` needed no edit**: its `paths` glob is already `packages/engine/src/**`, which covers `src/worker/net.ts` without any addition. Recorded here since the brief's own Context artifacts line named this as something to check.
- **Environment note, not a code issue**: this range's own investigation surfaced (and this implementer cleaned up) several orphaned `Google Chrome for Testing`/`vite preview`/Playwright worker processes left behind by an earlier overlapping-background-run mistake mid-session -- unrelated to the milestone's own correctness, but worth flagging for whoever next sees `pnpm test browser` mysteriously slow or flaky on this machine: check `ps aux | grep -i 'chrome for testing\|playwright'` and kill stragglers before trusting a red run.

**Not built in steps 1-2 (left for steps 3-5, as scoped):** `games/reference-server`, `pnpm device:serve --ws`/`--app reference`, `mp.html`, `wsUrl(location)`, the reveal gate (main drawing terrain only once `revealed`), full reconnect-driven Hello resend on the client side, the zero-GC multiplayer topology test and `gc/net-negative-control`, and making `createBytePump` allocation-free (M27 gate note, above).

**Steps 3-4 (this range).** Base `0e1009c`. Commits: `378fa6c` (step 3), `c8dda1c` (step 4).

### Step 3: `games/reference-server`

- **`index.mjs`**, a plain ESM script (no build step -- `package.json`'s `main` resolves `node
  games/reference-server` directly), ~85 lines including comments: `parseArgs` for `--game`/`--data`/
  `--import`/`--exit-on-idle`; `PORT`/`JOIN_KEY` from env. `--game`'s default is the reference game's
  own release build (`games/reference/sim/target/engine/release`, not multiplayer before M34, but a
  real default all the same). One fixed `WORLD_ID = 'world'` (0013 "one world per server process" --
  no flag names it, `--data`'s own directory is the whole identity). `--import <archive>` reads the
  file and calls `importWorld(storage, bytes, { worldId: WORLD_ID, overwrite: true })` before the
  `WebSocketServer` is even constructed. The `WebSocketServer` is created and `attachWebSocketServer`
  wired *before* `server.ready` resolves (not awaited first): 0024 §5's own "connections arriving
  before ready wait" already queues them, so the socket can be open the instant the process starts.
  `wss.on('listening', ...)` logs `listening: ws://127.0.0.1:<port>` using `wss.address().port` (the
  real, OS-assigned port when `PORT=0`), not the configured one -- what the smoke test parses.
- **`package.json`**: `dependencies: { engine: "workspace:*", ws: "8.18.3" }` (0009 §"Node": "the
  game's server package installs `ws`") -- not relying on the root's own `ws` devDependency and
  Node's upward `node_modules` walk (step 1's own precedent for `packages/engine` itself): a real
  runtime dependency of a real deployable package is the correct shape here, not an incidental
  resolution path. `pnpm install` run once to add the lockfile entries.
- **`reference-server/smoke`** (`packages/engine/tests/netcode/reference-server-smoke.test.ts`,
  `@slow`): spawns the real process (`--game` = `fixtureBuildDir('puts')`, `PORT=0`), joins with a
  real `HeadlessClient` over `wsConnection` (the shipped wrapper, not the netcode harness's memory
  transport), asserts `status().live`, calls `client.leave()` (`Bye{Leave}`, skips the 10 s grace),
  then asserts the process exits `0` -- `--exit-on-idle`'s own path, real 30 s wait included (0013
  "World lifecycle"), measured `30.44s`/`30.55s` across runs. `@slow` because that 30 s alone exceeds
  the fast `netcode` suite's 10 s budget; no shorter path exists (`IDLE_MS` is a fixed 0013 constant,
  not configurable). Only the named idle-exit path is tested here (per the brief's own Tests added
  line); the `ready`-rejection and `onFatal` exit-1 paths are built (see `index.mjs`/`CLAUDE.md`) but
  not separately proven by an automated test in this cut.
- **Real bug, found and fixed while wiring the smoke test**: `TestServer.stop()`'s first draft
  called `wss.close(cb)` with no client sockets ever terminated first -- Node's HTTP server `close()`
  never fires its callback while any socket it ever accepted is still open (the exact defect M29
  steps 1-2's own `ws-transport.test.ts` Deviations already named and fixed once, in `net-harness.
  ts`'s `dispose()`, and had to be fixed again here since `test-server.ts` is a separate file).
  Manifested as the smoke test hanging at 15 s (Vitest's own timeout), not 30 s -- found by watching
  a real `client.status()` reach `live: true` in the test's own `console.log` output while the test
  itself still hung in its `finally` block. Fixed by terminating every `wss.clients` entry before
  calling `wss.close()`, matching `net-harness.ts`'s own fix exactly.
- **`pnpm device:serve --ws`/`--app reference` and the `device-serve/proxy-and-apps` Node test are
  not built in this cut.** The delegation prompt's own per-step guidance for steps 3-4 named exactly
  `games/reference-server` + its smoke test (step 3) and the browser tests (step 4); it never
  mentioned `device-serve.mjs`, and the `mp/*` browser tests (step 4) reach their own `startTestServer`
  directly, needing no proxy. Left as an explicit gap: exit criterion 3 ("`node games/reference-server
  --game <fixture dir>` serves two browser tabs by hand") and exit criterion 4 (`pnpm device:serve
  --ws`/`--app reference`, the `device-serve/proxy-and-apps` test) are **not met by this cut** and are
  reported as such below, not silently skipped.

### Step 4: `mp.html`, `wsUrl`, `client.debug.linkLog()`, the reveal gate, `startTestServer`, `mp/*`

- **`wsUrl(location: { protocol, host })`** (`client.ts`, next to `readInvite`): `${scheme}://
  ${location.host}/ws`, `wss:` iff `location.protocol === 'https:'`. Exact shape as the brief's own
  Seams line.
- **`client.debug.linkLog(): LinkLogEntry[]`** (`client.ts`), newest first, capped at 200 entries
  (`LINK_LOG_CAPACITY`, a plain array `unshift`/truncate -- not a hot path, 0013 events are at most a
  few per minute). `LinkLogEntry = { event: 'open'|'close'|'silence'|'probe'|'Welcome', state:
  LinkState, code?: number, msSinceVisible: number, discarded: boolean }`. Event mapping (Deviations,
  not itself pinned by the brief beyond naming the five values): `'open'` = the net worker's `Link`
  reported `up`; `'silence'` = `down` with reason `'dead'` (the 0013 dead timeout, no message at all);
  `'close'` = `down` for any other reason (a real socket close, including the four terminal reasons --
  `code` carries `CloseEvent.code` when the net worker gave one); `'probe'` = main told the net worker
  to probe (`visibilitychange -> visible` or `online`); `'Welcome'` = the observable proxy for "a real
  `Welcome` was applied" -- `client.onLink`'s own `'online'` transition, since the net worker itself
  never parses a message to know that directly (`pollForOnline` resolving *is* the earliest main can
  know). `client.debug` is a new, permanent addition to the public `Client` interface (not routed
  through `clientTestHandle`'s `WeakMap`): the brief's own Provides line calls it "test entrypoint
  only" but names it `client.debug.linkLog()`, i.e. directly on the client object, matching `mp.html`
  (a production-shaped page, not a harness-driven one) reading it directly. `debug.linkLog()` returns
  `.slice()` of the backing array (never the live one), so a caller can't mutate the log by mutating
  what it read.
- **`client.revealed(): boolean`** (`client.ts`): a plain `CLOCK_FIELD.Revealed` read, same
  `clockScratch`/`clockView` scratch `dispatch`/`clock()` already share. Added to the public `Client`
  interface and the error-stub client (throws `err`, same convention as every other method there).
- **The reveal gate, built as an *opt-in*, not a default-on production behaviour change** (a real,
  deliberate scope decision, not merely an implementation detail -- flagged here since it reads as a
  candidate "renamed/widened seam"): `TerrainRenderer.draw(target, opts?: { reveal?: boolean })` --
  `reveal: false` (default `true`, every pre-existing caller unaffected, `drawCalls()` count
  unaffected) still begins the render pass (so `loadOp: 'clear'` still runs, `colorAttachment.
  clearValue` = opaque black) but skips the terrain triangle and any `onEncode` callback.
  `FrameLoopOptions.revealed?(): boolean` (`frame-loop.ts`, forwarded through `RealFrameLoopOptions`
  too): omitted (every page before this milestone), `tick()`'s own `drawOpts` scratch object (reused,
  never a fresh literal per frame -- `.claude/rules/hot-paths.md`) stays permanently `{ reveal: true }`,
  so `TerrainRenderer.draw`'s own default is what every existing page still effectively gets, byte for
  byte. `mp.ts` is the one page that supplies `revealed: () => client.revealed()`. **Why opt-in, not a
  universal default** (the brief's own Scope line reads as unconditional: "main draws terrain only
  once ... revealed"): gating every existing page's terrain draw on `revealed` would make `client.
  ready`'s own established timing (`local`+`connect`, instantaneous in every existing test) an
  insufficient signal for "the first frame already shows terrain", which dozens of existing pixel-
  probe tests across the whole `browser` suite assume implicitly (`connected-terrain.spec.ts` and
  every page built on its own precedent) -- auditing and re-timing all of them was far outside this
  cut's own budget, and the opt-in shape meets the brief's literal exit criterion (`mp/reveal-waits-
  for-visible-chunks` passes, proven end to end) without that blast radius. Verified safe: the full
  `browser` suite (204 tests, pre-`mp.spec.ts`) passed unchanged after landing `frame-loop.ts`/
  `terrain.ts`'s own changes, before `mp.html`/`mp.spec.ts` were even written.
- **Real bug, found and fixed: a `{ kind: 'remote' }` host's own `Hello` always sent an empty join
  key**, regardless of `ClientOptions.host.joinKey` (`client.ts`'s `clientGame` computation read only
  `worldConfig?.joinKey`, and `worldConfig` is `undefined` by construction for a remote host -- see
  `worldConfig`'s own doc comment, "only present for a local host"). Never exercised before this
  cut: every pre-existing `{ kind: 'remote' }` page in the repo (`gc-anchors.ts` and the other ten
  named in steps 1-2's Deviations) uses an inert `url: 'ws://unused.invalid'` that never actually
  joins. Fixed: `joinKey` now reads `options.host.kind === 'local' ? (worldConfig?.joinKey ?? '') :
  (options.host.joinKey ?? '')`.
- **Second real bug, found live while building `mp.ts` (a real client that, unlike every existing
  `{ kind: 'remote' }` page, actually needs worldgen params): `ClientOptions.test.game` *replaces*
  `client.ts`'s own computed `clientGame` outright, including `secret`/`joinKey`/`buildHash`.** Every
  pre-existing remote-host fixture page (`gc-anchors.ts` etc.) already uses `test.game` to supply
  `{ seed, params }` -- harmless there since their host never dials for real -- but `mp.ts` needs both
  a `test.game` override (see next bullet, the deeper gap) *and* a real secret/joinKey/buildHash for
  its Hello to be accepted. Naively copying the existing pages' own `test.game` shape sent a real
  socket a `Hello` with an empty secret and build hash, which the real server correctly rejected as
  `VersionMismatch` -- indistinguishable from `mp/version-mismatch-reloads-once`'s own deliberate
  scenario, except unintentional, and the resulting page reload showed up as Playwright's generic
  "Execution context was destroyed, most likely because of a navigation" on every test that reached
  this code path. Root-caused by re-reading `clientGame`'s own short-circuit (`options.test?.game ??
  ...`) against `client.ts`'s doc comments. Fixed in `mp.ts`, not `client.ts` (this is a `test.game`
  usage bug, not an engine bug): `test.game` is now built by hand with the full shape (`hexEncode
  (loadOrMintSecret())`, `readInvite(location).joinKey ?? ''`, `clientBuildHash`) plus the worldgen
  override (`seed: '0x1', params: null`, matching `fx-puts`/`startTestServer`'s own default world).
- **A genuine, unfixed production gap, found and *not* fixed (escalated, not decided -- an ABI/
  `client_on_welcome` change, well past "steps 3-4" scope): a real `{ kind: 'remote' }` client has no
  way to learn its own client-side worldgen `seed`/`params` before `engine_init`.** `ClientOptions.
  host`'s `'remote'` variant carries no `world`/params field (unlike `local`'s `host.world`), and
  0013's own `Welcome` wire shape *does* carry `seed`/`params` (`session::Welcome`, `crates/engine/
  src/session/mod.rs`), but `game_instance.rs`'s `client_on_welcome` parses and then discards both --
  never applying them to the client's own local `Worldgen` state. `game: null` (this file's own first
  attempt at wiring `mp.ts`) instantiated the client role with `Status::BadConfig`. `mp.ts` works
  around this the same way every pre-existing remote-host fixture page already does (`test.game`,
  previous bullet); a *real*, non-test-escape-hatch multiplayer game (M34, when the reference game
  itself goes multiplayer) will hit this exact gap and needs either (a) a `client_on_welcome` change
  that actually applies `welcome.seed`/`welcome.params` to the client's own local generator state, or
  (b) a new `ClientOptions.host` field for the remote case carrying worldgen config the game author
  already knows out of band. Neither decided here; flagged for the orchestrator/Tyler.
- **Third real bug, found live while wiring `mp/reconnect` (the exact gap steps 1-2's own Deviations
  already flagged as deliberately deferred to here: "Full reconnect-driven Hello resend on the client
  side is not built in this cut"): the client worker's own `pumpHandshake` sent `client_hello()`
  exactly once, ever, gated by a one-shot `helloSent` boolean that never resets.** After a real
  reconnect (a fresh `CB_LINK_GEN` at `Up`, `net/link.ts`'s own `dial()` counter), the client's
  `attached` flag is already (and permanently) `true` from the *first* Welcome, so `pumpHandshake`
  never runs again -- the client never sends a second `Hello`, so the server's own fresh `ConnSlot`
  for that reconnect sits in `'garbage'` status forever (eventually a 5 s `ProtocolError` close), and
  every action still in the client's own pending queue is silently orphaned. Root-caused by comparing
  a working `HeadlessClient`-based repro (which calls `sendHello()` on every `onUp`, `createLink`'s own
  precedent) against the exact same scenario over a real browser worker, which never resent anything.
  **Fixed** (`worker/client-net.ts`): `lastHelloLinkGen` (a plain generation counter, `-1` = "never
  sent") replaces the pre-attach-only `helloSent` boolean's exclusive role; `pumpHandshake`'s own first
  send now also records the generation it sent for, and a new check at the top of `pump()` (post-
  attach, `handshake?.remoteLinked` only) resends `client_hello()` whenever `CB_LINK_GEN` has advanced
  past what this pump last saw and `CB_LINK_STATE` reads `Up` -- the resulting `Welcome` is picked up
  by the *existing* `MSG_TYPE_WELCOME` peek in `pump()`'s own downlink loop (originally built for a
  host-initiated resync), unmodified: this fix is purely "send the Hello that makes the server produce
  one", not a new apply-side path. Proven end to end by `mp/reconnect` (dispatch an unconfirmed action,
  kill the server-side socket, reconnect, `__mpConfirmed()` reaches exactly `1` and stays there).
- **`startTestServer({ fixture, manualTimer, worldId?, joinKey? }): { url, stepTick(n?), killClients(),
  stop() }`** (`tests/browser/support/test-server.ts`): a real `createWorldServer` + real `ws.
  WebSocketServer` (`attachWebSocketServer`) on a real, OS-assigned loopback port (`port: 0`) --
  the same production pieces `games/reference-server` composes, not a second test-only server.
  `manualTimer: true` (every `mp/*` spec's own choice): `HostServices.timer.every` is a no-op, so
  `SimHost.start()`'s own pacing arm never fires anything; `stepTick(n)` drives `SimHost.stepTick(n)`
  directly, bypassing pacing entirely (0009-style "bypasses the pacing timer", `engine/test`'s own
  `stepTick` precedent). The clock stays real (`systemClock`): a real socket's own handshake is
  genuine event-loop I/O (`ws-transport.test.ts`'s own Deviations, steps 1-2), so a virtual clock
  cannot drive it -- only the tick *cadence* is taken away from the wall clock, not the clock itself.
  `killClients()`: **additive, beyond the brief's own pinned `{ url, stepTick, stop }` shape**
  (Seams says exactly those three) -- `mp/reconnect`'s own "server-side socket kill" needs a way to
  reach the raw accepted sockets, which nothing in `{ url, stepTick, stop }` exposes; `.terminate()`s
  every `wss.clients` entry, the abrupt-close counterpart to a player's own clean `Bye{Leave}`.
  `stop()` terminates every open client socket before calling `wss.close()` (the same `net-harness.
  ts`-precedented fix step 3's own smoke test needed, this file's own separate instance of it).
- **`mp.html` + `src/mp.ts`**: a real `createClient({ host: { kind: 'remote', url, joinKey } })`
  topology, `fx-puts`. Deliberately *not* a line-for-line `slice.html` clone (the brief's own "reuses
  M16's slice.html HUD and Paint control" is read as "the same HUD fields and a Paint control", not
  "the same camera/input machinery"): `mp.ts` sets its camera directly (`__mpSetCamera`, `camera/
  transform.ts`'s own `halfExtentTiles` formula, the same derivation `HeadlessClient.setCamera` uses)
  rather than wiring real pointer/wheel/key listeners and `client.camera.tick()` -- this page is
  driven entirely by its own window hooks from Playwright, never by a human or injected gestures, so
  `slice.ts`'s real-input plumbing (and its own OPFS-adjacent GPU-residency mirroring, `__sliceSettle`,
  `__worldHash`/`__netCounters`) would have been dead weight. Uses `createRealFrameLoop` (not
  `slice.ts`'s lower-level `createFrameLoop` + hand-built canvas context): no precise-probe-format
  concern here, since `__mpProbeCenterPixel` draws into its own separate offscreen `rgba8unorm`
  target (`renderTo`/`readPixels`, `engine/test`) rather than reading the live canvas, so the canvas's
  own preferred format never has to match it.
  - Query params: `?url=` (override `wsUrl(location)`, what every `mp/*` spec uses to point at its own
    `startTestServer`), `?linklog=1` (renders `client.debug.linkLog()` as an on-page `<pre>` table,
    newest first, refreshed every 200 ms, columns: event, link state, close code, ms since visible,
    discarded), `?blockedWorker=1` (`mp/coep-worker-error-message`: swaps `createWorker` to the built,
    COEP-less worker chunk), `?corruptBuildHash=1` (`mp/version-mismatch-reloads-once`: flips one hex
    nibble of the real build hash deterministically, so the same reload lands on the same wrong hash
    twice).
  - Window hooks (all `__mp`-prefixed, `slice.ts`'s own "no bare name collision across this shared TS
    project" precedent): `__mpClientReadyResult`, `__mpSetCamera`, `__mpDispatchPaintAt`, `__mpDispatch`
    (any `Action`, not just Paint -- `mp/two-pages`'s own `SetMotd` convergence check), `__mpConfirmed`/
    `__mpRejected`, `__mpUi`, `__mpLinkState`, `__mpLinkLog`, `__mpRevealed`, `__mpProbeCenterPixel`,
    `__mpHudText`.
- **Named browser tests, exactly the six the brief lists, all in `tests/browser/mp.spec.ts`:**
  - `mp/reveal-waits-for-visible-chunks`: server started with ticking *paused* from before the page
    even loads, so the very first probe (`__mpProbeCenterPixel`) is provably taken before any host
    tick -- `revealed()` reads `false`, the probe reads the exact clear colour (`{r:0,g:0,b:0,a:255}`,
    `render/terrain.ts`'s own `colorAttachment.clearValue`). Ticking resumed; `revealed()` becomes
    `true` and the probe no longer reads the clear colour (`fx-puts`'s own pristine tile, not
    hardcoded to a literal, since the exact visual-table mapping is `tiles.json`'s own concern, not
    this test's).
  - `mp/two-pages`: two separate `browser.newContext()`s (deliberately, not two pages of one context
    -- each mints its own `localStorage.engine.playerSecret`, one per origin, only when the contexts
    are genuinely isolated; the same-context case is `mp/superseded`'s own, opposite scenario). A's
    own `SetMotd` dispatch converges on B (global scope, no camera/subscription dependency,
    `tests/netcode/CLAUDE.md`'s own `join-converges` precedent) *and* is polled back on A's own
    replica too (found needing a poll, not a single read: A's own next frame does not necessarily
    land in the same instant B's does).
  - `mp/reconnect`: dispatch an action, `server.killClients()`, then (Deviations: a deliberate,
    documented simplification) pause ticking for just over 0013's own 1 s reconnect-indicator delay
    as a *best-effort* attempt to observe `'reconnecting'` live -- not asserted, since a background
    `setInterval` can leave one tick already queued past `clearInterval` (measured: enough, on its
    own, for `pumpHandshakes` to finish the reattach before the check ran, at least once during this
    cut's own iteration). The link log (`event === 'close' || 'silence'` present) is the reliable,
    asserted record that the kill was actually noticed; the substantive assertions -- eventual
    `'online'`, `__mpConfirmed()` reaching exactly `1` and staying there -- are unaffected by this
    softened timing check. An earlier draft paused ticking *before* the kill (to try to force
    `'reconnecting'` deterministically) and instead starved the *pre-kill* connection's own
    heartbeats, producing extra, unwanted reconnect cycles that masked the real Hello-resend bug this
    test exists to catch -- reordered to kill-then-pause once the real bug (above) was found and
    fixed, which also happens to be the more realistic ordering.
  - `mp/superseded`: one context, two pages (shared `localStorage`, the deliberate opposite of
    `mp/two-pages`). Asserts the exact `CloseCode.Superseded` (4001) on A's own newest `linkLog()`
    entry, and that no further `'open'` appears after real time and more host ticks pass (the link is
    terminal, `net/link.ts`'s own `TERMINAL_REASONS`).
  - `mp/version-mismatch-reloads-once`: `?corruptBuildHash=1`; no server ticking needed at all (the
    reject is decided synchronously in `server.ts`'s own `onMessage` handler, never gated on a tick --
    verified by reading `server.ts` directly before relying on it). The `page.waitForEvent('load')`
    listener for the automatic reload is registered *before* the `__pageReady` wait that precedes it
    (Deviations: registering it after risks missing a reload fast enough to beat the CDP round trip
    back to the test process). Second mismatch (same corrupted hash, guarded by `sessionStorage`)
    reaches `'updating'`, confirmed to stay there (no further navigation) for 1.5 s.
  - `mp/coep-worker-error-message`: needs no server at all (the rejection happens at worker
    construction, before any dial) -- `?blockedWorker=1` alone, `page.goto` + `__pageReady`, no
    `openPage` (matches `start.spec.ts`'s own `openWithoutIsolationChecks` precedent, not proven
    necessary here but kept for safety since a blocked-worker page's own console output was never
    audited either way).
- **`pnpm device:serve --ws`/`--app reference` and the `device-serve/proxy-and-apps` Node test are
  still not built** (see step 3's own note above) -- the `mp/*` browser tests reach `startTestServer`
  directly and need no proxy, so nothing in step 4 forced this gap to be closed either. Exit criteria
  3 and 4 (device:serve, "serves two browser tabs by hand") remain unmet.
- **Measured, this range:** `pnpm test`: `rust` 621, `unit` 288 (+2: `readInvite`/`wsUrl`), `wasm` 156,
  `netcode` 43 (+1: `reference-server/smoke`, fast-tier-invisible since it's `@slow`), `browser` 210
  (+6: `mp/*`), all green, `19s/10s` build / `36s/48s` browser (both under budget). `pnpm lint`: biome,
  rustfmt, clippy, tsc all green. `pnpm test:slow netcode -t "ws/|reference-server"`: 4 tests green
  (`ws/reconnect-resume`, `ws/trace-identical`, `ws/spike-c`, `reference-server/smoke`), confirming
  this range's own `client.ts`/`worker/client-net.ts` changes did not regress steps 1-2's own slow-tier
  coverage. `mp/*` alone run 5 times back to back (both `--workers=1` and the suite's own default
  parallelism): 6/6 clean every time. `pgrep -fl "vitest|playwright|vite preview|chrome for testing"`
  empty before finishing.

**This final cut (Part A: `device:serve` growth; step 5: zero-GC multiplayer topology test +
negative control).** Base `9bc5269` for Part A, `55371ad` for step 5. Commits: `3c008fe`
(`createBytePump` downlink zero-alloc fast path, filed as its own checkpoint ahead of step 5's own
page), `9bc5269` (Part A), `55371ad` (step 5).

### Part A: `pnpm device:serve --ws`/`--app reference`

- **`device-serve.mjs`**: `--ws [<fixture>]` spawns `node games/reference-server` directly
  (`process.execPath`, not through `pnpm`) on `127.0.0.1:<ENGINE_WS_PORT ?? 4174>`, `--game` the
  named fixture's dev-profile build dir (default: the reference game's own
  `sim/target/engine/release`, matching `games/reference-server/index.mjs`'s own default -- neither
  is built by this script; both must already exist, same assumption that entrypoint's own CLI
  already makes) and `--data` a fresh `mkdtemp` dir, removed on shutdown. `--app reference` builds
  (`pnpm --filter reference build`) and previews `games/reference` instead of the fixture app, on
  the same `ENGINE_TEST_PORT ?? 4173`. Both apps' own `vite.config.ts` gained a
  `preview.proxy['/ws']` block, gated on a new `ENGINE_WS_PROXY_PORT` env var the script sets only
  when `--ws` is present (a no-op, unset, for every other run) -- `games/reference/vite.config.ts`
  had no `preview`/`server` block at all before this cut; added one (port from `ENGINE_TEST_PORT`,
  default unchanged from Vite's own) mirroring the fixture app's own shape exactly. Both apps' own
  `*.html` pages under their root are printed as full URLs (`htmlPages()`, a plain `readdirSync`
  filter) instead of the single hardcoded `determinism.html` link the pre-M29 script printed --
  satisfies "`pnpm device:serve --ws puts` lists `mp.html`" directly from what actually got built,
  not a name this script would otherwise have to hand-maintain.
- **`games/reference-server --game <default>` (no `--ws <fixture>` given) does not currently work**:
  `reference-sim`'s own `engine_init` rejects the reference game's default `worldCfg.params`
  (`{ seed: '1', worldgen: null }`, `index.mjs`'s own hard-coded default) with `BadConfig` -- found
  live testing `--app reference --ws` with no fixture named. This is the exact, already-flagged gap
  steps 3-4's own Deviations named for the client side (`client_on_welcome` never applies
  `Welcome.seed`/`params` to the client's own local `Worldgen` state) mirrored on the server's
  default config; the reference game is not multiplayer before M34 either way (Scope), so this was
  never going to be exercised for real until then. `device-serve/proxy-and-apps` (the Node test)
  and the manual device-check recipe both therefore use `--ws puts` explicitly for the `--app
  reference` combination too (`--ws [<fixture>]`'s own grammar is independent of `--app`) --
  verified working end to end (`curl`'d headers, a real `WebSocket` upgrade) by hand before writing
  the test. Flagged for whoever picks up M34: the bare `pnpm device:serve --app reference --ws`
  invocation named in this brief's own exit criterion text will need either a real worldgen config
  for the reference game's own server default, or a documented requirement to pass a fixture.
- **`device-serve/proxy-and-apps`** (`packages/engine/tests/netcode/device-serve-proxy-and-apps.
  test.ts`, `@slow`: two real `vite build`+`preview` cycles): spawns `device-serve.mjs` as a child
  process twice (`--ws puts`, then `--app reference --ws puts`), each on its own
  `ENGINE_TEST_PORT`/`ENGINE_WS_PORT` pair (`14273`/`14274`, distinct from the real `pnpm
  device:serve` defaults so this never collides with an interactive session on Tyler's own
  machine), waits for the script's own `pages: ...` readiness line, `fetch()`s `/` and checks the
  COOP/COEP headers, then opens a real Node `WebSocket` to `/ws` and asserts `onopen` fires (proof
  the HTTP Upgrade reached the spawned `reference-server` child through Vite's own proxy) before
  `SIGTERM`-ing the child and awaiting its real exit.
- **Verified manually** (the two device-check-adjacent exit criteria this part closes):
  `ENGINE_TEST_PORT=14173 ENGINE_WS_PORT=14174 node packages/engine/scripts/device-serve.mjs --ws
  puts`, then `curl -sD - http://127.0.0.1:14173/` (COOP/COEP present) and a raw `WebSocket` to
  `ws://127.0.0.1:14173/ws` (`onopen` fires, `onclose` code `1005` on a clean client-side close --
  the server's own `Welcome`/`Hello` handshake was not driven by hand here, only the proxy/upgrade
  path this exit criterion's own automated proof also covers). Killed and confirmed dead
  (`pgrep -fl "device-serve|reference-server|vite preview|vite build"` empty) after every manual
  run. The remaining half of this exit criterion -- desktop Chrome reaching `mp.html?linklog=1`
  through a *tunnelled* proxy, and killing/restarting the child server live -- is the Tyler-run
  device check (`docs/plan/device-checks.md`, M29), not something this session can do; not
  attempted here.

### Step 5: zero-GC multiplayer topology test + negative control

- **`createBytePump` (`src/net/pump.ts`) downlink direction is now allocation-free in the common
  case**: `onMessage` tries `RingProducer.tryPush(bytes, bytes.length)` directly on the bytes a
  `Connection` hands it (synchronous copy into the ring's own SAB storage, no retention needed) and
  only copies into a preallocated retry-queue slot (mirroring `ring-connection.ts`'s own
  `send()`/`flushRetries`/`enqueueRetry` shape, `.set()` not `slice()`, coalescing past
  `retryDepth`) on genuine backpressure. **Uplink direction still allocates one `.slice(0, len)`
  per message** -- a resizable-`ArrayBuffer` zero-copy attempt (reserve `SCRATCH_BYTES` up front,
  `.resize()` the same view down to the real message length in place before `conn.send()`) was
  tried and reverted: Node's own global `WebSocket.send()` throws `TypeError: ArrayBuffer: Received
  a resizable ArrayBuffer`, confirmed red against `pnpm test:slow netcode -t "ws/|reference-server"`.
  Since `Connection.send(cls, bytes)` is a generic 2-arg contract no caller can assume a `len` hint
  past (`ring-connection.ts`'s own doc comment on that optional third parameter), and this file's
  own unit test's mock `Connection` is exactly such a caller, the one remaining per-message copy
  is real, measured, and left as such (`net`'s own `budgets.json` row prices it in).
- **`worker/net.ts` gains `injectParseConnection`** (`gc/net-negative-control`'s own control,
  gated by a new `TestFlags.netInjectParse`, `worker/protocol.ts`): wraps the dialed `Connection`
  so every downlink message also runs a throwaway `JSON.parse(new TextDecoder().decode(bytes))`
  before forwarding it unchanged. Never wired outside `test.flags`; the grep exit criterion ("no
  `DataView`, no import from the wire codec") still holds by hand (checked: no `DataView`
  construction, no codec import, anywhere in the file -- the one textual "DataView" hit is the
  file's own pre-existing header comment stating the rule, not code).
- **`worker/net.ts` `linkControl` also calls `applyGcHook`** (previously only the drain timer did):
  real bug, found live building the clean/negative-control tests themselves -- the drain timer's
  10 ms real-wall-clock cadence fires only a handful of times across a whole measured window (the
  whole run completes in well under a second of real time, since this page's own `drive()`, like
  every other zero-GC page's, is pure synchronous SAB spin-waiting), nowhere near the 600 times
  `client`/`gen0`'s own `body()` gets from main's explicit, synchronous stepping -- `neg burst net`
  measured only ~98 B/frame with the drain timer alone, not the ~40,000 B/frame every
  synchronously-stepped isolate's own `burst` control shows elsewhere in this same page. `net`'s
  only other reachable-on-every-`drive()`-call entry point is `linkControl`, since `client.ts`'s
  own real `online`-window-event listener already posts a message there on every real DOM event
  (Scope's own "main -> net `{ type: 'probe' }` on ... `online`" wiring, unchanged); the page's own
  `drive()` now calls `window.dispatchEvent(onlineEvent)` (one preallocated `Event`, reused) once
  per frame for exactly this reason. No change to `Link.probe()`'s own real reconnect behaviour (a
  no-op on an already-healthy connection).
- **Real bug, found live: a remote host's own first wake can be lost.** `worker/net.ts`'s `onUp`
  wakes `WORKER_CLIENT` exactly once when `CB_LINK_STATE` flips to `Up`; if the client worker has
  not yet reached its own first `Atomics.wait` at that instant, `Atomics.notify` wakes nothing (only
  an already-waiting thread), and with no further wake ever arriving, `pumpHandshake()` never gets a
  second chance to observe `CB_LINK_STATE === Up` -- the page hung forever (confirmed live via
  `client.debug.linkLog()` stuck at a lone `'open'` entry). Every existing production page
  (`mp.ts`) is protected for free by its own real `requestAnimationFrame` loop's continuous wakes
  (`writeCameraAndWake()` every ~16 ms); a page with no frame loop at all (this one) has nothing
  playing that role. Fixed in the page itself, not in `client.ts`/`net.ts` (a real production
  `createClient()` call already gets a real wake source from *something* -- a frame loop, or
  another `stepFrame` caller -- in every existing topology; this is the first page with neither):
  `harness.stepFrame()` is called in a short real-time poll loop until `client.onLink` reaches
  `'online'`, each call a fresh wake that recovers even a lost first notify. Not escalated as a
  `client.ts`/`net.ts` defect: every real page this milestone ships (`mp.ts`) already has a
  continuous wake source, so this is specific to a page built with none, worth flagging for M34 (the
  reference game will need to know it needs *a* periodic wake source, whatever form its own frame
  loop takes, before a remote host's handshake is guaranteed to complete) but not a fix that belongs
  in production `client.ts` on its own initiative.
- **Background test-server traffic decoupled from measurement, found live.** A first cut ticked the
  shared `startTestServer` fast and continuously for the whole spec file (reading this brief's own
  "the test steps the server one tick ... for the 0016 window" as literal, continuous pacing); this
  let `net`'s own reading scale with however much real wall-clock time a given run happened to take,
  and a sibling isolate's own `burst` control (real GC work, real time) measurably slowed the page
  down, letting more real ticks land inside the very same measured window and inflating `net`'s
  reading by collateral, non-`net` causes -- `neg burst {main,client,gen0}` each pushed `net`'s own
  clean ~217 B/frame reading up by 20-30 B, into the same range as `net`'s own `object` control's
  real ~24 B/frame delta, an unresolvable conflict for any single budget line (ADR 0029's own
  failure mode: a margin wide enough to tolerate the sibling noise also swallows the isolate's own
  real signal). Fixed by splitting the two concerns `HEARTBEAT_MS` (a slow, 400 ms keep-alive,
  shared by the whole file) and `gc/net-negative-control`'s own dedicated, much faster ticker
  (started after `openPage`, stopped in `finally`, scoped to that one test) -- interpreted as this
  cut's own resolution of the brief's own pacing note, given `measure()`'s single-CDP-round-trip
  batching structurally rules out literal per-page-frame Node/page interleaving without rebuilding
  shared infra every other `gc` page also depends on (judged too invasive for this cut; recorded as
  a deliberate interpretation, not a literal implementation of "steps the server one tick ... steps
  a frame" as a 1:1 pairing).
- **`gc.pages.multiplayer-topology` budget rows, measured** (`playwright test --project gc --grep
  "multiplayer-topology clean" --repeat-each 5..10 --workers 1`, this machine): `main` 118.19-123.15
  B/frame (`ceil` + 8 B margin = 132, `class: "strict"`, `attributionRoots: ["drive"]` --
  `client.ts`'s own `sendProbe`/`pushLinkLog('probe')` real per-frame cost, once the `online`
  dispatch above was added); `client` 0.83-2.68 B/frame (shared "8 B" `"strict"` worker figure,
  unchanged); `gen0` a constant 0.6267 B/frame (same, this page never pans so `gen0` sees no real
  traffic); `net` a tight 214.57-217.68 B/frame (`ceil` + 8 B rounded up to 226, `class:
  "budgeted"` not `"strict"` -- `net`'s own `burst` control never forced an actual `MinorGC` event
  within the window, ~692 KB total apparently under this isolate's own scavenge threshold, the same
  reasoning `zero_gc_action`'s `sim` row documents; assertion A therefore checks `MajorGC` only,
  matching measured reality). `attributionRoots: ["linkControl"]` for `net` (not itself load-bearing
  while `software: null`, but names the real enclosing function `byFn` shows). Used `bytesPerFrame`
  uniformly rather than the `bytesPerMessage` field name this brief's own Consumes note mentions --
  read the two as mechanically identical in `gc/analyse.ts`'s own `verdict()` (`budget.bytesPerFrame
  ?? budget.bytesPerMessage`, both divided by the same `frames` count), so this is a labelling
  choice, not a behavioural one; `bytesPerFrame` matches every other row in this file.
- **`software: null`** for this page (0016 caveat b's own documented allowance): not measured under
  `GC_MODE=software`, per this delegation's own Verification commands (`pnpm test browser -t gc/`
  only, no `GC_MODE=software` leg named).
- **Named tests, exactly as listed**: `gc/multiplayer-topology` (`multiplayer-topology clean` +
  generated `object`/`burst` negatives per isolate, `zeroGcSuite({ pageId: 'multiplayer-topology',
  controlKinds: ['object', 'burst'] })`, no `post-message` -- same reasoning as `topology`/`gen`/
  `echo`) and `gc/net-negative-control` (hand-built, fast tier -- ADR 0026's auto-tagging rule does
  not apply to it, ordered-of-magnitude reasoning against the `object` control's own fast-tier cost,
  not the `burst` tier's; recorded in the spec file's own comment).
- **Measured, this range**: `pnpm test`: 621/288/156/43/216 (rust/unit/wasm/netcode/browser), all
  green, one unrelated flake observed and not reproduced on retry (`games/reference`'s own
  `ui-smoke: collect and inventory`, a button-click-interception timing issue, a file this range
  never touched). `pnpm test:slow browser -t multiplayer-topology`: 4/4 (`neg burst`
  main/client/gen0/net). Full `multiplayer-topology`+`gc/net-negative-control` set (10 tests) run 4
  times back to back: 10/10 clean every time. `pnpm lint`: biome, rustfmt, clippy, tsc all green.
  `pgrep -fl "vitest|playwright|vite preview|reference-server|chrome for testing"` empty before
  finishing.
- **A pre-existing, unrelated `@webkit-gpu @slow` flake, found and not fixed**: `pnpm test:slow`
  (full suite) intermittently fails `[webkit] terrain: probe tile colours webkit` on `terrain-
  client.html` (a file last touched in M17b, never touched by any range of this milestone) --
  `console.error: "WebSocket connection to 'ws://unused.invalid/' failed..."`. Root cause: M29 steps
  1-2 made `{ kind: 'remote' }` dial for real; `terrain-client.ts` (and roughly a dozen other
  pre-existing fixture pages, per steps 1-2's own Deviations) uses the inert placeholder `url:
  'ws://unused.invalid'`, which now attempts a real (failing) DNS lookup WebKit logs as a console
  error on some but not all runs (load-sensitive: passed 2/2 running `pnpm test:slow browser` alone,
  failed both times running the full `pnpm test:slow`, i.e. under concurrent suite load). Out of
  scope for this cut (not a file this milestone's own Files list touches, and the underlying "remote
  now dials for real" change is steps 1-2's, already landed); flagged for whoever next sees a
  webkit-only browser-suite flake naming a `ws://unused.invalid` console error.

## Fix round 1 (CI gate: no software budget for multiplayer-topology)

**`gc.pages['multiplayer-topology'].software` was left `null` at step 5 landing (this milestone's
own Deviations, above: "not measured under `GC_MODE=software` ... no `GC_MODE=software` leg named"
by the delegation's own Verification commands). `"software": null` is not a skip mechanism -- it is
an error the local gate cannot see** (0016 caveat b's own text notwithstanding): the local default
is hardware mode only. CI (`ubuntu-latest`, `ENGINE_GPU=swiftshader GC_MODE=software`, full `browser`
suite) failed every `gc/multiplayer-topology` test and `gc/net-negative-control` with `Error: gc
verdict: no software budget for multiplayer-topology` (`gc/instrument.ts:177`) on the `M29 done`
push -- the identical failure mode, and the identical mistaken belief about `null`, M15c's own gate
already found and fixed once on `connected-terrain` (`docs/plan/15c-terrain-visibility-and-cache-
invalidation.md`, "Fix round 2").

**Reproduced CI's exact error first** (`CI=true ENGINE_GPU=swiftshader GC_MODE=software pnpm test
browser -t "multiplayer-topology clean"`, this machine): identical `Error: gc verdict: no software
budget for multiplayer-topology` at `gc/instrument.ts:177`. Swiftshader emulation was reliable
locally for this page (no hang, ~2-3 s per run, isolated to this one test).

**Measured** (`CI=true ENGINE_GPU=swiftshader GC_MODE=software playwright test --project gc --grep
"multiplayer-topology clean" --repeat-each 8 --workers 1`, budget forced to 1 first to read the
failing detail's own `attributedBytesPerFrame`): a tight **96.4-96.62 B/frame** attributed to `main`
across 8 clean runs, `A` all true (zero `MinorGC`/`MajorGC` on every isolate) and only `B.main`
false as expected. ADR 0029: software mode attributes only `main`; `client`/`gen0`/`net` use raw
bytes in both modes and get no software row (`analyse.ts`'s own `verdict()`: `mode === 'software' &&
name === 'main'` is the only branch that reads `page.software`), same shape as `connected-terrain`/
`zero_gc_action`/`no_ui_change` -- confirmed live: with the budget forced to 1, `client`/`gen0`/
`net`'s own `B` stayed `true` throughout, i.e. their existing hardware `bytesPerFrame` rows (8/8/226)
already cover software mode. `ceil(96.62) = 97, + 8 B margin (0016 §1's ordinary convention) = 105`.

**Checked the failure mode this convention exists to avoid (ADR 0029): did the ordinary `+8` margin
swallow the negative controls' own separation?** No -- verified tripping at 105: `neg object main`
(8/8 repeats, same command) and `neg burst main` (`@slow`, 3/3 repeats) both fail `B.main` as
required; every sibling isolate's own `object`/`burst` control (`client`/`gen0`/`net`) leaves `main`
comfortably under 105, no collateral effect to tolerate. Full `multiplayer-topology` +
`gc/net-negative-control` fast-tier set (10 tests) and the 4 `@slow` `burst` tests all pass under
`GC_MODE=software`.

**Verified the fix is real, not a fluke**: re-set `software` back to `null`, re-ran the identical
`CI=true ENGINE_GPU=swiftshader GC_MODE=software pnpm test browser -t "multiplayer-topology clean"`
command -- reproduced the identical `gc verdict: no software budget` error a second time -- then
restored the real 105 fix and re-ran: `browser pass 1 tests`. `git diff` on `budgets.json`: a
9-line insertion, one deletion (`"software": null` -> the `main`-only software block), nothing else
touched -- the four hardware rows (`main: 132`, `client: 8`, `gen0: 8`, `net: 226`) are byte-for-byte
unchanged.

**Verified, this range**: `pnpm test` (hardware mode, this machine's default): `rust` 621, `unit`
288, `wasm` 156, `netcode` 43, `browser` 216, all green, `14s/10s` build, `37s/48s` browser. `pnpm
lint`: biome, rustfmt, clippy, tsc all green. `pgrep -fl "vitest|playwright|vite preview|chrome for
testing"` empty before finishing. Hardware mode was not re-derived or changed by this range (this
range touched only the `software` block).

## Fix round 2 (`pnpm test:slow` findings, two more real problems)

`pnpm test:slow` had never been run for this milestone before fix round 1's own gate (it targets a
budget-only failure, not the slow tier). Running it surfaced two more real problems, neither related
to `budgets.json`.

### 1. `terrain-client.html`'s own `@webkit-gpu @slow` test, a real deterministic regression

**Reproduced twice on a quiet local machine (hardware mode), 2/2, not intermittent**:
`terrain: probe tile colours webkit` failed `console.error: "WebSocket connection to
'ws://unused.invalid/' failed..."`. Steps 1-2 (this brief) made every `{ kind: 'remote' }` host dial
for real (Scope); a dozen-plus pre-existing test/device pages (`gc-anchors.ts`, `gc-input.ts`,
`device.ts` x3, `gc-gen.ts`, `framecx.ts`, `gen.ts`, `gc-terrain.ts`, `real-camera.ts`, `semantic.ts`,
`terrain-client.ts`, `viewport.ts`) use a placeholder `{ kind: 'remote', url: 'ws://unused.invalid' }`
host purely to get a "client + gen, no sim worker" topology shape, with no real networking intent at
all (M06b's own reserved-but-inert shape, predating this milestone). The `linked`/`awaitLive` split
(steps 1-2's own Deviations) stopped `client.ready` from hanging on this, but never stopped the net
worker from actually *attempting* the dial -- a genuine failing DNS lookup on every one of these
pages' loads. Chromium never surfaces a `console.error` for it (confirmed: the fast-tier `chromium`
suite, which exercises most of these same pages, has been green all along); WebKit does, and
`terrain-readback.spec.ts`'s own strict `openPage` console-error assertion (`support/page.ts`, every
browser test's own contract) catches it -- `@webkit-gpu @slow`-only, so this was the first time
`pnpm test:slow` ever ran it since M29 landed.

**Fix: a test-only opt-out, not a page-by-page allowlist or a new host kind.** `TestFlags.netNoDial`
(`worker/protocol.ts`) -- `worker/net.ts`'s `buildLink().dial()` returns a `noDialConnection()` stub
(never opens, never closes, no timers, `send`/`close` no-ops) instead of calling `wsConnection(url)`
when set. `net/link.ts`'s own dial contract ("already open, or open-enough, the instant it is
returned") is satisfied trivially, so `CB_LINK_STATE` still reports `Up` immediately the same way a
real-but-never-checked dial did pre-M29 -- exactly the behaviour these dozen pages already assumed.
Not a new `ClientOptions.host` kind (would be a renamed/widened Provides seam) and not a per-test
`allowConsoleError` allowlist (the coordinator's own instruction: fix the real cause). All thirteen
call sites (thirteen, not twelve -- `device.ts` has three) now pass `test.flags.netNoDial: true`
(`gen.ts`'s own caller-supplied `opts.test.flags` merges it as a default, not an override).
`mp.ts` (the one page with a *real* remote host) is untouched -- `netNoDial` is opt-in per page, not
a default.

Verified: `pnpm test:slow browser -t "probe tile colours webkit"` 3/3 clean (this machine, hardware
mode); `pnpm --filter engine typecheck` clean; full fast-tier `pnpm test browser` unaffected (216
tests, same as before this fix). No other page hits the same class of problem: grepped every
`ws://unused.invalid` site in `tests/browser/pages/src/*.ts` and `games/*/` (none in `games/*/`) and
confirmed none of the twelve pages read `client.onLink`/`CB_LINK_STATE` at all -- they only ever
wanted the topology shape.

### 2. CI's slow tier (software mode), contention -- confirmed by mechanism, not assumed

CI's first-ever `pnpm test:slow` run failed `ws/spike-c` ("engine: dispatch before ready"),
`device-serve/proxy-and-apps` (60 s timeout), and three `browser` `gc` `neg burst` tests --
including `connected-terrain neg burst sim`, a **pre-existing page this milestone never touched**.
That last failure is the strongest single signal this is contention, not a defect in any one test's
own logic (docs/plan/17b-sprites-and-frame-budget.md's own `frame-bench` precedent: "a frame-time
gate cannot share the machine with a parallel Playwright worker pool").

**Checked the mechanism before assuming load, per instruction.** `ws/spike-c` and
`ws/join-converges` (fast tier) share the identical `advanceTicks(20)`-then-`dispatch` shape and the
identical `net-harness.ts` real-wall-clock yield (`20 ms` per tick, already tuned up once from 5 ms
for exactly this class of failure, steps 1-2's own Deviations) -- `join-converges` never fails, so
the difference is environmental, not structural: CI's slow tier runs `netcode` concurrently with the
full `browser` suite (chromium + gc + the `engines` leg, webkit/firefox, *and* this milestone's own
four new `burst` GC negative controls, deliberately CPU-heavy), on `ubuntu-latest`'s own far smaller
core count than this dev machine (14 cores; this whole slow tier completes in ~32 s here with
everything running at once). `device-serve/proxy-and-apps` spawns two real `vite build`+`preview`
cycles -- real CPU-bound work with the same exposure.

**Fix: `netcode` is now `soloTiers: ['slow']`** (`scripts/test.mjs` gained tier-scoped `solo`
alongside the existing `solo: true`; `scripts/suites.mjs`'s `netcode` row sets it) -- its slow tier
now runs after `browser`'s slow tier finishes, removing exactly the external contention the
mechanism above names, the same reasoning `frame-bench` already established for real-time
*measurement*, applied here to real-time *correctness*. The fast tier (4 s, no real spawns racing
anything) stays concurrent -- untouched, no reason to slow down every interactive `pnpm test` run.
Also bumped `device-serve/proxy-and-apps`'s own explicit Vitest timeout 60,000 -> 120,000 ms, with
the mechanism stated in the test file itself: real work (two build+preview cycles) that scales with
CPU count, as a stated margin against `netcode`'s own remaining internal concurrency (several test
files in the same suite still run at once), not a blind bump.

**Tried, measured, and reverted a second change**: bumping `net-harness.ts`'s own `20 ms` per-tick
yield to `40 ms` (reasoning: give `ws/spike-c` more margin against `netcode`'s own internal
concurrency even once `browser`'s external contention is removed). **This broke `ws/reconnect-resume`
and `ws/trace-identical`, reproduced by running the full local slow tier**: both time out at Vitest's
5 s default (`"Test timed out in 5000ms"`) because they have no explicit `testTimeout` override and
call `advanceTicks` enough times that `40 ms/tick` pushes their own total real wall time past 5 s --
clean again at `20 ms`. Reverted; the comment at the call site now records this so nobody retries the
same bump blind. **This constant is not touched by this fix round.**

**Not verified against real CI hardware** (standing instruction: no pushing from this session; the
coordinator confirms on the next CI run). Locally verified instead: `pnpm test:slow` twice in a row,
clean both times (`netcode pass 5 tests ~31s`, now running after `browser`'s `pass 58 tests ~31s`
finishes; `frame-bench pass 1 tests ~6.5s` last, unaffected -- solo suites still run strictly
sequentially, never racing each other, the pre-existing guarantee this fix relies on). `pnpm test`
(fast tier) unaffected: `netcode pass 43 tests` stayed concurrent, `6.4s` and `4.1s` across two runs,
both comfortably under the 10 s budget. One unrelated flake observed on one `pnpm test` run
(`reference ui-smoke: collect and inventory`) -- the same pre-existing, load-sensitive click-
interception flake this brief's own step-5 Deviations already named as unrelated to any file this
milestone touches; passed clean on immediate retry.

**If CI's slow tier is still tight after this fix**, that is `browser`'s own internal concurrency (5
workers, plus the concurrently-running `engines` leg) to revisit next, with real CI numbers in hand
-- not something to guess at from this machine, whose 14 cores do not represent CI's own hardware.

## Fix round 3 (CI's own downloaded `test-results` artifact, two remaining real problems)

The coordinator downloaded CI's raw `test-results` artifact (`gh run download`) after fix round 2 to
get the untruncated `browser/report.json` the console log itself cuts off -- both numbers below are
from that artifact, not a guess.

### 1. `multiplayer-topology neg burst {main,client,gen0} @slow`: collateral on `net`, software mode only

CI's own verdict for `neg burst main`: `bytesPerFrame: { main: 40133.41, client: 4.09, net: 235.59,
gen0: 0.78 }`, `B: { main: false, client: true, gen0: true, net: false }`. `main`'s own `A`/`B` false
is the control tripping as designed; `B.net = false` is the real failure -- `gc/analyse.ts`'s own
`verdict()` reads `net`'s raw `totalBytes/frames` in *both* modes (`rawB`, the `else` branch every
isolate but `main` takes; ADR 0029: only `main` gets a software-specific attributed row), so the
existing 226 B/frame ceiling has to hold under `GC_MODE=software` too -- verified only in hardware
mode when it was derived (step 5's own Deviations: "no collateral effect left to tolerate" was never
checked under software mode).

**Same collateral mechanism the step-5 fix already solved once for hardware mode, still leaking
under software mode specifically.** A sibling isolate's own `burst` control (real allocation, real
GC pressure) makes the whole page run measurably slower in real wall-clock time -- worse under
`ENGINE_GPU=swiftshader`'s software rendering and CI's own weaker CPU than the hardware-mode check
ever exercised. This file's own Node-side `HEARTBEAT_MS` `setInterval` (400 ms, real wall-clock, the
only thing that ever ticks the `manualTimer: true` test server) does not know or care how long the
measured window actually takes -- a slower window lets more of its real ticks land inside it, each
one a genuine downlink message `net`'s real `onMessage` has to process, regardless of which isolate
the negative control under test targets.

**Fix: `HEARTBEAT_MS` raised `400 -> 2000`** (`gc-multiplayer-topology.spec.ts`), the same fix shape
already applied to `gc/net-negative-control`'s own dedicated ticker for the identical class of
problem (message *volume* scaling with real wall-clock time) -- fewer real ticks per real second
means fewer land in any window regardless of how long it runs. Stays comfortably under `net/link.
ts`'s own `DEAD_MS` (3000), a 1000 ms safety margin against scheduling jitter; this interval's only
real job (keeping the session from going `'dead'`) never needed to tick often.

**Verified (this machine).** Clean baseline unchanged: 214.79-215.53 B/frame across 8 repeats,
hardware mode (confirms a normal, sub-second clean window was never where the collateral came from --
only a *slow* window is). `neg burst {main,client,gen0}` under forced `CI=true ENGINE_GPU=swiftshader
GC_MODE=software`: net's raw reading now 216.79-218.19 B/frame (was 235.59 on CI at the old rate) --
real ~8 B margin restored under 226. Full `multiplayer-topology`+`gc/net-negative-control` fast-tier
set (10 tests) and all 15 `neg burst {main,client,gen0}` repeats re-verified passing under the same
forced env. **This machine could not reproduce CI's own exact 235.59 failure** (local software+
swiftshader burst collateral measured well under 226 even before this fix, 14 cores vs. CI's own
smaller runner) -- verified by mechanism and by a large, consistent reduction in the same measured
quantity, not by reproducing the exact CI number locally. `budgets.json`'s own `net` row formula
updated in place with this finding (the "third finding" paragraph, appended to the existing one).

### 2. `device-serve/proxy-and-apps @slow`: still times out at 120 s -- traced, not re-guessed

**Read `checkMode` and `device-serve.mjs` end to end for the coordinator's own question** ("does
`checkMode` await full teardown ... including port release?"): no. `device-serve.mjs`'s own
`shutdown()` fired `.kill()` on every spawned child and called `process.exit(0)` immediately, with
*no wait* for any of them to actually exit -- a real, confirmed bug. A second, related gap: `preview`
(`pnpm exec vite preview`) is a *wrapper* around the real HTTP listener (`vite`, a grandchild of this
script); a plain `.kill()` on the wrapper does not guarantee the signal reaches `vite` at all, since
that depends on `pnpm`'s own, unaudited forwarding behaviour.

**But traced through to its actual consequence, this bug produces a fast, explicit failure, not a
silent 120 s hang** -- both apps' own `vite.config.ts` already set `preview.strictPort: true` (no
silent port-increment retry), and `games/reference-server`'s own `WebSocketServer` bind failure would
throw an uncaught exception, which `device-serve.mjs`'s own child-readiness promises (`wsChild.
on('close', ...)`, `preview.on('close', ...)`) already turn into an explicit rejection, which the
test's own `waitReady`'s `proc.on('exit', ...)` already turns into `device-serve.mjs exited N before
ready` -- fast, not a bare timeout. **Fixed anyway** (a real, load-bearing correctness bug regardless
of whether it is *this* symptom's root cause -- `pnpm device:serve`'s own real interactive use has
the identical risk on a plain Ctrl-C): `shutdown()` is now `async`, awaits every child's real exit
(`waitExit`, a bounded 5 s wait then `SIGKILL`, the same bounded-wait-then-force shape `net-harness.
ts`/`test-server.ts` already use for a server's own accepted sockets) before calling `process.exit
(0)`; `preview` is now spawned `detached: true` so `shutdown` can kill its whole process group
(`process.kill(-preview.pid, ...)`), reaching `vite` even if `pnpm` itself never forwards anything.
Also gave the test's own two sequential `checkMode` calls **distinct port pairs** (14273/14274,
14275/14276) -- removes any dependency on teardown timing between them structurally, not just makes
it faster.

**The actual mechanism, reasoned from the evidence in hand**: a fast, explicit failure is not what CI
reported (a bare timeout), which points at genuine CPU-bound slowness rather than a hang. `netcode`'s
own `soloTiers: ['slow']` (fix round 2) removed contention from the *other* concurrently-running
suites, but never touched `netcode`'s own internal concurrency -- Vitest's own default runs every
test *file* in a project in parallel, so `reference-server/smoke`'s real server spawn, three `ws/*`
tests' real sockets, and `device-serve/proxy-and-apps`'s own two real `vite build`+`preview` cycles
all still compete for CI's own real CPU at the same moment. **Fixed**: `netcode` gained `slowArgs:
['--no-file-parallelism']` (`scripts/suites.mjs`; `scripts/lib/adapters.mjs`'s `vitest` adapter
extended to append it only in the slow tier, the same tier-scoping shape `soloTiers`/`leg.onlyTier`
already use) -- `netcode`'s own slow-tier test files now run one at a time, trading real wall time
(no budget gates the slow tier) for far less peak concurrent CPU demand.

**No exact CI wall-clock number for this specific test was available to derive a timeout from**
(the coordinator's own artifact gave `reference-server/smoke`'s duration, 30 s -- itself almost
entirely 0013's own fixed real-time idle wait, not CPU-bound work, so not informative about build
speed -- and only "still times out at 120 s" for this one, no partial-progress figure). Left at
120 s; not blindly widened further with no evidence to derive a new number from. Verified locally
instead: `pnpm test:slow netcode -t "device-serve/proxy-and-apps"` (4.3 s, distinct ports, clean
teardown -- `pgrep` empty after); full `pnpm test:slow` twice in a row, clean both times (`netcode
pass 5 tests ~59s`, now serialized -- up from ~31s concurrent, the direct, expected cost of `--no-
file-parallelism`); `pnpm test` (fast tier) unaffected, `netcode` stays concurrent there (`4.1-4.2s`).

**If CI's slow tier still times out this test after both fixes**, that is real evidence the work
itself (not contention) is the bottleneck on CI's own hardware, and the next step is a real,
CI-measured number for `--app reference`'s own `pnpm --filter reference build` step specifically --
not available from this machine.

## Fix round 4 (5 CI reruns: both remaining problems confirmed real, both fixed)

The coordinator ran 5 CI reruns of fix round 3 (`095d3a9`, `027edfd`). Two different fast-tier flakes
appeared once each and never recurred (`ws/join-converges` dispatch-before-ready,
`multiplayer-topology neg object gen0` timeout) -- genuine CI-runner noise, not chased here, per the
coordinator's own instruction. The two real problems remained, unchanged in shape, on every slow-tier
rerun.

### 1. `net`'s collateral fix (fix round 3) didn't hold on real CI -- gave `net` its own software row

CI's own downloaded `report.json` (`neg burst main`): `net`'s raw `bytesPerFrame` was **243.47** --
*worse* than the 235.59 fix round 3 was fixing, despite `HEARTBEAT_MS` 400 -> 2000. This machine's
own forced-software-mode measurement (216-218) never reproduced CI's own number; the coordinator's
own read (CI's runner evidently lands more real ticks inside the measured window than local
measurement predicts, plausibly because `main`'s own burst visibly slows the whole page's real-time
frame-stepping more on CI's weaker hardware, stretching the window and giving more real time for
anything periodic to land inside it) is the working theory -- not re-derived further, per the
coordinator's own explicit instruction to stop chasing the heartbeat mechanism.

**Gave `net` its own dedicated `software.isolates.net.bytesPerFrame` row** (`budgets.json`), the same
"give software mode its own number" shape `main`'s own row already established -- `gc/analyse.ts`'s
`verdict()` extended (a new, backward-compatible branch: a non-`main` isolate's own software row is a
raw `bytesPerFrame` ceiling, not attribution) so `net` no longer borrows the tight, hardware-derived
226 ceiling in software mode.

**A real regression found and fixed while deriving the number, before landing it**: a first cut set
`net`'s software ceiling to 660 (measured local worst-case collateral across `neg burst
{main,client,gen0}`, 218.07, times a stated 3x safety margin) with no further guard -- this silently
broke `neg object net`, `neg burst net` and `gc/net-negative-control` (all measured 5/5 failing under
forced `CI=true ENGINE_GPU=swiftshader GC_MODE=software`): `net`'s own real `object`-control delta
measures only ~238 B/frame under software mode, *smaller* than CI's own observed sibling-burst
collateral (243.47) -- no single raw ceiling can tolerate that collateral and still catch a ~238
B/frame defect, the exact ADR 0029 failure mode ("a margin wide enough to swallow the control's own
separation"). Fixed architecturally, not by picking a different number: `verdict()` gained a fourth
parameter, `verdictIsolate` (threaded from `measure()`'s own `opts.control?.isolate` /
new `opts.verdictIsolate`) -- the wide software ceiling now applies only when `net` is *not* the
isolate a control is actually targeting (a sibling's control, or a clean run); `net`'s own control
scenarios fall back to the tight 226 hardware ceiling regardless of mode, unaffected by the new row.
`gc/net-negative-control` (a hand-built control outside `zeroGcSuite`'s own mechanism -- applies no
`opts.control` at all) now passes `verdictIsolate: 'net'` explicitly for the same reason.

With that guard, `net`'s software ceiling was re-derived at 660 (218.07 local worst-case x 3, the
upper end of a stated 2-3x range, deliberately generous since local already undershot CI's own
observed number once) and re-verified: `neg object net` 5/5, `neg burst net` 5/5,
`gc/net-negative-control` 5/5, all correctly tripping `B.net` again; the full fast-tier set (10
tests) and `neg burst {main,client,gen0}` (12 repeats) all pass with the row in place. Two new unit
tests pin both the wide-ceiling-for-collateral shape and the exact regression found
(`gc/analyse.test.ts`).

### 2. `device-serve/proxy-and-apps` still times out at exactly 120,000 ms, zero captured stdout

`--no-file-parallelism` (fix round 3) removed `netcode`'s own internal file-level contention too, so
the coordinator's own read was right: this is genuinely slow work, not a hang from contention. Two
things done, per the coordinator's own ask:

**(a) Progress logging.** `checkMode` now logs every phase with an elapsed-ms prefix (`log()`,
`device-serve-proxy-and-apps.test.ts`) and, critically, now *forwards* `device-serve.mjs`'s own child
`stdout`/`stderr` into the test's own captured output -- previously spawned with `stdio: 'pipe'` and
never read past `waitReady`'s own buffer scan, so every one of `device-serve.mjs`'s *own* existing
progress lines ("building the fixture app…", "building games/reference…", "pages: …") was silently
discarded. This alone is very likely why the coordinator's artifact showed nothing: the lines were
never being captured, not merely not printed on a pass.

**(b) A real, measured 600,000 ms (10 min) timeout, not another guess.** Read `build-game.ts` to find
the actual mechanism (not assumed): `--app reference`'s own build calls `buildGame()`, whose bindings
step runs `cargo test --workspace ... export_bindings` (`BINDINGS_CARGO_ARGS`) -- a *whole-workspace*
test compile (every crate under `packages/engine/crates/*`, `packages/engine/fixtures/*`, plus
`games/reference/sim` itself), not merely bundling some JS. A warm-cache run of this test's own two
`checkMode` calls together measures ~2.7-3.1 s total on this machine (3 repeats) -- a poor predictor
of CI's own worst case, since CI has no guarantee of a warm target directory for this specific,
relatively new build path, and a repeatedly-failing job may never even reach a cache-save step.
Measured directly instead with `reference-sim`'s own release artifacts freshly cleared (`cargo clean
--release --target wasm32-unknown-unknown -p reference-sim`, simulating a cache-miss): `pnpm --filter
reference build` alone took **4 m 11 s** (251 s inside the `engine:vite buildStart` hook, i.e. the
bindings step above) -- on a 14-core machine, with `engine`/`serde`/`ts-rs` dependencies themselves
still warm from this session's own many other builds; real CPU time for that run was only ~6 s
against 251 s wall clock, meaning most of it was contention, not raw compute -- itself informative,
since a whole-workspace `cargo test` compile is exactly the kind of operation that stalls hard under
real contention, and CI's own runner is both weaker and shares resources with the rest of its job.
Ceiling: 251 s x a real, stated ~2.4x margin for CI's own smaller/shared hardware and cold dependency
cache (harsher than 251 s already reflects, since that figure's own dependencies were warm) = ~600 s,
rounded to 600,000 ms. Full reasoning, in this exact form, is in the timeout's own comment
(`device-serve-proxy-and-apps.test.ts`) per this repo's own Rules ("when the fix really is a time
limit, say why it is not a mask").

**Verified, this range**: `pnpm test` and `pnpm lint` green (two unrelated, load-sensitive browser
flakes observed on a contended shared machine mid-session -- `gc-ui.spec.ts`'s own `no_ui_change`
test, `games/reference`'s own `spawn.spec.ts`/`player.spec.ts` -- all in files this range never
touched, all passed clean in isolation and on a full-suite retry). `pnpm test:slow` clean twice in a
row (`netcode pass 5 tests ~59s`, unchanged from fix round 3 -- this machine's own cache stayed warm
throughout, so the new 600 s ceiling was never exercised locally, only reasoned from the cold-cache
measurement above). `pgrep` empty after every run. Not verified against real CI hardware -- no push
from this session; the coordinator confirms on the next CI run.
