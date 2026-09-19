# Questions for Tyler (Phase 1 batch)

Deduplicated from the "Questions for Tyler" sections of the research files. Every item has a recommended default. Answers get recorded in the Requirements sections of `docs/spec/`; this file is then deleted.

## A. Shape the architecture (please answer each)

- **A1. Where the reference game's player position lives.** (a) *Presence*: the spring runs on each client from its own camera, positions are relayed to others as ephemeral unlogged state, and a position-dependent action carries the claimed position, which the sim range-checks. (b) A logged, predicted movement action sampled from the camera (~50x larger log, input buffering). Three research agents independently recommend (a). Cost of (a): sim rules can't depend on where players are beyond the claimed position, the engine gains a "presence" channel, and continuous movement prediction goes unexercised (discrete actions exercise prediction instead). **Default: (a).**
- **A2. Renderer placement.** TypeScript on the main thread issuing the WebGPU calls, with Rust in a worker producing all frame data into shared memory; no WASM on the main thread. This bends "Rust for everything that reasonably can be". Reasons: input and DOM exist only on the main thread (worker rendering adds latency and makes anchored DOM swim against the canvas), wgpu adds per-call garbage and binary size, WebGPU allocates the same few wrapper objects per frame in any language, and WebGPU-in-a-worker on iOS Safari is unconfirmed. **Default: accept.**
- **A3. Mandatory cross-origin isolation** (COOP + COEP `require-corp`) for every game, so SharedArrayBuffer is available. Rules out GitHub Pages (without a service-worker hack), complicates embedding in third-party iframes, forbids cross-origin assets that lack CORP/CORS headers. **Default: yes, required; no postMessage fallback.**
- **A4. Hosting.** Vercel cannot host the sim (no instance affinity, 5–30 min connection cap); it can host the static client. "Host-agnostic" becomes: the server entrypoint is a library needing one long-lived context, a timer, injected connections, and injected storage. Node/Bun process (VM, Fly, container) first, Cloudflare Durable Objects second (128 MB ceiling). Budget target ~$5/month per always-available world, ~$0 while idle. **Default: accept all of that.**
- **A5. WebSocket server on Node vs. zero npm dependencies.** Node has no built-in WebSocket server. The engine takes an injected transport adapter either way (needed for host-agnosticism). On Node: (i) the *game's* server package installs `ws` and passes it in; the engine stays dependency-free. (ii) The engine hand-rolls ~300 lines of RFC 6455. Research split on this; (ii) is protocol code to secure and maintain for no user-visible gain. **Default: (i).**
- **A6. Rust crate policy.** "Zero dependencies" is stated for npm. Allow `serde` + `postcard` in the engine crate, `ts-rs` at build time for TypeScript types, nothing else without an ADR; stable Rust only (forecloses WASM threads). **Default: yes.**
- **A7. Publishing.** Actually public (name, license, crates.io), or packaging discipline in a private repo (Rust crate bundled inside the npm package, tarball-install test)? **Default: private discipline for now.**

## B. Defaults adopted unless you object

Scope:
- **B1.** Non-goals in `overview.md` confirmed: no accounts/auth/matchmaking/lobbies, no audio, no non-WebGPU fallback, no modding or runtime code loading, one world per server process.
- **B2.** Access control: a join key in the invite link plus a device-local identity secret; no cross-device recovery.
- **B3.** The server hosts exactly one world, created or loaded at startup; mapping URLs to worlds is the deployer's problem.
- **B4.** Idle: multiplayer pauses at zero players (per-game flag to keep ticking); single-player pauses when the tab is hidden; no offline progress.
- **B5.** Sim or worldgen upgrades may invalidate saves during prototyping: version stamps, a clean "save incompatible" error, an optional `migrate` hook. Old sim binaries are not archived.
- **B6.** Engine-level save export/import is in scope (protection against Safari's storage eviction; the path from single-player to hosted).
- **B7.** Worldgen code and the seed ship to clients (no map secrecy).
- **B8.** "Infinite" means ±8.4 million tiles per axis.
- **B9.** No generator-spawned entities in v1 (worldgen emits tile data only).

Platforms and budgets:
- **B10.** Browsers: Tier 1 = current and previous major of Chrome (desktop, Android) and Safari (macOS, iOS 26+). Tier 2 = Firefox desktop. Others get a capability screen. Design inside the WebGPU compatibility-mode subset; no testing commitment for those devices.
- **B11.** Baseline phone: iPhone 12-class / 4 GB Android. ≤ 256 MB per WASM instance, 64 MiB default world budget, game `.wasm` ≤ 1 MB brotli (warn) / 2 MB (fail).
- **B12.** Zoom: 12 to 256 tiles across the long axis (about 128 subscribed chunks per client), per-game configurable. (One agent proposed 640×384 tiles; 256 keeps bandwidth and subscriptions small, and pixel art below ~6 px per tile is mush.)
- **B13.** Camera: user-driven engine camera, plus game-set constraints, programmatic `moveTo`, and an optional follow-target hook. No "WASD moves a sim player" mode in v1.
- **B14.** Server runtimes: Node ≥ 22 and Bun tested; Deno best-effort.
- **B15.** An `engine/vite` plugin entrypoint is compatible with zero dependencies (Node built-ins only; Vite is a types-only optional peer).

Testing:
- **B16.** The 1-minute budget assumes warm build caches. Separate target: ≤ 30 s incremental rebuild after a one-line Rust edit.
- **B17.** devDependencies are fine (Playwright, Vitest, TypeScript, Vite).
- **B18.** CI: GitHub Actions on Linux with a software WebGPU adapter; real-GPU and timing runs happen only on your Mac.
- **B19.** iOS Safari: a manual checklist on your phone; no device cloud.
- **B20.** "Zero GC", strictly: zero major GCs and ~zero allocation in steady state on every engine-owned isolate, except a small fixed floor (~100 B/frame) on the rendering thread for WebGPU's unavoidable wrapper objects, and the rare sub-millisecond scavenge that implies.

Reference game:
- **B21.** Resources deplete: 10 units per tile.
- **B22.** Furnace: take-all of output ingots only; any player can use any furnace; inventory and unlocks are per player.
- **B23.** One collect and one craft at a time, no queue; panning out of range cancels a collect.
- **B24.** Spawn at the land tile nearest the origin; returning players resume; players may float over water.
- **B25.** UI: framework-free TypeScript.
- **B26.** Add a tiny player roster (coloured dots) so global state is exercised: the only scope addition besides depletion.
- **B27.** 16 px tiles, 4 variants per terrain. Touch placement: tap positions the ghost, a DOM confirm button places it.
