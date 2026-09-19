# M38: Hosting checks

Status: not started · After: 35, 31 (run after 34 when possible, so the reference game is the payload; otherwise the `busy-field` fixture) · Tyler-dependent: no (Q6 answered: the $5 Cloudflare Workers plan and a Fly machine with a 1 GB volume are approved; the Cloudflare Pages deploy is **not**). Tyler logs the CLIs in

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
- [ ] `node games/reference/scripts/check-coi.mjs $FLY_URL` exits 0; `DEPLOYED_URL=$FLY_URL pnpm test:slow -t deployed/` passes; `$FLY_URL/?linklog=1` shows the link log.
- [ ] `games/reference/README.md` has a Hosting section with the two-header requirement and the per-host listings of 0017 §6 (the values `check-coi.mjs` asserts) and the hosting limits of 0015 Consequences. It and Deviations both state that the static-host COOP/COEP listings (0015 §3) are unverified, and `39b-phase-4-handoff.md`'s open item still names it.
- [ ] The fast-tier tests above pass by name.
- [ ] Deviations holds the results table: DO memory, timer p50/p99, projected monthly cost, restarts; Fly always-on and idle cost, wake time, tick p50/p99 under 8 clients.
- [ ] The DO ADR exists and `PLAN.md` "Plan-level decisions" lists it.
- [ ] Both recipes are in `games/reference-server/README.md`; cloud resources are torn down.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test -t reference-server/` · `node games/reference/scripts/check-coi.mjs <url>` · `DEPLOYED_URL=<url> pnpm test:slow -t deployed/` · `node games/reference-server/scripts/loadtest.mjs --url <wss url> --clients 8 --seconds 120` · `pnpm lint`

## Budgets
PRE-PLAN §7 "Hosting cost": Fly and Cloudflare billing pages after the runs. "Tick time" on the slowest host (Fly row of 0010's tick budget): `loadtest.mjs` + the stats line.

## Context artifacts
`games/reference-server/README.md` recipes; `games/reference-server-do/CLAUDE.md` if the package stays. No skill: deploys are rare and the README is the procedure.

## Manual device checks
[device-checks.md, M38: Hosted deployment](device-checks.md#m38-hosted-deployment). Run on the iPhone on cellular against the Fly URL (client and `/ws` on one origin).

## Deviations
