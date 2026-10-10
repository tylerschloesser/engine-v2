# Architecture decision records

An ADR here records one decision and the reasoning that cannot be read from the code. Accepted ADRs are never edited: supersede, don't rewrite. A changed decision is a new ADR that supersedes or amends the old one, and the old one keeps its text. To add one, use the `write-adr` skill (`.claude/skills/write-adr/`).

ADR Sources sections link into `docs/research/`, `spikes/`, `docs/spec/` and `docs/plan/`, which Phase 4 deletes or folds; those links stay as historical references, resolvable through git history (`git log -- <path>`, or the `phase-3-complete` tag).

| ADR | Title | Decision | Superseded / amended by |
|---|---|---|---|
| [0001](0001-camera-and-presence.md) | The camera is not an action; presence and witness-carrying actions | The camera is a latest-wins subscription message, not a logged action; presence is an ephemeral, unlogged engine channel. | 0024 |
| [0002](0002-determinism-same-wasm-everywhere.md) | Determinism by running the same `.wasm` everywhere | The browser's game `.wasm` is the file the server runs, with fixed rules for sim, worldgen and apply code. | 0068 |
| [0003](0003-game-facing-api.md) | The game-facing API | Games implement the `Game` trait and its client side, reading through fallible accessors that return `Unknown` for state a replica lacks. | 0023, 0024, 0035, 0046 |
| [0004](0004-action-timing-and-rejection.md) | Action timing, ordering, validation and rejection | The host assigns each action to the next tick in arrival order; invalid actions are rejected before any write. | 0023, 0024, 0064 |
| [0005](0005-persistence-and-recovery.md) | Persistence, upgrades and crash recovery | Worlds persist as snapshot plus action log, replayed to recover from crashes and to carry across upgrades. | 0024, 0038, 0050, 0065 |
| [0006](0006-time-units.md) | Time units: seconds are authored, ticks are stored | Authors write seconds; the engine converts to integer ticks and stores only ticks. | |
| [0007](0007-world-model.md) | World model: pristine function, sparse overlays, global entities | The world is a pure pristine function plus sparse per-chunk overlays and a global entity store. | 0022, 0023, 0024, 0046, 0059, 0063 |
| [0008](0008-chunk-generation.md) | Chunk generation: one pure function, run wherever it is needed | Terrain comes from one pure function of seed and coordinates, run identically on host and clients. | 0024 |
| [0009](0009-transport-and-hosting.md) | Transport and hosting | Dedicated server hosts over WebSocket, with a ranked list of hosting targets. | 0024, 0051, 0067 |
| [0010](0010-rates-and-subscriptions.md) | Rates, subscriptions, and the bandwidth budget | Fixed update rates, chunk subscriptions with a cap, and a per-client bandwidth budget with degrade rules. | 0024, 0040, 0056, 0059, 0064 |
| [0011](0011-wire-format-and-deltas.md) | Wire format and deltas | A hand-rolled binary frame format sends per-tick deltas keyed by versions. | 0024, 0041, 0064 |
| [0012](0012-prediction-and-reconciliation.md) | Prediction and reconciliation | Clients predict their own actions on a local replica and reconcile against the host's authoritative results. | 0022, 0024, 0064 |
| [0013](0013-sessions-and-integrity.md) | Sessions and integrity | Players hold secret-keyed sessions with a grace period, and periodic state hashes detect divergence. | 0024, 0042, 0053, 0064 |
| [0014](0014-js-wasm-boundary.md) | The JS↔WASM boundary: a fixed, hand-rolled `extern "C"` ABI | The boundary is a small fixed `extern "C"` ABI over shared memory, with no generated glue. | 0024, 0055 |
| [0015](0015-threads-memory-and-topology.md) | Threads, memory, and topology | Sim, generation and render run in separate workers over shared memory with a fixed topology. | 0024, 0042, 0045, 0067, 0072 |
| [0016](0016-zero-gc-definition.md) | What "zero GC" means, and how it is asserted | Zero GC means no measured allocation in a warmed-up steady-state window, asserted per page against a budgets file. | 0024, 0026, 0027, 0029, 0039, 0043, 0052 |
| [0017](0017-packaging-and-build.md) | Packaging and build | One pnpm and Cargo workspace builds the engine package, with a defined exports map and pinned toolchain versions. | 0024, 0034, 0044, 0045, 0050, 0067 |
| [0018](0018-renderer.md) | Renderer: TypeScript WebGPU ferry on the main thread, Rust produces every byte | Rust produces every renderer byte; a thin TypeScript WebGPU layer on the main thread only uploads and draws. | 0024, 0066 |
| [0019](0019-camera-input-and-overlay.md) | Camera, input, picking, and overlay anchoring | Camera, input and picking are engine-owned; game overlays anchor to world positions. | 0024, 0061, 0066 |
| [0020](0020-testing-strategy.md) | Testing strategy | Tiered test suites with time budgets, goldens, benchmarks and a manual device checklist. | 0024, 0031, 0033, 0047, 0049, 0054, 0068 |
| [0021](0021-context-architecture.md) | Context architecture for Claude Code sessions | Context is split across nested CLAUDE.md, path-scoped rules, skills and sub-agent briefs. | 0025 |
| [0022](0022-entity-ids-and-provisional-ids.md) | Entity ids: monotonic, never reused, layout-free; predicted entities are addressed by tile | Entity ids are monotonic and never reused; predicted entities are addressed by tile until the host assigns an id. | 0064 |
| [0023](0023-action-growth-declaration.md) | Per-action growth declaration for the state-budget check | Each action declares its maximum state growth, and the state-budget check uses that declaration. | |
| [0024](0024-planning-amendments.md) | Planning amendments to ADRs 0001–0020 | A numbered list of points where planning corrected or refined ADRs 0001 to 0020. | 0064, 0065 |
| [0025](0025-phase-3-orchestration.md) | Phase 3 runs as one orchestrating session with Sonnet implementers, on `main` | One orchestrating session lands milestones serially on main, each built by a Sonnet sub-agent. | 0069, 0070 |
| [0026](0026-zero-gc-burst-controls-in-slow-tier.md) | `burst` negative controls move to the slow tier for every page but `gc-loop` | Burst negative controls run in the slow tier on every page except `gc-loop`. | 0043, 0068 |
| [0027](0027-zero-gc-excludes-blocking-primitive-bookkeeping.md) | The zero-GC byte total excludes V8's own blocking-primitive bookkeeping | The zero-GC byte total excludes V8's own bookkeeping for blocking primitives. | 0028 |
| [0028](0028-zero-gc-two-measured-windows.md) | The zero-GC byte total is the lower of two measured windows | The zero-GC byte total is the lower of two measured windows. | 0058 |
| [0029](0029-zero-gc-software-mode-attribution.md) | Zero-GC software mode: attribution stays on `main` only, and for a different reason than 0016 gave it | In software mode, allocation attribution stays on the main thread only, for a reason other than 0016's. | 0058 |
| [0030](0030-sim-host-resync-based-pacing.md) | `SimHost` pacing reads the wall clock only once every `RESYNC_TICKS` ticks | SimHost reads the wall clock once per `RESYNC_TICKS` ticks and otherwise paces by tick count. | 0032, 0063 |
| [0031](0031-browser-suite-five-workers.md) | The `browser` suite runs 5 Playwright workers, not 3 | The browser suite runs with five Playwright workers. | |
| [0032](0032-atomics-timer-bounds-external-wakes.md) | `AtomicsTimer` paces between proven and estimated bounds when external wakes interrupt it | AtomicsTimer paces between a proven and an estimated bound when external wakes can interrupt it. | |
| [0033](0033-fast-tier-budget-after-build-fix.md) | Fast tier budgets, re-divided after the build fix: 10 s build, 35 s browser | The fast tier is re-divided as a 10 s build and a 35 s browser budget. | 0036 |
| [0034](0034-provisional-render-exports-subpath.md) | Provisional `./render` exports subpath | The renderer is exported as a provisional `./render` subpath. | 0045 |
| [0035](0035-clientside-on-init.md) | `ClientSide::on_init` gives a client its own world's seed and params once | `ClientSide::on_init` hands the client its world's seed and params exactly once. | 0042 |
| [0036](0036-browser-fast-tier-budget-48s.md) | `browser` fast-tier budget, 35,000 → 48,000 ms | The browser fast-tier budget rises from 35 s to 48 s. | 0060 |
| [0037](0037-undo-journal-adopted.md) | Host-side `apply` atomicity: the undo journal is adopted | The host adopts an undo journal so a failed `apply` rolls back atomically. | |
| [0038](0038-persistence-container-additions.md) | Persistence container additions from M22 (Formats) | The persistence container formats gain the additions M22 needed. | |
| [0039](0039-snapshot-write-is-a-budgeted-event.md) | The periodic snapshot write is a budgeted event, not inside the strict zero-GC window | The periodic snapshot write has its own byte budget instead of counting inside the strict zero-GC window. | 0065 |
| [0040](0040-interpolation-delay-presence-interval.md) | The interpolation delay is sized from the presence sample interval | Interpolation delay is derived from the presence sample interval. | 0064 |
| [0041](0041-frame-bundle.md) | FrameBundle, several whole frames in one message | A FrameBundle message carries several whole frames at once. | |
| [0042](0042-remote-client-world-config-from-welcome.md) | A remote client takes its world's seed and params from `Welcome` | A remote client takes its world's seed and params from the `Welcome` message. | |
| [0043](0043-zero-gc-worker-object-controls-slow-on-reference-page.md) | On `reference_single_player`, the worker `object` negative controls move to the slow tier | On the reference page, worker `object` negative controls move to the slow tier. | |
| [0044](0044-bun-1-4-2.md) | Bun is pinned at 1.4.2, and is a server host as well as a test leg | Bun is pinned at 1.4.2 and serves as a server host as well as a test leg. | |
| [0045](0045-build-profiles-measured.md) | Build profiles, measured | Build profiles are fixed from Phase 3 measurements, with the engine JS budget revised and a browser-version policy. | 0048 |
| [0046](0046-genesis-writes-unlogged-and-timers.md) | Genesis writes are not logged, and genesis may arm timers | Genesis writes are not logged, and genesis may arm entity timers. | |
| [0047](0047-bench-gate-absolute-floor.md) | An absolute floor under the 25 % benchmark rule | The 25 % benchmark regression rule gains an absolute millisecond floor. | |
| [0048](0048-fast-tier-budgets-dev-loop-and-wire-measurements.md) | Fast-tier budgets, dev loop and wire measurements | Fast-tier budgets and the dev loop are set from measurements, with `split-debuginfo = "packed"`. | |
| [0049](0049-compile-budget-45s.md) | The incremental-rebuild budget is 45 s | The incremental-rebuild budget is 45 seconds. | 0068 |
| [0050](0050-engine-failure-surface.md) | Engine failure surface | Engine failures surface as typed events, and a Rust edit snapshots, reloads and restores the world. | |
| [0051](0051-durable-objects-no-go.md) | Durable Objects: no-go | Durable Objects are not a hosting target. | |
| [0052](0052-zero-gc-warmup-4000-frames.md) | Zero-GC warm-up is 4000 frames in 8 passes | Zero-GC warm-up runs 4000 frames in 8 passes. | |
| [0053](0053-connection-slots-and-full-admission.md) | Sixteen connection slots; `Full` counts attached players | The host has sixteen connection slots, and `Full` counts only attached players. | |
| [0054](0054-tools-suite.md) | A `tools` suite for the device-walk tool's tests | The device-walk tool's tests get their own `tools` suite. | 0070 |
| [0055](0055-bench-only-phase-import.md) | A bench-only wasm import for per-phase tick timing | A bench-only third wasm import reports per-phase tick timing. | |
| [0056](0056-ios-pacing-and-tick-bar.md) | What M09b asserts on iOS, and which phone is the large-save tick bar | M09b's iOS assertions are set, and the iPhone 12 at p95 is the large-save tick bar. | 0057 |
| [0057](0057-ios-m09b-portrait-only.md) | M09b-fill-rate measures portrait only on iOS | On iOS, M09b-fill-rate measures portrait only. | |
| [0058](0058-zero-gc-attributed-minimum-per-window.md) | Software-mode attributed bytes take their own two-window minimum | Software-mode attributed bytes take their own minimum across two windows. | |
| [0059](0059-subscription-cap-144.md) | Subscription cap 128 → 144 chunks | The subscription cap rises from 128 to 144 chunks. | |
| [0060](0060-browser-fast-tier-budget-60s.md) | `browser` fast-tier budget, 48,000 → 60,000 ms | The browser fast-tier budget rises from 48 s to 60 s. | |
| [0061](0061-wheel-zoom-bounded-accumulator.md) | wheel zoom is bounded, and the wheel works over the game's overlay | Wheel zoom uses a bounded accumulator, and the wheel also works over the game's overlay. | 0066 |
| [0062](0062-budgets-as-measured-at-phase-3-exit.md) | Budgets as measured at Phase 3 exit | The permanent record of the performance budgets and what Phase 3 measured against them. | |
| [0063](0063-phase-3-decisions-world-and-simulation.md) | Phase 3 decisions: world and simulation | Records world and simulation decisions made in Phase 3 that no earlier ADR held. | |
| [0064](0064-phase-3-decisions-sync-and-netcode.md) | Phase 3 decisions: sync, prediction and netcode | Records sync, prediction and netcode decisions made in Phase 3 that no earlier ADR held. | |
| [0065](0065-phase-3-decisions-persistence.md) | Phase 3 decisions: persistence and recovery | Records persistence and recovery decisions made in Phase 3 that no earlier ADR held. | |
| [0066](0066-phase-3-decisions-client-renderer-input.md) | Phase 3 decisions: client, renderer and input | Records client, renderer and input decisions made in Phase 3 that no earlier ADR held. | |
| [0067](0067-phase-3-decisions-runtime-packaging-hosting.md) | Phase 3 decisions: runtime, packaging and hosting | Records runtime, packaging and hosting decisions made in Phase 3 that no earlier ADR held. | 0072 |
| [0068](0068-phase-3-decisions-testing-and-tooling.md) | Phase 3 decisions: testing, CI and tooling | Records testing, CI and tooling decisions made in Phase 3 that no earlier ADR held. | 0071 |
| [0069](0069-working-rules-learned-in-phase-3.md) | Working rules learned in Phase 3 | Records the working rules Phase 3 learned for orchestrating sessions and sub-agents. | |
| [0070](0070-phase-3-tooling-retired.md) | Phase 3 orchestration tooling is retired | The `milestone-implementer` agent, `pnpm gate`, `pnpm handoff`, `pnpm acceptance:check` and the `device:walk` phone-round tool are deleted; device checks are walked by hand from the `device-check` skill. | |
| [0071](0071-gc-burst-controls-one-ci-worker.md) | Gc burst controls on CI run on one worker | CI runs the `gc` and `gc-reference` projects with one worker each; `gcTimeoutMs` stays 90 s. | |
| [0072](0072-static-host-verified-build-time-server-url.md) | Static host verified on Cloudflare Pages; the server URL is set at build time | The release page's server is `VITE_SERVER_URL` at build time; `_headers` and `404.html` ship in every build; Pages passes `check-coi.mjs` and reaches `online` cross-origin. | |
