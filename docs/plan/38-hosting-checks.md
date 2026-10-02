# M38: Hosting checks

Status: done (2026-10-02; two criteria await Tyler: the Fly billed cost and the Fly teardown after his device check) · After: 35, 31 (run after 34 when possible, so the reference game is the payload; otherwise the `busy-field` fixture) · Tyler-dependent: no (Q6 answered: the $5 Cloudflare Workers plan and a Fly machine with a 1 GB volume are approved; the Cloudflare Pages deploy is **not**). Tyler logs the CLIs in

## Goal
Two claims that Phase 1 could only compute are measured on real hosts: a Durable Object can (or cannot) host a world within 0009's constraints and cost target, and the reference server on Fly meets the cost target with idle stop and wake. The Fly machine also serves the built client with COOP/COEP, so the phone check runs against a real deployment. The Durable Objects outcome is recorded as a new ADR. The third claim, 0015 §3's header listings on a real static host (and its sentence about a cross-origin `wss`), is **not** checked: no static-host deploy was approved. It stays unverified and is handed to M39b as an open item.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0009-transport-and-hosting.md` (Targets, Durable Objects constraints, Cost target, Consequences: recipes and the deferred feasibility list)
3. `docs/decisions/0015-threads-memory-and-topology.md` (§3 cross-origin isolation, per host; §5 sim arena ceiling on Durable Objects)
4. `docs/decisions/0005-persistence-and-recovery.md` (Storage interface and the adapter table: object-store row)

Mine from spikes: `spikes/cross-origin-sab/RESULT.md` §4 (header listings, docs-only so far). Skill: `write-adr`.

## Scope
**What Tyler does (about 15 minutes):** create or confirm the Cloudflare and Fly accounts with a payment method, upgrade Workers to Paid, run `wrangler login` and `fly auth login` in the session's terminal. The session does everything else through the CLIs and tears down at the end (`fly apps destroy`, delete the Worker; Tyler downgrades the plan). No Pages project is created. Expected spend under $10.

**A. Durable Objects feasibility and adapter.**
- New private package `games/reference-server-do/`: a Worker that routes `/ws/<worldId>` to one DO per id; the DO imports `game.wasm` as a precompiled module and takes `buildHash` from `game.json` (0017 §5), calls `createWorldServer` from `engine/server`, and supplies `Connection` over the standard WebSocket API (not Hibernation, 0009), `Storage` as numbered part objects over DO storage (0005 adapter table), `timer` from `setInterval`, `clock`, and `onIdle` (clears the timer so the object becomes evictable).
- Step 1, no account needed: it runs under `wrangler dev --local` and a headless client joins, acts, reconnects. This alone proves the claim 0009 makes for DO: the library assumes no process, filesystem or HTTP server.
- Step 2, deployed, payload with `arenaBytes` at the 0015 §5 DO ceiling: measure the four items of 0009 Consequences: usable memory (instantiate, fill with the bench genesis, tick 1 h), timer accuracy (tick interval p50/p99 and the host's overrun counter over 30 min with 2 clients; note workerd's clock only advances on I/O), billing (duration, requests at the 20:1 message ratio, any CPU charge, read from the dashboard after a 24 h connected run and projected to a month), restarts (count in 24 h with a client attached).
- Go/no-go → ADR via `write-adr`. **Go** needs all of: the PRE-PLAN §9 risk 5 triggers not hit (cost within the $5 plan for an always-available world, no tick throttling, usable memory at the ceiling), and at most one restart per hour while connected. On go: DO is a supported second target, the package stays as the documented recipe (0009 Consequences: no engine code), and `do/local-smoke` joins the slow tier. On no-go: the ADR supersedes 0009's target list, the package is deleted, the measurements live in the ADR.

**B. The client served from the Fly machine (replaces the Pages deploy).** `games/reference-server` gains `--static <dir>`: a static handler of about 40 lines on the same `node:http` server the `ws` server is attached to (`/ws` upgrades go to `attachWebSocketServer`; everything else is a file under `<dir>`, `index.html` for `/`). It sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (the exact values of 0015 §3) on **every** response, 404s included, `Content-Type` from a small extension table with `application/wasm` for `.wasm`, `Cache-Control: immutable` for `/assets/*`, and refuses paths that leave `<dir>`. The Dockerfile copies the `vite build` output of `games/reference` into the image and the machine runs with `--static`. Page and socket share one origin, so the client dials `wss://<same host>/ws`. `scripts/check-coi.mjs <url>` asserts both headers, exact values, on `/`, the hashed worker script, the `.wasm`, one image and a 404. One env-gated Playwright test opens the deployed page: `crossOriginIsolated`, workers ready, WebGPU adapter present, and the page reaches `online`.
- **Link log on the hosted build:** `?linklog=1` on the reference game (Planning decisions), which M38-socket-resume reads.
- **Not verified, carried forward:** this proves our own handler, not a static host. "Verify the COOP/COEP listings on one real static host" (0015 §3, including its sentence about a cross-origin `wss`) stays UNVERIFIED. The README's hosting section keeps the Cloudflare Pages / Netlify / Vercel listings from the spike, each marked "from documentation, unverified", and M39b carries the item into Phase 4 (its Scope, "Open items carried forward").

**C. Fly deploy.** `games/reference-server` handles `SIGTERM` and `SIGINT` by awaiting `WorldServer.stop()` and exiting 0 (0005 Cadence: snapshot on the server shutdown signal; about 10 lines, nothing earlier wires a process signal), and `fly.toml` sets `kill_signal` and a `kill_timeout` long enough for the snapshot. `games/reference-server/Dockerfile` + `fly.toml`: machine size of 0009 Cost target, one volume for `--data`, `--static` (B), `--exit-on-idle`, autostop/autostart with zero minimum machines. Verify: exit on `onIdle` leaves the machine stopped; a dial wakes it (record dial → `Welcome`; it must fit inside `createLink`'s backoff without a user-visible error); monthly cost always-on and idle from Fly's billing page against 0009; tick time under load with `scripts/loadtest.mjs --url wss://… --clients 8 --seconds 120` (headless clients over `wsConnection`) read from the server's stats line.

## Non-scope
Any engine change for DO (if one is needed, that is a finding for the ADR, not a patch here). Bun/Deno deploys. TLS, routing, supervision beyond the two recipes. Any static-host deploy (Cloudflare Pages was not approved, Q6); every static-host listing is docs-only and stated as unverified in the README.

## Files, packages and crates touched
`games/reference-server-do/` (new, maybe deleted), `games/reference-server/` (`--static` handler, Dockerfile, `fly.toml`, `scripts/loadtest.mjs`, README recipes), `games/reference/` (README hosting section, `scripts/check-coi.mjs`, `src/ui/status.ts` for `?linklog=1`), `docs/decisions/<next>-durable-objects-*.md`

## Seams
**Provides:** `games/reference-server --static <dir>`; the open item "COOP/COEP listings on a real static host" for M39b. Recipes: "one Fly machine per world", "one Durable Object per world id" (0009 Consequences).
**Consumes:** `createWorldServer`, `WorldServer.ready`, `HostServices.onFatal` (M27); `Connection`, `HostServices`, `Storage` types (M13, M22); `runStorageConformance` for the DO storage adapter (M22); `attachWebSocketServer`, `games/reference-server`, `wsConnection`, `client.onLink`, the link-log columns of `mp.html?linklog=1` (M29); the reference game's `status.ts` (M34b, M37); `HeadlessClient` (M27); `CloseCode`, `createLink` (M28); bench genesis of `busy-field` (M31); final exports map, so the DO package imports `engine/server` the way a deployer would (M35); host stats line with tick p50/p99 and overruns (M13/M36; add if missing).
**From M36 (orchestrator):** details in [M36 Deviations](36-slow-tier-and-benchmarks.md#deviations). (1) The bench genesis is `buildBench()` (`tests/support/bench-build.ts`, release dir `games/reference/sim/target/engine/release+bench`) with `benchWorldConfig(buildHash, scale, { arenaBytes? })`; scale 1 is the §9 save. ADR 0046 made it fit: full-save genesis is 264 ms release, `memoryBytes` 101,974,016 (the default 96 MiB arena), 0 grows; before it, genesis trapped above the 256 MiB ceiling. The usable-memory item needs the *live* peak, not `memoryBytes`: `budgets.json` `mem.simHighWaterLargeSave` = 92,274,688 B (88 MiB: peak 80 MiB over genesis, 8 maximum-view connections for 80 ticks and one snapshot, x 1.1) with `simHighWaterLargeSaveFormula`; the module has no live-byte ABI export (0014), so the peak is found as the smallest `arenaBytes` with `engine_mem_grows() == 0`, which is how to probe a DO ceiling too. (2) Tick and timer-accuracy figures to compare against: steady-state tick median 2.87 ms native release (`baselines/tick.json`, 8 connections, 0010 proxy 3 ms) and 10.63 ms for the Node `.wasm` twin (`tick-node.json`); the **first tick after genesis visits all 262,144 furnaces (~28 ms)** and a whole-store snapshot stalls the loop 51.3 ms native (proxy 83.3 ms; the `.wasm` costs more, not measured), so expect those two as outliers in p99 and overruns, not as drift. (3) M36 did **not** add a host stats line: `BenchHost` (Rust, `tests/common/bench_host.rs`) and `tick-large-save-node.test.ts` (wraps `worldServerTestHandle(...).stepTick`) time per tick themselves; add the line here if missing, as this brief already says. (4) Release/bench builds share `target/engine/<profile>[+features]` dirs that other tests delete: copy the `.wasm` out and check `sha256 == buildHash` before packaging it for the DO.
**From M36b (orchestrator):** details in [M36b Deviations](36b-suite-audit-and-measurements.md#deviations) and [ADR 0048](../decisions/0048-fast-tier-budgets-dev-loop-and-wire-measurements.md). (1) *Compare against these wire numbers.* Reference game, 200 lit furnaces, one observer, two players taking once a second: observer downlink **839 B/s** (3,148 B/s at 1,000 furnaces; [ADR 0048](../decisions/0048-fast-tier-budgets-dev-loop-and-wire-measurements.md) §6); byte diffing was measured and **closed** (30 % smaller puts, no 36c; non-API option), so do not add it for a host. Feature `measure-diff` (`host/measure_diff.rs`; counters `diff_bytes_whole`/`diff_bytes_masked` are the last 8 bytes of `sim_conn_counters` in feature builds only) stays in the engine crate as a measurement tool; `busy-furnace-field @slow` (`tests/netcode/busy-furnace-field.test.ts`, report `test-results/netcode/busy-furnace-field.json`) is the harness. (2) *Build choices.* `wasm-opt` and `+simd128` stay **off** (1.75 % and 0.18 % brotli; `wasm-opt` remains an opt-in deploy choice, 0045 §1): a Durable Object or Fly image is built from the default release `.wasm`, and its `buildHash` is the identity the clients check. `buildGame({ outDir })` writes `game.wasm`/`game.json` to a private directory when a variant must not overwrite `target/engine/release`. (3) *Cost of CI and local timing.* CI cached build `buildMs` is 208-254 s against M02's 5-minute trigger (85 %); `split-debuginfo = "packed"` makes `target/` about 11 GB. (4) `do/local-smoke` and `deployed/*` are slow-tier, so they add nothing to the fast tier; the fast `reference-server/*` tests are inside the 0020 §4 limits or shrink them (`reference-server/sigterm-snapshots` and `static-headers` spawn processes: time them with `pnpm test:timings`).
**From M37b (orchestrator):** details in [M37b Deviations](37b-device-loss.md#deviations). The deployed Playwright test and any page you add run against a real browser on real hardware, so a WebGPU `uncapturederror` or device loss is a failure there too: the in-repo `openPage` helper now fails a test on either (opt-outs `allowGpuErrors(page)` / `allowDeviceLoss(page)`, only for a test that provokes one), and a page that draws through `createRealFrameLoop` must give it `canvasConfig` matching its pipeline's colour format. On SwiftShader a WebGPU canvas may not present, so a canvas-dependent local test may be `local-only`. Browser suite: 246 tests, ~42 s p95 of 48 s.
**From M37 (orchestrator):** details in [M37 Deviations](37-robustness-events.md#deviations) and [ADR 0050](../decisions/0050-engine-failure-surface.md). A fatal server now calls `HostServices.onFatal` then `stop()` without writing, and closes its sockets; clients reconnect with backoff and pick up a fixed deploy through the version-mismatch path (no new close code). The client surface gained `client.onFatal` (`FatalEvent = { tick, message }`) and `client.onDesync` (`DesyncReport`); the reference game handles every engine event in `games/reference/src/ui/status.ts`. A deployed check that wants a fatal can use `netcode` `fatal: server onFatal stops world and closes sockets` as the model.

## Planning decisions
- **Durable Object adapter and feasibility (PRE-PLAN §10): decided here by measurement,** with the go/no-go rule above fixed in advance so the session does not negotiate with its own numbers. The "adapter" is a recipe package, never an `engine/server/*` entrypoint, per 0009.
- **No static host; the Fly machine serves the client.** Tyler approved the Workers plan and the Fly machine but not a Pages deploy (Q6), and the phone check still needs a deployed, cross-origin isolated page. A static handler next to the `ws` server is the smallest way: one machine, one origin, no CORS or cross-origin `wss` to configure, and the headers are set in code the repo tests (`reference-server/static-headers`). It is a convenience of the reference server, not an engine feature: `engine/server/node` stays free of HTTP (0009). The cost is that 0015's deferred check is not closed; it is handed to M39b rather than quietly dropped.
- **Fly cost is verified, not recomputed,** because autostop with a WebSocket service and exit-on-idle is the part arithmetic cannot show.
- **Link log on the hosted build.** M38-socket-resume needs the on-page link log, and the production build has no test entrypoint. The reference game's `status.ts` (M34b, M37) gets a `?linklog=1` view built from `client.onLink` and `visibilitychange` timestamps only (public API; same columns as M29's `mp.html?linklog=1`: event, state, close code, ms since `visible`). About 30 lines, off unless the parameter is present.

## Order of work
1. B's handler and its test; C: Dockerfile, `fly.toml`, local `docker run` smoke (`check-coi` against `localhost`), deploy, idle/wake, load test, cost.
2. B on the deployment: `check-coi`, deployed Playwright test, `?linklog=1`.
3. A step 1 (local), then step 2 (deploy; start the 24 h run early and read it at the end or in a follow-up session).
4. ADR, READMEs, teardown, results table in Deviations.

## Tests added
Slow tier: `do/local-smoke` (only if go), `deployed/coi-and-online` (runs only with `DEPLOYED_URL`, otherwise reported as skipped by name). Fast tier: `reference-server/docker-args` (Dockerfile and `fly.toml` agree on port, data dir and static dir with the server's CLI; a parse test, no Docker), `reference-server/static-headers` (spawn with `--static <tmp dir>`: both headers with exact values on `/`, a `.js`, a `.wasm` served as `application/wasm`, and a 404; `..` traversal refused; `/ws` still upgrades), `reference-server/sigterm-snapshots` (spawn on a fixture with `--data <tmp dir>`, a headless client acts, `SIGTERM`: the process exits 0 and a second spawn on the same dir resumes at the same tick and hash with no log tail to replay).

## Exit criteria
- [x] `node games/reference/scripts/check-coi.mjs $FLY_URL` exits 0; `DEPLOYED_URL=$FLY_URL pnpm test:slow -t deployed/` passes; `$FLY_URL/?linklog=1` shows the link log.
- [x] `games/reference/README.md` has a Hosting section with the two-header requirement and the per-host listings of 0017 §6 (the values `check-coi.mjs` asserts) and the hosting limits of 0015 Consequences. It and Deviations both state that the static-host COOP/COEP listings (0015 §3) are unverified, and `39b-phase-4-handoff.md`'s open item still names it.
- [x] The fast-tier tests above pass by name (`sigterm-snapshots` moved to `@slow` at the gate: two process spawns cannot meet the 500 ms p95; Deviations).
- [ ] Deviations holds the results table: DO memory, timer p50/p99, projected monthly cost, restarts; Fly always-on and idle cost, wake time, tick p50/p99 under 8 clients.
- [x] The DO ADR exists and `PLAN.md` "Plan-level decisions" lists it.
- [ ] Both recipes are in `games/reference-server/README.md`; cloud resources are torn down.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test -t reference-server/` · `node games/reference/scripts/check-coi.mjs <url>` · `DEPLOYED_URL=<url> pnpm test:slow -t deployed/` · `node games/reference-server/scripts/loadtest.mjs --url <wss url> --clients 8 --seconds 120` · `pnpm lint`

## Budgets
PRE-PLAN §7 "Hosting cost": Fly and Cloudflare billing pages after the runs. "Tick time" on the slowest host (Fly row of 0010's tick budget): `loadtest.mjs` + the stats line.

## Context artifacts
`games/reference-server/README.md` recipes; `games/reference-server-do/CLAUDE.md` if the package stays. No skill: deploys are rare and the README is the procedure.

## Manual device checks
[device-checks.md, M38: Hosted deployment](device-checks.md#m38-hosted-deployment). Run on the iPhone on cellular against the Fly URL (client and `/ws` on one origin).

## Deviations

### Cloud resources (record for teardown, step 4)

Created 2026-10-02 by the step 1-2 session. Nothing else exists in the Fly org `personal`.

| Resource | Id / name | Region | URL |
|---|---|---|---|
| Fly app | `engine-v2-ref` (org `personal`) | `ord` | https://engine-v2-ref.fly.dev |
| Fly volume | `vol_re1j5dn5gz5p16l4` (`world_data`, 1 GB, encrypted, snapshots on) | `ord` | n/a |
| Fly machine | `83519ec7970218` (`billowing-fog-8944`, `shared-cpu-1x:512MB`, volume attached) | `ord` | n/a |
| IPs (free) | shared v4 66.241.124.2, dedicated v6 2a09:8280:1::1a4:4c5d:0 | n/a | n/a |
| Cloudflare Worker (step 3) | `engine-v2-ref-do`, DO namespace class `WorldDO` (SQLite-backed, migration `v1`); bench scale 1 payload, arena 96 MiB; **the measured one: do not redeploy during the 24 h run** | account `83c4b0d34a69f15c26049dfcb5165802` | https://engine-v2-ref-do.reference-server-do.workers.dev (worlds `day24b` = the 24 h run; `day24`, `probe`, `probe2` = short runs) |
| Cloudflare Worker (step 3, probes) | `engine-v2-ref-do-probe`, class `WorldDO`; redeployed many times with different payloads (scale/arena), `ALLOW_ALLOC` var on some deploys | same | https://engine-v2-ref-do-probe.reference-server-do.workers.dev (many world ids, all disposable) |
| workers.dev subdomain | `reference-server-do` (registered by the first `wrangler deploy`, account level) | n/a | n/a |

Teardown for the two Workers (and their objects' storage): `wrangler delete --name engine-v2-ref-do` and `wrangler delete --name engine-v2-ref-do-probe` (after the 24 h log is read). The subdomain stays on the account (Tyler can rename it in the dashboard).

Teardown: `fly apps destroy engine-v2-ref --yes` (removes the machine and volume with it; confirm with `fly volumes list -a engine-v2-ref` and `fly apps list`). Local leftovers: docker image `engine-v2-ref:local` (`docker rmi`).

### Steps 1-2 (B, C, B on the deployment): done 2026-10-02

Commits `791af6b`, `484e634`, `6927376` (and the CLAUDE.md edit after them). Steps 3 (Durable Objects) and 4 (ADR, READMEs, teardown, the full results table) are open. **Nothing has been torn down: the app, machine and volume above stay up for step 4 and Tyler's device check.**

**Seams as built**
- `games/reference-server/index.mjs`: a `node:http` server on `PORT` (default 4174) and `HOST` (default `127.0.0.1`; the image sets `0.0.0.0`) with `ws` in `noServer` mode. New flags `--static <dir>` and `--stats-every <s>`. With `--static` only `/ws` upgrades; without it any path does (existing tests and `device:serve` dial `/`-less URLs). The listening line is `listening: ws://<HOST>:<port>`.
- `games/reference-server/static.mjs`: `staticHandler(dir)` and `ISOLATION_HEADERS`. 200/403/404/405 all carry both headers; `/assets/*` is `public, max-age=31536000, immutable`, everything else `no-cache`.
- `games/reference-server/scripts/stage-image.mjs` (fills `.stage/`, refuses a client whose `.wasm` differs from the release build's `buildHash`), `Dockerfile` (node:22-slim, `npm install ws@8.18.3`, `COPY .stage/ /app/`), `.dockerignore`, `fly.toml` (`ord`, `shared-cpu-1x` 512 MB, `kill_signal = 'SIGTERM'`, `kill_timeout = 30`, `[[mounts]] world_data -> /data`, autostop `stop`, autostart, `min_machines_running = 0`, restart `on-failure`). Deploy: `fly deploy --remote-only --config fly.toml --dockerfile Dockerfile` from `games/reference-server`.
- `games/reference-server/scripts/loadtest.mjs --url <wss url> --clients N --seconds S [--trace] [--game dir]`; imports the built engine by relative path (`packages/engine/dist/...`) because `wsConnection` and `parseBuildHash32` are not public exports. The loadtest reports client-side numbers only; the tick time is the server's `stats:` line.
- `games/reference/scripts/check-coi.mjs <url>`; `games/reference/src/ui/status.ts` `createLinkLog` / `linkLogRow` (rows `link <state>` from `client.onLink`, and `visible`/`hidden` from `visibilitychange`; the close-code column reads `-` because `onLink` carries no code; `client.debug.linkLog()` has it but the brief said public `onLink` only), wired in `game.ts` for a remote host with `?linklog=1`.
- Tests: `packages/engine/tests/netcode/reference-server-{static-headers,sigterm-snapshots,docker-args}.test.ts` (fast, `netcode` suite), helper `tests/support/reference-server.ts`; `packages/engine/tests/browser/packaging/deployed-coi-and-online.spec.ts` (title `deployed/coi-and-online @slow`, `packaging` leg, after the gc projects; without `DEPLOYED_URL` it is `test.skip`ped and `packaging.log` reads `1 skipped`).

**Differences from the brief**
1. SIGTERM/SIGINT handling already existed (`index.mjs` called `server.stop()` then `process.exit(0)`); nothing was added, `sigterm-snapshots` proves it.
2. **Defect found (engine; FIXED in `60e373c`, see "Engine fix" below): a `Hello` sent on a connection that `createWorldServer.accept` only queued before `ready` is lost.** `SimHost.accept` wires `onMessage` later, and `wsSocketConnection`'s `onMessage?.()` drops what arrived before. The client then waits out its link timeout (a measured 3 s on the second spawn of `sigterm-snapshots`; the same on a woken Fly machine). (The interim reference-server workaround, the `101` waiting for `server.ready`, was removed with the fix.)
3. Cold wake exceeds `DEAD_MS` (3,000 ms, `net/link.ts`). `loadtest --trace` on a stopped machine: `+30ms linkUpCount=1`, `+3049ms linkUpCount=2` (the dead timer redialled while the first socket was still connecting), `+3608ms live=true`, then a third up at `+6774ms`, `link_downs=0`, no error. Warm: one up, live at 0.33-0.42 s, no further ups in 14 s. No error screen in Chromium (below); the `reconnecting` line can appear after its 1 s indicator delay. M38-socket-resume reads this from the on-page log.
4. A machine woken by a page load or by a dial that never completes a handshake never reaches `onIdle` (it fires after a *player* leaves), so it stays up until Fly's own autostop: observed 6 min 31 s (woken 15:37:54, stopped 15:44:25). A real session ends with `onIdle` ~30 s after the last player leaves (grace skipped by `Bye`; ~40 s when the tab just closes).
5. `--stats-every` and `HOST` are additions (the brief says to add the stats line "if missing"; it was).
6. `fly.toml`'s `app = 'engine-v2-ref'`; `pnpm test:slow -t deployed/` runs all suites' empty greps and prints `pass 0 tests` for them, as before.

**Results (Fly, `ord`, `shared-cpu-1x` 512 MB, one volume, the reference game, 2026-10-02)**

| Item | Result |
|---|---|
| `check-coi.mjs https://engine-v2-ref.fly.dev` | exit 0; `/`, `/assets/worker-auto-CgtGMr1p.js`, `/assets/game-CatFMxyy.wasm`, `/tiles.png` (200) and `/no-such-file-m38` (404) all `COOP=same-origin COEP=require-corp` |
| `DEPLOYED_URL=... pnpm test:slow -t deployed/` | `browser pass 1 tests 9.2s`; `deployed/coi-and-online: online 4918 ms after navigation` (that load woke a stopped machine); local container run: 4.6 s |
| `?linklog=1` in Chromium on a cold machine | page load 4,002 ms (the load woke it), states `connecting` at 4,019 ms then `online` at 4,893 ms, `crossOriginIsolated` true; the on-page log read `link online code=- sinceVisible=881ms` / `link connecting ... 459ms` / `link connecting ... 0ms` |
| Idle stop | last client `Bye` 15:31:28 -> `Main child exited normally with code: 0`, machine `stopped` 15:31:58 (about 30 s, `onIdle`) |
| Wake (stopped machine) | `curl /`: 3.71 s total; Node `WebSocket` open: 4.07 s; headless client dial -> `Welcome` 3,652, 3,415 and 3,632 ms (warm: 342-424 ms); Chromium page load 4.0 s + 0.9 s to `online`. Fly's own `machine started in 1.43 s`, the rest is Node start + a refused first proxy connect ("instance refused connection") retried |
| Load, 8 clients 120 s (`loadtest`) | `live_at_end=8/8 welcome_ms min=364 max=424`; server `stats:` windows of 10 s, 12 of them under load: tick p50 0.06-0.43 ms (median 0.13), window p99 0.79-5.02 ms (median ~2.4), max single tick 7.90 ms, `overruns=0` throughout, 196-199 ticks per window (20 Hz). Budget 0010: 10 ms per tick. Small reference world, not the large save |
| Cost, computed (the billing page is not readable from the CLI) | Fly's pricing page constants: shared CPU 8.465e-7 $/vCPU-s, RAM 2.316e-6 $/GB-s with 0.25 GB per shared vCPU included, volume and stopped-rootfs $0.15/GB-month, shared IPv4 and Anycast IPv6 free, region table `ord` markup 1.25. 30-day always-on: (2.194 + 1.501) = **$3.69** at the base rate, **$4.62** if the `ord` markup applies (ADR 0009 says $3.32; the page's own numbers do not reproduce it); plus the volume $0.15. Idle (stopped): volume $0.15 + rootfs 0.07 GB ~ $0.01 = **about $0.16/month** ($0.20 with markup); volume snapshots (5-day retention, a few KB) negligible. **Always-on and idle rows awaiting Tyler for the billed number:** https://fly.io/dashboard/personal/billing -> "Upcoming invoice" and Cost Explorer for `engine-v2-ref`; today's compute is about 30 minutes of started time (cents) |

**Fast-tier timings** (`pnpm test:timings --fresh --runs 3`, whole fast tier, load 2-19): `reference-server/docker-args` 2 ms; `reference-server/static-headers` 243, 260, 257 ms; `reference-server/sigterm-snapshots` 667, 706, 684 ms in the full tier (456-478 ms alone, 8 runs). The 0020 section 4 limit is 500 ms p95: **`sigterm-snapshots` is over it under full-tier load** (two real process spawns, about 250 ms each); I shrank it from 1,275 ms (poll for the ack instead of sleeping) and cannot reach 500 ms in the full tier with two spawns. Decision for the orchestrator: accept, or tag it `@slow`. Fast `netcode` suite 4.0-4.2 s of 10 s; browser suite 43-44 s of 48 s (unchanged: nothing was added to it).

**Inject-fail-revert on `static-headers`** (404 replies with COOP only): `FAIL netcode reference-server/static-headers  AssertionError: a 404 COEP: expected null to be 'require-corp'`; reverted, green.

**Notes for later steps:** the `deployed/` test and `check-coi` both pass with the machine cold or warm. `.stage/` is rebuilt by `stage-image.mjs` (run it right after `pnpm --filter reference build`: the `pnpm test` `reference` step rebuilds `games/reference/dist` with `--minify false`). A DO host must also not accept before `ready` (item 2).

### Engine fix: a connection accepted before `ready` keeps what it sends (`60e373c`)

Files touched grows by `packages/engine/src/server.ts` (`createWorldServer`) and `packages/engine/tests/netcode/accept-before-ready.test.ts`.
- **Diagnosis (measured):** a netcode test that calls `server.accept(conn)` before `ready` and then `conn.onMessage?.(hello)` printed `DIAG after pre-ready accept: conn.onMessage = null` (the adapters, `wsSocketConnection` included, call `conn.onMessage?.()`): the `Hello` is lost at the adapter's null handler, because `accept` only pushed the connection on `pendingConnections` and `SimHost.accept` (which wires `onMessage`) ran after `ready`. Unfixed, the test failed `expected 0 to be greater than or equal to 1` (no `Welcome`).
- **Fix:** pre-`ready` `accept` installs buffering `onMessage`/`onClose` (bytes copied) and, after `h.accept(c)`, replays the buffered messages and a recorded close through the real handlers.
- **Test:** `accept-before-ready: a Hello delivered before ready is answered with a Welcome` (fast, netcode): `Hello` delivered before `ready` resolves, manual tick timer, no wall clock, asserts a `Welcome` (first byte 0x03) and no close. Inject-fail-revert: red on the unfixed engine (above), green with the fix.
- **The reference-server workaround is removed;** `reference-server/sigterm-snapshots @slow` (moved to the slow tier on the coordinator's ruling, assertions unchanged) now covers the fix (dial while loading, live in under 1.5 s): 3 slow runs green, `reference-server/` slow netcode 35 s.
- **Ledger:** the "rejected-`Hello`-settle stall" row (`deferred-ledger.md`) is a different defect (`hashSecretHex`/`sessions.save` rejecting leaves the attach-queue slot unfilled); not closed here.
- **Redeployed** (same app/machine/volume; image `deployment-01M3YNEP03QF2B1TXXXN7...`, engine `dist` with the fix). `check-coi` exit 0 (all five rows) and `deployed/coi-and-online` pass: `online 1220 ms after navigation` (warm machine).
- Page-only wake costing up to Fly's autostop (observed 6 min 31 s) is accepted; it goes in the README in step 4 (also item 4 above).

### Step 3 (A: Durable Objects): done 2026-10-02, 24 h run pending

Commits `bea151f`, `7c54e42` (and this Deviations commit). Steps 4 (ADR, READMEs, teardown) open. Evidence and logs under `test-results/m38-do/` (gitignored; the 24 h log is `24h.jsonl`).

**Package `games/reference-server-do/`** (plain `.mjs`, `wrangler.toml`, `CLAUDE.md`): `src/worker.mjs` (Worker routes `/ws/<id>`, `/stats/<id>?since=<seq>`, `/alloc/<id>` only with `--var ALLOW_ALLOC:1`; class `WorldDO`), `src/storage.mjs` (`doStorage(ctx.storage)`, `PART_BYTES` = 1 MiB parts `p/<key>/<gen>/<seq>` + `idx`), `scripts/stage.mjs <puts|reference|bench> [--scale n] [--arena-mib n]` (copies the `.wasm` out of `target/`, sha256 == buildHash), `smoke.mjs`, `measure.mjs`, `summarize.mjs`, `probe-memory.mjs`, `probe-recovery.mjs`. Tests: `do/storage-adapter` (fast, netcode; passes `runStorageConformance` on a `ctx.storage` double, plus multi-part, cut-threshold, replace and reopen checks) and `do/local-smoke` (`netcode`, slow tier, `test.skip` until the ADR decides; run once unskipped: `netcode pass 1 tests 9.3s`, join, act, reconnect, `kill -9` of `wrangler dev`, restart on the same storage, `motd` 7 still there). It sits in `netcode`, which is solo in the slow tier, so it cannot overlap the `packaging` leg. `pnpm-lock.yaml` gains the importer. Biome keeps `games/reference-server-do` under lint; `wrangler` is the global CLI (4.145.0), not a dependency.

**Adapter facts a deployer needs (found by running it, no engine change made):** `Connection.send` receives `(cls, bytes, len?)` and must honour `len` (the engine's buffer is 64 KiB); workerd's server `WebSocket.binaryType` defaults to `blob`, set `'arraybuffer'`; without `HostServices.scheduler` `onIdle` never fires; `serverInternals`/`worldServerTestHandle` (`engine/server`) give `memGrows`, wasm memory bytes and the host counters for `/stats`. `compatibility_date = 2026-06-01` accepted. A DO accepts a connection before `ready` (60e373c).

**Local smoke (step 1), final code:** `node scripts/smoke.mjs --url ws://localhost:8807/ws/smoke` against `wrangler dev --local`:
```
PASS join: live=true tick=0 in 118 ms
PASS act: ackSeq=1 (seq 1) motd=7 replicaHash=ed17f20e22594569
PASS reconnect: linkUpCount=2 live=true back in 221 ms replicaHash=ed17f20e22594569 (same: true)
```
**Deployed:** https://engine-v2-ref-do.reference-server-do.workers.dev (Workers Paid accepted the DO binding and the 100 MiB-memory genesis; nothing was refused for plan or billing reasons). The first deploy needed ~1 min before TLS worked.

**Deployed measurements (bench scale 1 = 262,144 furnaces, arena 96 MiB, `memoryBytes` 101,974,016 = M36's figure, 2 headless observers over `wss`, 20 Hz, one object `day24b`, observers dispatch `CancelCollect` every 20 s so the world is dirty and a snapshot is written every 1,200 ticks)**

| Item | Result | Command |
|---|---|---|
| Instantiate + bench genesis in the object | live 1.4 s after dial (genesis 264 ms release natively) | `measure.mjs` probe, `test-results/m38-do/probe.jsonl` |
| Memory, first hour of the 24 h run | 360 windows, `memGrows` 0, no restart, no fault; wasm memory 101,974,016 B constant | `node scripts/summarize.mjs test-results/m38-do/24h.jsonl --to 1790962640000` (`first-hour-summary.txt`) |
| Timer, 30 min and 60 min, 2 clients | host counters `ticksRun` 72,000 = 20.0 Hz, `ticksDropped` 0, `tickOverruns` 0; client tick 71,992 after 3,600 s = 19.998 Hz. **Server-side tick intervals are not measurable in workerd**: the clock only advances at I/O, so the object reads exactly 50.00 ms (p50 = p99 = max) for every callback and a callback's own duration as 0 ms (locally the same code reads 53 ms and 0-3 ms, because the clock is real there). What is observable: the downlink message arrival gap at the clients, one message per tick: median p50 49.81 ms, median per-10 s p99 61.7 ms, p99 of those p99s 589 ms, worst single 3.2 s (client 1 had three link re-ups in the hour, the object never restarted: network, not the host) | `first-hour-summary.txt` |
| Snapshot path in the object | scale 1 snapshot = 13 parts (~12.5 MiB), written at ticks 1,200 and 2,400 without a fault or restart; scale 4 = 4 parts | `/stats` `storageIndex`, `probe-snap.jsonl` |
| Arena 128 MiB (past the 0015 section 5 96 MiB ceiling) on a fresh world | instantiates, genesis, ticks, `memBytes` 135,528,448, 60 s, no fault | `probe-128.jsonl` |
| JS heap headroom on a fresh scale-1 world | +96 MiB of touched JS heap held, then the object reset at the next +8 MiB | `probe-memory-96.txt` |
| **Restart path: reload a world that has a snapshot** | **fails**: the object reaches `ready`, writes the epoch bump, then is reset before its first tick (`Durable Object connection closed because the object was reset`), over and over (10-13 restarts in 40 s). Scale 1 / 96 MiB (13 MiB snapshot), scale 4 / 96, 64 and 48 MiB: all fail. Scale 4 / 40 and 32 MiB, scale 16 / 24, scale 64 / 16: recover. The same code recovers on `wrangler dev --local` (no limit) | `scripts/probe-recovery.mjs`, `test-results/m38-do/recovery-*.txt` |
| Billing, 24 h | **pending**, see below | |

Why the restart path fails (diagnosed, not fixed): `Persistence.open` instantiates a probe instance for the `chunk_bits` check and `loadLatest` a second one for the restore, and neither is released before the first GC. Node: `WebAssembly.Instance` count 1 on genesis, 2 on a restore; scale 1 / 96 MiB `external` 99 MiB -> 221 MiB, RSS 111 -> 213 MiB (`$S/rss2.mjs`, session-local). A fresh world uses one instance. Memory is the strongest fit (a threshold between 40 and 48 MiB arenas at scale 4, none with small states), but the isolate's accounting is not documented: a single 128 MiB-arena instance (135 MB) passes while two 48 MiB ones fail, so the unit that counts is not simply the reserved bytes. An engine change (release the probe instance, restore into it) might make go possible; **that is a finding for the ADR, not a patch here** (brief Non-scope).

**Go/no-go as fixed in advance (go needs all of the following):**
1. Cost within the $5 plan for an always-available world: projected, **met**. Duration 0.125 GB x 86,400 s x 30 = 324,000 GB-s of the 400,000 included; uplink 17.0 messages/s for 2 observers (8.5 per client; the heartbeat/view traffic dominates) = 2.2 M billed requests/month at 20:1 for 2 clients, 1 M included then $0.15/M = about $0.18 over (about $1.2 over for 8 players); rows written are far inside the 50 M included. Prices fetched from developers.cloudflare.com/durable-objects/platform/pricing today. The dashboard figure is pending the 24 h run.
2. No tick throttling: **met** (20.0 Hz, 0 drops, 0 overruns, 60 min).
3. Usable memory at the ceiling (PRE-PLAN section 9 risk 5: "< 96 MiB usable"): **NOT met** on the restart path (usable arena between 40 and 48 MiB at scale 4; no arena holds the scale 1 save). Met for a fresh world only.
4. At most one restart per hour while connected: **pending the 24 h run** (0 in the first hour, 1 constructor run in 60 min).
**Rule outcome: NO-GO on item 3 already.** Nothing can restore it except an engine change, which the brief hands to the ADR. Items 1 (billing) and 4 are still pending; the 24 h observers keep logging and show what a restart does to a scale 1 world (it should not come back).

**24 h run (detached; read it in a later session)**
- Started 2026-10-02 16:37:01 UTC (epoch ms 1790959021188), ends by itself 2026-10-03 16:37:01 UTC; hard cap `timeout 25h` = 17:37 UTC.
- PIDs: `timeout` 45054 (parent), `caffeinate` 45056, `node measure.mjs` 45057. Stop early: `kill 45054` (writes the `summary` row). `caffeinate -i` stops idle sleep; closing the lid or a power-off ends the run (the log then shows a `summary` row missing).
- Log `test-results/m38-do/24h.jsonl` (one JSON row per event; `window` rows are the object's own 10 s windows polled every 60 s; `starts` rows list every constructor run of the object), stdout `24h.stdout`. Read: `node games/reference-server-do/scripts/summarize.mjs test-results/m38-do/24h.jsonl` (restarts = "object starts" minus 1; "link transitions ... with a recorded down" lists client-side drops with times). A first run without actions (`24h-first-no-actions.jsonl`, world `day24`, 10 min) was stopped and replaced because a world with no logged action never dirties, so no snapshot was exercised.
- The measured Worker runs the code of `bea151f` plus the stats additions of `7c54e42` only in the *probe* Worker: the main Worker has the earlier `/stats` (no `storageIndex`, no `/alloc`). Same engine path.
- **Billing: read in Tyler's Cloudflare dashboard**, not available to the CLI: https://dash.cloudflare.com/83c4b0d34a69f15c26049dfcb5165802 -> Workers & Pages -> Durable Objects -> `WorldDO` (metrics: requests, wall-clock duration GB-s, rows read/written; filter to the namespace of `engine-v2-ref-do`), and Account Home -> Billing -> Billable usage (month to date; includes the probe Worker, which ran for about two hours). Compare the 24 h delta with 324,000 GB-s/month projected (10,800 GB-s/day) and 73,000 billed requests/day.
- Observers' own request counts (client `sent`, per `status` row) are the 20:1 input in the table above.

**Differences from the brief:** (1) the "1 h memory" and "30 min timer" runs are slices of the one 24 h run (same object, so the billing is one clean number) rather than separate runs. (2) "tick interval p50/p99 and overrun counter" are reported from the clients plus the engine's host counters because the object's own clock is I/O-driven. (3) `do/local-smoke` also kills the runtime hard and checks recovery (a small world, genesis replay of the log: no snapshot is reached in 10 s). (4) Two more Cloudflare resources than the brief expects (the probe Worker and the account subdomain). (5) Diagnostic exports used in the DO (`serverInternals`, `worldServerTestHandle`) are test-only re-exports of `engine/server`; the ADR should say the recipe does not need them.

**Notes for the ADR and later briefs:** record the restart-path finding and the instance-count cause; the deploy of any new version resets every object (observed), so a world on a DO that fails to reload is down until fixed; `wrangler dev --local` does not reproduce the limit, so only a deployed run proves a DO claim.

### Step 4: ADR, READMEs, teardown, results (2026-10-02)

- ADR: [0051 Durable Objects: no-go](../decisions/0051-durable-objects-no-go.md) (amends 0009 §Targets). `games/reference-server-do/`, `do/local-smoke`, `do/storage-adapter` deleted (no `suites.mjs` row existed; lockfile importer removed); the root `CLAUDE.md` ADR range reads 0001-0051; `PLAN.md` is the orchestrator's. The 24 h run was stopped at 1 h 2 min on the orchestrator's decision (`test-results/m38-do/summary-final.txt`).
- **Cloudflare torn down:** `wrangler delete --name engine-v2-ref-do --force` and `--name engine-v2-ref-do-probe --force` both printed `Successfully deleted`; `wrangler deployments list --name <each>` now answers `This Worker does not exist on your account. [code: 10007]`, and `curl .../stats/x` on the old URL returns 404. The `reference-server-do` workers.dev subdomain is account-level and wrangler 4.145 has no command for it: Tyler removes or renames it in the dashboard, https://dash.cloudflare.com/83c4b0d34a69f15c26049dfcb5165802/workers/subdomain (Workers & Pages -> Overview -> Account details -> Subdomain).
- **Fly kept on purpose** for Tyler's iPhone device check: app `engine-v2-ref` (machine, 1 GB volume), idle cost about $0.16/month. Teardown: `fly apps destroy engine-v2-ref --yes`.
- READMEs: `games/reference/README.md` Hosting section (two headers, per-host listings marked from documentation and unverified, 0015 limits, the static-host check unverified and carried to M39b); `games/reference-server/README.md` Fly recipe and a Durable Objects paragraph pointing at 0051. `39b-phase-4-handoff.md` already names the static-host item (its "Open items carried forward").
- Deferred-ledger row added: `Persistence.open` instantiates twice on a restore.

**Results table**

| Item | Result |
|---|---|
| DO usable memory | fresh scale-1 world: 96 MiB and 128 MiB arenas run, `memGrows` 0; **restore from a snapshot: reset before the first tick** (scale 1 at 96 MiB; scale 4 fails at 48 MiB and up, recovers at 40 MiB and down) |
| DO timer p50/p99 | server clock is I/O-driven (reads 50.00 ms); engine counters 0 drops, 0 overruns, 20.0 Hz over 1 h; client downlink gap median 49.8 ms, p99 about 62 ms (worst 3.2 s, a network blip) |
| DO projected monthly cost | 324,000 GB-s of 400,000 included; 2.2 M billed requests for 2 clients (about $0.18 over); inside the $5 plan; dashboard not read |
| DO restarts | 0 in the first hour (one object start); 24 h not collected |
| Fly always-on / idle cost | computed $3.69-4.62 + $0.15 volume / about $0.16; **billed figures awaiting Tyler**: https://fly.io/dashboard/personal/billing -> "Upcoming invoice" and Cost Explorer for `engine-v2-ref` |
| Fly wake time | cold 3.4-4.1 s dial to `Welcome` (one redial), warm 0.34-0.42 s |
| Fly tick p50/p99, 8 clients | p50 0.06-0.43 ms, window p99 about 2.4 ms (max 7.9 ms), 0 overruns |

### Orchestrator gate (M38)

`pnpm test && pnpm lint` green at `443ab9b` + record (rust 771, unit 328, wasm 172, netcode 133, browser 256 at 44 s). Rulings: `sigterm-snapshots` → `@slow`; the pre-`ready` `Hello` drop fixed in the engine (`60e373c`), and `server/accept-before-ready-waits` rewritten at the gate to assert its intent (no send before `ready`, the host's handler after) instead of a null `onMessage` (`0f1757e`); cold-wake redial and page-only wake accepted. **Durable Objects: no-go** on the memory criterion, by the rule fixed in advance ([ADR 0051](../decisions/0051-durable-objects-no-go.md)); the 24 h run was stopped at 1 h 2 min because it could not change the outcome (0 restarts, 74,400 ticks, 0 overruns in that hour). The Cloud resources table above lists the two Workers as created; both were deleted in step 4. Unticked, awaiting Tyler (`questions-for-tyler.md`): the Fly billed cost, and `fly apps destroy engine-v2-ref --yes` after the M38 device check; the `reference-server-do` workers.dev subdomain is removed in the Cloudflare dashboard.
