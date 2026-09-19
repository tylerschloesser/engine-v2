# M35b: Bun and Deno server adapters

Status: not started · After: 29 (runs **before** M35) · Tyler-dependent: no

Split out of M35 (sizing rule: reading list). It runs first so that M35 freezes an exports map in which `./server/bun` and `./server/deno` are real.

## Goal
A game's server package can host a world on Bun or on Deno with the runtime's built-in WebSocket server, no `ws`, through `engine/server/bun` and `engine/server/deno`. Bun is tested in the fast tier (Requirement: "Node ≥ 22 and Bun are tested"); Deno is best-effort and tested in the slow tier when `deno` is installed.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0009-transport-and-hosting.md` ("Injected adapter": `Connection`, `HostServices`, `createWorldServer`; "Node"; "Host-agnostic, honestly")
3. `docs/decisions/0017-packaging-and-build.md` (§2 the three `./server/*` subpaths, §4 "Server": `loadGame(dir)`, Alternatives: export conditions rejected)
4. `docs/decisions/0005-persistence-and-recovery.md` ("Storage": the interface, the adapter table row "Node / Bun / Deno `fs`", the tick-path rule)

Mine from spikes: `spikes/vite-lib-worker-wasm/game/test/node-bun.mjs` (one loader shape under Node and Bun). Rules that apply: none (server code is outside 0016; no sim code is touched).

## Scope
- `src/server-bun.ts`: `loadGame(dir)`, the fs `Storage` factory, `bunHostServices(opts)` (the twin of M27's `nodeHostServices`), and `bunHandlers(server)` returning the `{ fetch, websocket }` pair a game passes to `Bun.serve`. The game owns the port, TLS and routing (0009 Consequences); the adapter only upgrades and turns each socket into a `Connection` (`binaryType` arraybuffer, no compression, `bufferedAmount` from `getBufferedAmount()`).
- `src/server-deno.ts`: the same exports (`denoHostServices`), with `denoHandler(server): (req: Request) => Response` built on `Deno.upgradeWebSocket`, for `Deno.serve`.
- The three adapters export parallel names: `loadGame`, the fs storage factory (M22b wrote `fsStorage`, M27 wrote `createFsStorage`: use the name that landed, everywhere), `<runtime>HostServices`, and one attachment function (`attachWebSocketServer` on Node, M29). A `unit` test compares the export sets.
- `games/reference-server`: entry files `bun.ts` and `deno.ts` (about twenty lines each) next to the Node entry, and `start:bun` / `start:deno` scripts. The Bun and Deno entries do not import `ws`.
- Tests (below) and the nested `CLAUDE.md` note.

## Non-scope
The Durable Object adapter and any deploy (M38). Changes to `Connection`, `HostServices` or `createWorldServer`. A Deno-native or Bun-native storage implementation. `wss`/TLS. Running the browser suite against a Bun or Deno server.

## Files, packages and crates touched
`packages/engine` (`src/server-bun.ts`, `src/server-deno.ts`, shared `src/server-fs-storage.ts` and `src/server-load-game.ts` if M27 did not already factor them, `tests/wasm/`), `games/reference-server`. No crate.

## Seams
**Provides:** `engine/server/bun`: `loadGame`, fs storage factory, `bunHostServices`, `bunHandlers(server: WorldServer)`; `engine/server/deno`: `loadGame`, fs storage factory, `denoHostServices`, `denoHandler(server: WorldServer)`; `games/reference-server` scripts `start:bun`, `start:deno`; tests `bun-adapter loopback` (Bun script of the `wasm` suite) and `deno-adapter @slow`.
**Consumes:** `createWorldServer`, `WorldServer`, `nodeHostServices`, `HeadlessClient`, in-memory harness (M27); `Connection`, `HostServices`, `MsgClass`, `WorldConfig` (M13, names of 0009); `loadGame` (M02) and the fs `Storage` (M22b); `createLink`, `CloseCode`, handshake (M28); `wsConnection` (runs on any global `WebSocket`, so it is the client end under Bun and Deno too) and the loopback scenario shape (M29); the plain `bun` script of the `wasm` suite (M02, extended by M22b and M27).

## Planning decisions
- **One fs `Storage` for all three runtimes.** Bun and Deno both implement `node:fs`, and 0005's adapter table has a single row for the three. The adapters re-export the Node implementation from a shared module, so durability semantics (buffered `append`, asynchronous `datasync`, temp-file rename) cannot drift per runtime. `node:` specifiers still appear only under `./server/*` subpaths, which is what 0017 requires of the portable core.
- **Structural typing, no runtime type packages in `.d.ts`.** As with `ws` (0009 "Node"), `Bun.serve` and `Deno.upgradeWebSocket` are described by minimal local interfaces, so a consumer's `tsc` needs neither `@types/bun` nor Deno's lib to import the other adapters' types.
- **Handlers, not servers.** The adapters return handlers instead of calling `Bun.serve`/`Deno.serve` themselves, mirroring Node where the game constructs the `WebSocketServer`. This keeps port, TLS, health checks and static files with the deployer.
- **Where the tests live.** Bun support is a Requirement, and 0020 §4 forbids demoting the only test of a feature, so the Bun adapter gets one small fast-tier scenario inside the *existing* `bun` process (no second spawn): server on `127.0.0.1:0`, two `HeadlessClient`s over `wsConnection`, a short scripted log, replica hash equals host hash equals the golden hash. Deno is best-effort: the same script under `deno run` is slow-tier test `deno-adapter @slow`; when `deno` is not on `PATH` it prints the named warning `deno-missing` and passes. M10's workflow installs Deno so CI always runs it. No Deno pin is added to 0017 §10's table; the version used is written in the workflow file.
- **`loadGame` under Deno** reads bytes and calls `WebAssembly.compile` exactly as 0017 §4 says; the test runs with the narrowest flags that work (`--allow-read=<dir> --allow-net=127.0.0.1`) and the nested `CLAUDE.md` records them.

## Order of work
1. Factor the shared fs-storage and load-game modules out of the Node adapter if needed (no behaviour change; Node tests stay green). 2. Bun adapter + `bun-adapter loopback` in the existing Bun script. 3. Deno adapter + `deno-adapter`. 4. Reference-server entries and scripts; start each once by hand and join from the browser. 5. Export-parity unit test, nested `CLAUDE.md`.

## Tests added
`unit`: `server adapters export parity`. `wasm` suite, Bun script (fast): `bun-adapter loopback`. Slow: `deno-adapter @slow`. Both adapter tests also assert a clean `stop()` (flush awaited, sockets closed) and that a `Storage` write failure reaches `onError`.

## Exit criteria
- [ ] `pnpm test wasm -t "bun-adapter"` passes and the `wasm` suite stays within its 0020 §3 budget.
- [ ] `pnpm test:slow -t deno-adapter` passes with Deno installed, and prints `deno-missing` and passes without it.
- [ ] `pnpm --filter reference-server start:bun` serves a world that the reference game joins in the browser (checked once by hand with the `playwright-cli` skill; not an automated test).
- [ ] The three adapters export the same names (`server adapters export parity`).
- [ ] `packages/engine` still has zero `dependencies`; no `Bun.` or `Deno.` identifier outside `server-bun.ts` / `server-deno.ts`.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm lint` · `pnpm test wasm -t "bun-adapter"` · `pnpm test:slow -t deno-adapter` · `pnpm --filter reference-server start:bun`

## Budgets
PRE-PLAN §7 "Test suite": the WASM-under-Node-and-Bun suite budget (0020 §3) with the new scenario included. "Download": adapters count toward engine JS brotli, measured by M35's `size` test. No runtime budget applies to servers beyond the tick budget, which M36 measures.

## Context artifacts
`packages/engine/CLAUDE.md`: adapter parity rule, Deno flags. `games/reference-server/CLAUDE.md`: the three start commands. No new skill or rule.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
