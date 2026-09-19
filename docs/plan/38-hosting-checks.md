# M38: Hosting checks

Status: not started · After: 35 (run after 34 when possible, so the reference game is the payload; otherwise the `busy-field` fixture) · Tyler-dependent: Q6 (`docs/plan/questions-for-tyler.md`); default assumed: all three approved, i.e. the $5 Cloudflare Workers plan, a free Pages deploy, a Fly machine with a 1 GB volume, and Tyler logs the CLIs in

## Goal
Three claims that Phase 1 could only compute are measured on real hosts: a Durable Object can (or cannot) host a world within 0009's constraints and cost target, the COOP/COEP listing works on one real static host including a cross-origin `wss`, and the reference server on Fly meets the cost target with idle stop and wake. The Durable Objects outcome is recorded as a new ADR.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0009-transport-and-hosting.md` (Targets, Durable Objects constraints, Cost target, Consequences: recipes and the deferred feasibility list)
3. `docs/decisions/0015-threads-memory-and-topology.md` (§3 cross-origin isolation, per host; §5 sim arena ceiling on Durable Objects)
4. `docs/decisions/0005-persistence-and-recovery.md` (Storage interface and the adapter table: object-store row)

Mine from spikes: `spikes/cross-origin-sab/RESULT.md` §4 (header listings, docs-only so far). Skill: `write-adr`.

## Scope
**What Tyler does (about 15 minutes):** create or confirm the Cloudflare and Fly accounts with a payment method, upgrade Workers to Paid, run `wrangler login` and `fly auth login` in the session's terminal. The session does everything else through the CLIs and tears down at the end (`fly apps destroy`, delete the Worker and Pages project; Tyler downgrades the plan). Expected spend under $10.

**A. Durable Objects feasibility and adapter.**
- New private package `games/reference-server-do/`: a Worker that routes `/ws/<worldId>` to one DO per id; the DO imports `game.wasm` as a precompiled module and takes `buildHash` from `game.json` (0017 §5), calls `createWorldServer` from `engine/server`, and supplies `Connection` over the standard WebSocket API (not Hibernation, 0009), `Storage` as numbered part objects over DO storage (0005 adapter table), `timer` from `setInterval`, `clock`, and `onIdle` (clears the timer so the object becomes evictable).
- Step 1, no account needed: it runs under `wrangler dev --local` and a headless client joins, acts, reconnects. This alone proves the claim 0009 makes for DO: the library assumes no process, filesystem or HTTP server.
- Step 2, deployed, payload with `arenaBytes` at the 0015 §5 DO ceiling: measure the four items of 0009 Consequences: usable memory (instantiate, fill with the bench genesis, tick 1 h), timer accuracy (tick interval p50/p99 and the host's overrun counter over 30 min with 2 clients; note workerd's clock only advances on I/O), billing (duration, requests at the 20:1 message ratio, any CPU charge, read from the dashboard after a 24 h connected run and projected to a month), restarts (count in 24 h with a client attached).
- Go/no-go → ADR via `write-adr`. **Go** needs all of: the PRE-PLAN §9 risk 5 triggers not hit (cost within the $5 plan for an always-available world, no tick throttling, usable memory at the ceiling), and at most one restart per hour while connected. On go: DO is a supported second target, the package stays as the documented recipe (0009 Consequences: no engine code), and `do/local-smoke` joins the slow tier. On no-go: the ADR supersedes 0009's target list, the package is deleted, the measurements live in the ADR.

**B. COOP/COEP on a real static host.** Cloudflare Pages (free tier, same account): `games/reference/public/_headers` from the spike listing; deploy `vite build`. `scripts/check-coi.mjs <url>` asserts both headers, exact values, on `/`, the hashed worker script, the `.wasm`, one image and a 404. One env-gated Playwright test opens the deployed page: `crossOriginIsolated`, workers ready, WebGPU adapter present, and the page reaches `online` against the Fly origin, which verifies the untested sentence of 0015 §3 about cross-origin `wss`.

**C. Fly deploy.** `games/reference-server/Dockerfile` + `fly.toml`: machine size of 0009 Cost target, one volume for `--data`, `--exit-on-idle`, autostop/autostart with zero minimum machines. Verify: exit on `onIdle` leaves the machine stopped; a dial wakes it (record dial → `Welcome`; it must fit inside `createLink`'s backoff without a user-visible error); monthly cost always-on and idle from Fly's billing page against 0009; tick time under load with `scripts/loadtest.mjs --url wss://… --clients 8 --seconds 120` (headless clients over `wsConnection`) read from the server's stats line.

## Non-scope
Any engine change for DO (if one is needed, that is a finding for the ADR, not a patch here). Bun/Deno deploys. TLS, routing, supervision beyond the two recipes. Netlify/Vercel listings (docs-only, stated as such in the README).

## Files, packages and crates touched
`games/reference-server-do/` (new, maybe deleted), `games/reference-server/` (Dockerfile, `fly.toml`, `scripts/loadtest.mjs`, README recipes), `games/reference/` (`public/_headers`, README hosting section, `scripts/check-coi.mjs`), `docs/decisions/<next>-durable-objects-*.md`

## Seams
**Provides:** nothing other milestones call. Recipes: "one Fly machine per world", "one Durable Object per world id" (0009 Consequences).
**Consumes:** `createWorldServer`, `WorldServer.ready`, `HostServices.onFatal` (M27); `Connection`, `HostServices`, `Storage` types (M13, M22); `runStorageConformance` for the DO storage adapter (M22); `attachWebSocketServer`, `games/reference-server`, `wsConnection` (M29); `HeadlessClient` (M27); `CloseCode`, `createLink` (M28); bench genesis of `busy-field` (M31); final exports map, so the DO package imports `engine/server` the way a deployer would (M35); host stats line with tick p50/p99 and overruns (M13/M36; add if missing).

## Planning decisions
- **Durable Object adapter and feasibility (PRE-PLAN §10): decided here by measurement,** with the go/no-go rule above fixed in advance so the session does not negotiate with its own numbers. The "adapter" is a recipe package, never an `engine/server/*` entrypoint, per 0009.
- **Static host = Cloudflare Pages:** one account for A and B, `_headers` is the same syntax as Netlify's, and it is free. One host is what 0015 deferred; the others stay docs-only.
- **Fly cost is verified, not recomputed,** because autostop with a WebSocket service and exit-on-idle is the part arithmetic cannot show.
- **If Q6 is answered no:** A step 1 still runs; A step 2 and the ADR are skipped, DO stays "second target, unverified, unsupported" and M39 lists it open. B runs on the free tier if an account exists; with no account, `wrangler pages dev` checks the `_headers` syntax locally and the real-host check stays open. C is skipped; cost stays computed (0009) and the tick-time row for Fly stays unmeasured. `fly.toml`, Dockerfile and recipes are still written.

## Order of work
1. C: Dockerfile, `fly.toml`, local `docker run` smoke, deploy, idle/wake, load test, cost.
2. B: `_headers`, Pages deploy, `check-coi`, deployed Playwright test against C.
3. A step 1 (local), then step 2 (deploy; start the 24 h run early and read it at the end or in a follow-up session).
4. ADR, READMEs, teardown, results table in Deviations.

## Tests added
Slow tier: `do/local-smoke` (only if go), `deployed/coi-and-online` (runs only with `DEPLOYED_URL`, otherwise reported as skipped by name). Fast tier: `reference-server/docker-args` (Dockerfile and `fly.toml` agree on port and data dir with the server's CLI; a parse test, no Docker).

## Exit criteria
- [ ] `node games/reference/scripts/check-coi.mjs $PAGES_URL` exits 0; `DEPLOYED_URL=$PAGES_URL pnpm test:slow -t deployed/` passes.
- [ ] Deviations holds the results table: DO memory, timer p50/p99, projected monthly cost, restarts; Fly always-on and idle cost, wake time, tick p50/p99 under 8 clients.
- [ ] The DO ADR exists and `PLAN.md` "Plan-level decisions" lists it (or the skip is recorded with the reason).
- [ ] Both recipes are in `games/reference-server/README.md`; cloud resources are torn down.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test -t reference-server/` · `node games/reference/scripts/check-coi.mjs <url>` · `DEPLOYED_URL=<url> pnpm test:slow -t deployed/` · `node games/reference-server/scripts/loadtest.mjs --url <wss url> --clients 8 --seconds 120` · `pnpm lint`

## Budgets
PRE-PLAN §7 "Hosting cost": Fly and Cloudflare billing pages after the runs. "Tick time" on the slowest host (Fly row of 0010's tick budget): `loadtest.mjs` + the stats line.

## Context artifacts
`games/reference-server/README.md` recipes; `games/reference-server-do/CLAUDE.md` if the package stays. No skill: deploys are rare and the README is the procedure.

## Manual device checks
[device-checks.md, M38: Hosted deployment](device-checks.md#m38-hosted-deployment). Run on the iPhone on cellular against the Pages URL; not run if Q6 is declined.

## Deviations
