# 0067: Phase 3 decisions: runtime, packaging and hosting

Status: Accepted (2026-10-10). Settles items [0014](0014-js-wasm-boundary.md) and [0015](0015-threads-memory-and-topology.md) deferred to Phase 2 and amends [0015](0015-threads-memory-and-topology.md) §3, [0017](0017-packaging-and-build.md) §3 and [0009](0009-transport-and-hosting.md). Recorded at the Phase 3 handoff (M39b) from what milestones M02 to M39 decided.

## Context

Phase 3 built the loader, workers, packaging and the Fly deployment. Several items the earlier ADRs marked "deferred" were settled in code, one claim in 0015 was never verified, and a few hosting facts exist only in a README. The brief files that held the reasoning are deleted at Phase 4, so the *why* is written here.

## Decision

### Unverified: header listings on a static host (read first)

**1. The COOP/COEP listings of 0015 §3 were never verified on a real static host, nor its sentence about a cross-origin `wss`.** Status: unverified; the per-host listings in `games/reference/README.md` come from documentation (Netlify and Cloudflare Pages `_headers`, Vercel `vercel.json`, GitHub Pages cannot set headers). Tyler did not approve a Cloudflare Pages deploy (Q6), so M38 served the client from the Fly machine with the headers set by `games/reference-server --static`. That proves only that handler (`check-coi.mjs` passes against it and the page reaches `online`), and being a single origin it never exercised a cross-origin `wss`. This closes none of 0015's "verify on one real static host" deferral; it is still open. To close it: deploy `games/reference`'s `vite build` output to one static host with its listing, run `node games/reference/scripts/check-coi.mjs <url>`, and run `DEPLOYED_URL=<url> pnpm test:slow -t deployed/` against a game server on another origin. Until then nothing may cite a third-party host as verified.

**2. A static host must send COOP and COEP on 304 responses too**, not only on 200, 403 and 404. `vite preview` answered a revalidation with a bare 304 without either header, and WebKit then refused the page's module worker on the second load ("Worker load was blocked by Cross-Origin-Embedder-Policy"; reproducible with `page.reload()`, no agent involved). iOS Safari very likely does the same against a real host. The engine's preview configuration now applies `preview.headers` plus `Cache-Control: no-store` to every preview response. This extends the "headers must match every path" rule of 0015 §3 to every status code; the per-host listings must be checked for it when item 1 is closed.

### Hosting

**3. Fly serves the client itself, by design.** The reference server's `--static <dir>` serves the built client, so page and `/ws` share one origin. It is a reference-server convenience, not an engine feature: `engine/server/node` stays free of HTTP (0009). The reason is Q6: Workers and Fly were approved, a Pages deploy was not, and the phone check needs a cross-origin-isolated page.

**4. The Fly app was destroyed on 2026-10-10 after Tyler's device checks.** The billed figure, read by Tyler, was $0.04 month-to-date for an idle app. 0009's $3.32 always-on figure does not reproduce from Fly's price page; the computed range is $3.69 base or $4.62 with the `ord` markup, plus the volume. Treat 0009's number as unverified. Deploy and teardown steps stay in `games/reference-server/README.md`.

**5. A page load, or a dial that never completes a handshake, wakes the machine but never reaches `onIdle`** (it fires only after a *player* leaves), so the machine runs until Fly's own autostop (observed 6 min 31 s). Cold wake takes 3.4-4.1 s, longer than `DEAD_MS` (3000), so the client redials once. Both were accepted rather than adding an idle timer for page-only wakes: the cost is minutes of a shared-cpu-1x machine, and a timer would be a second idle policy next to `onIdle`.

**6. Reference-game URL and world behaviour on a deployed server.** An invite link needs the fragment `#k=<joinKey>` (empty for an open server); a bare URL opens a local single-player world, and Tyler kept that behaviour. A build whose save schema changed cannot open the world on the volume (the machine exits 1 with `WorldLoadError: incompatible (MigrateDeclined)` and Fly stops restarting it): the old world must be moved aside first, with the one-off command in `games/reference-server/README.md`.

**7. Bun and Deno adapters.** All three runtimes share one `node:fs` `Storage` (re-exported from `server-node.ts`), so durability semantics cannot drift per runtime. Adapters return handlers (`bunHandlers`, `denoHandler`) instead of calling `Bun.serve` or `Deno.serve`, leaving port, TLS, health checks and static files to the deployer. `Bun.serve` and `Deno.upgradeWebSocket` are typed structurally, so a consumer needs neither `@types/bun` nor Deno's lib. Bun has a fast-tier loopback scenario inside the existing `bun` process, because Bun support is a Requirement and 0020 §4 forbids demoting the only test of a feature. Deno stays best-effort, as 0009 said: `deno-adapter` is `@slow`, a missing Deno warns `deno-missing`, and CI sets `REQUIRE_DENO=1` so the CI job cannot silently skip it. `server-load-game.ts` was not split out, since that would widen the allowlist in `no-node-import.test.ts`.

### Packaging

**8. Safari module delivery (amends 0017 §3 and 0014).** `createClient` posts the compiled `Module` to the worker and falls back to the `wasmUrl` setup when posting throws `DataCloneError` or the worker reports a `messageerror` (surfaced as `fatal` with prefix `module-refused`, so the protocol gained no message type). 0017 called this fallback an option "if real Safari refuses a posted Module"; it was built unconditionally because the M11 on-device boot check had never run, leaving a posted `Module` unverified in real Safari.

**9. The crate stays a single `engine` crate.** Nothing measured says the edit loop is slow. Split only on one of three triggers, each needing an ADR: (a) the runner's build line warns (edit to tests-starting over the compile budget of 0020 §3, as amended by 0049) in two consecutive milestones and `cargo build --timings` shows `engine` is the critical path; (b) non-sim code needs blanket `#[allow(clippy::disallowed_*)]` in more than three modules (the lint scope of 0002 wants a crate boundary); (c) a proc-macro becomes unavoidable (it needs its own crate). Constraints on any split: the game-facing crate is still called `engine` and re-exports the others, and every crate stays under `packages/engine/crates/` so the package `files` ships it. `packages/engine/crates/engine/CLAUDE.md` points here.

### Loader, memory and workers

**10. `engine.log` and `engine.panic` text is decoded in the instance's own isolate** by the loader (one module-level `TextDecoder`) and handed to `LoaderHooks.onLog`; it is not forwarded to main. Settles the 0014 deferral. Worker consoles already reach DevTools and Playwright, a server has one isolate, and a log call inside a measured window is meant to fail 0016 on the isolate that made it.

**11. The WASM arena owns no allocator of its own.** `abi::Arena` wraps `std::alloc::System`; `engine_init` reserves by allocating and freeing one block of `arenaBytes`, so std's allocator does the single `memory.grow`. M07 then found the world pools need no sub-allocator on top: the slab pool and index table are allocated once in `TerrainStore::new` and never resized, and a probe showed a 900 KiB allocation after init reuses the freed reservation (`memGrows() === 0`). Rejected: an own allocator, as more code for no observable gain.

**12. Ring full-ring policies (settles 0015's "ring capacities per link"; the numbers are `RING_DEFAULTS` in `sab/layout.ts`).** `downlink`, `uplink`, `uiRing`, `uploadRing`, `genRequest` and `genResult` apply backpressure. `actionRing` makes `dispatch` throw `RingFull`: it carries human-rate input, sized at the 0004 burst x 1.5. `inputRing` is drop-and-count, because an input event seconds old is worthless; `drops` was 0 in every test.

**13. The client worker has no clock of its own (resolves what 0018 deferred to 0015).** `frame(t_ms)` takes its time from the camera block and runs only when `CB_FRAME_REQ` differs from `W_ACK`. Frames never queue: a late worker serves the newest request once, and a ring-producer wake without a new frame request only drains rings. This keeps the client instance free of ambient time and makes `stepFrame` exact. The export's raw `t_ms` argument is unused: Rust reads `camera.frame_time_ms`, because a `Float64Array` element read in JS boxes about 12 B per frame. The export keeps its declared shape, so `ABI_VERSION` did not bump.

**14. The iOS "arena actually committed" claim of 0015 is weaker than worded.** `?probe=memory` on `device.html` cannot touch every page of every arena (no ABI export reaches a worker's whole arena from outside), so its `&touch=1` option re-runs the same 2-minute session. A device pass shows the reservation instantiates and the session runs, not that every reserved page was backed by physical memory.

## Alternatives rejected

- A third-party static host for the phone check: not approved (Q6); Fly's single origin gave the isolated page instead, at the cost of item 1.
- An idle timer for page-only Fly wakes (item 5): see item 5.
- An own WASM allocator (item 11).
- Forwarding `engine.log` text to main (item 10): would route a measured-window log call through a different isolate than the one 0016 watches.

## Consequences

- Open: item 1, until a real static host is exercised. Tyler decides whether to approve a deploy; the command sequence above is the whole procedure.
- Open: a live-byte ABI export would sharpen the memory probe of item 14; it needs its own ADR.

## Sources

- `games/reference/README.md` (headers section), `games/reference-server/README.md` (Fly), `games/reference/scripts/check-coi.mjs`, checked 2026-10-10.
- Vite preview configuration in `games/reference/vite.config.ts` and `packages/engine/src/vite.ts`, checked 2026-10-10.
