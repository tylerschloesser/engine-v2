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
- [ ] Named tests pass; `gc/multiplayer-topology` is a `zeroGcSuite` page whose ceilings come from `budgets.json` `gc.pages`.
- [ ] `grep` test: no frame parsing in `src/worker/net.ts` (no `DataView`, no imports from the codec).
- [ ] `node games/reference-server --game <fixture dir>` serves two browser tabs by hand.
- [ ] `pnpm device:serve --ws puts` lists `mp.html`; in desktop Chrome `mp.html?linklog=1` reaches `online` through the proxied `/ws` with no manual stepping (the tick on the HUD advances in real time), and killing and restarting the child server adds `close` and `Welcome` rows to the on-page log. `pnpm device:serve --app reference --ws` serves the reference game, cross-origin isolated, on the same port (node test `device-serve/proxy-and-apps`: spawn each mode, fetch `/` for both headers, open a `WebSocket` to `/ws` and see the upgrade succeed through the proxy).
- [ ] `pnpm test` and `pnpm lint` are green.

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
