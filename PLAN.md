# PLAN

Phase 2 output. The index of Phase 3: milestone order, dependencies and progress. One brief per milestone lives in `docs/plan/<NN>-<slug>.md`; a Phase 3 session reads `PROMPT.md`, then its one brief, then the brief's reading list. Architecture, budgets and ADR index stay in `PRE-PLAN.md`; decisions stay in `docs/decisions/`.

## How milestones work

- One milestone = one session. Tick the box here when every exit criterion in the brief is met and verified; record deviations in the brief's **Deviations** section (or a new ADR if a decision changes).
- A milestone may start only when everything in its **After** column is ticked.
- Sizing rule every brief meets: one new subsystem or one vertical cut; at most three packages or crates touched; reading list of `docs/spec/overview.md` plus at most three files; roughly 1,500 lines of new code and tests or fewer; verification that runs in minutes. A session that finds its milestone too big splits it (new brief `NNb-<slug>.md`, new row here) rather than overrunning.
- **T** marks a milestone that depends on an unanswered question to Tyler and is planned on the recommended default (`docs/plan/questions-for-tyler.md`).
- **D** marks a milestone with a Tyler-run manual device checklist attached (`docs/plan/device-checks.md`). Device checks never block the next milestone; a failed check opens a plan edit.

## Milestones

| | # | Brief | Lands | After | ADRs |
|---|---|---|---|---|---|
| [ ] | 01 | `docs/plan/01-scaffolding.md` | pnpm + cargo workspaces, toolchain pins, format/lint, `.claude/settings.json` + commit hook, `write-adr` skill, skeleton `pnpm test` / `pnpm lint` | — | 0017, 0020, 0021 |
| [ ] | 02 | `docs/plan/02-build-and-determinism.md` | engine crate ABI + `export_game!` + loader, `buildGame` + Vite plugin, first fixture game, import-allowlist test, state hash equal across native / Node / Bun | 01 | 0014, 0017, 0002 |
| [ ] | 03 | `docs/plan/03-browser-harness.md` | Playwright in `pnpm test`, COOP/COEP fixture page, injectable clock + stepping via `engine/test`, determinism hash in Chromium / WebKit / Firefox, `run-tests` skill | 02 | 0020, 0002 |
| [ ] | 04 | `docs/plan/04-zero-gc-harness.md` | zero-allocation assertion (CDP sampling + trace) with permanent negative controls, budgets file, `gc-test` skill | 03 | 0016, 0020 |
| [ ] | 05 | `docs/plan/05-codec-and-state-hash.md` | `Codec` (postcard, NaN canonicalisation), state hash, golden-bytes test pattern | 04 | 0002, 0011 |
| [ ] | 06 | `docs/plan/06-sab-primitives-and-workers.md` | SAB ring / seqlock / triple buffer, worker kinds + `createClient` spawn path, control block, `yield` flag | 04 | 0015, 0014 |
| [ ] | 07 | `docs/plan/07-world-model-core.md` | tiles, chunk coords, trait tables + `Registry`, pristine + sparse overlays + invisible dense LRU cache, cache-invisibility tests | 05 | 0007 |
| [ ] | 08 | `docs/plan/08-worldgen-and-gen-worker.md` | `Worldgen` trait, gen worker role, client pristine cache + generation queue, worldgen golden | 06, 07 | 0008, 0007 |
| [ ] | 09 | `docs/plan/09-renderer-terrain.md` | WebGPU ferry, terrain shader over page/indirection textures, chunk-upload ring, `tile_visual` + art contract, readback test | 08 | 0018 |
| [ ] | 10 | `docs/plan/10-ci-workflow.md` | GitHub Actions on `ubuntu-latest` + SwiftShader, x86-64 determinism closed, software-adapter form of the GC assertion | 09 | 0020, 0016 |
| [ ] | 11 | `docs/plan/11-camera-and-input.md` **D** | main-thread camera + seqlock block, pan/zoom/gestures, semantic input events, input ring | 09 | 0019 |
| [ ] | 12 | `docs/plan/12-store-and-game-trait.md` | `Game` trait, `Store` (entities, players, global), `WorldRead`/`WorldWrite`, put → scoped `Delta`, `Ticks` | 07 | 0003, 0007, 0006 |
| [ ] | 13 | `docs/plan/13-sim-host-tick-loop.md` | TS sim host + sim worker: injected timer, tick pacing, catch-up cap, `stepTick` | 06, 12 | 0015, 0003 |
| [ ] | 14 | `docs/plan/14-wire-framing.md` | frame header + sections encoder/decoder, uplink batch, golden bytes fixing section ids | 12 | 0011 |
| [ ] | 15 | `docs/plan/15-connection-and-subscriptions.md` | in-browser `Connection` over ring pair, camera report → subscription set, chunk enter/snapshot/leave, client replica → renderer | 11, 13, 14 | 0009, 0010, 0011 |
| [ ] | 16 | `docs/plan/16-action-round-trip.md` **D** | `dispatch` → admit → log-order apply → ack → `onActionResult`, `Ui` ring → `onUi`, ts-rs bindings, `add-action-type` skill. **Vertical slice complete.** | 15 | 0004, 0003 |
| [ ] | 17 | `docs/plan/17-drawlist-and-sprites.md` | `ClientSide::extract` → DrawList, counting sort, triple buffer, sprite atlas + instanced layers, `FrameView`, `profile-frame` skill | 16 | 0018, 0003 |
| [ ] | 18 | `docs/plan/18-picking-and-overlay.md` **D** | CPU picking from the DrawList, custom-property DOM anchoring, input events into `FrameCx` | 17 | 0019 |
| [ ] | 19 | `docs/plan/19-presence-channel.md` | `ClientSide::frame` + `Presence` sample uplink, host presence table, `admit` witness check, Presence section relay | 17 | 0001, 0003 |
| [ ] | 20 | `docs/plan/20-reference-game-v0.md` **T** | `games/reference`: worldgen, asset script, player circle + spring, collect with range, anchored button + progress; first playable | 18, 19 | 0003, 0008, 0018 |
| [ ] | 21 | `docs/plan/21-entities-and-timers.md` | prototypes + multi-tile footprints + occupancy, timer wheel + wake-ups + active lists, full `TickCx`, state-budget check | 16 | 0007, 0004 |
| [ ] | 22 | `docs/plan/22-persistence-log-and-snapshots.md` | `Storage` interface, segmented write-ahead log, snapshots, replay, heavy mode, fs + memory storage | 21 | 0005 |
| [ ] | 23 | `docs/plan/23-persistence-opfs-and-lifecycle.md` **D** | OPFS sync handles + Web Lock in the sim worker, world identity, export/import, storage events | 22 | 0005 |
| [ ] | 24 | `docs/plan/24-recovery-and-migration.md` | panic recovery by re-instantiation, `SCHEMA_VERSION` + `migrate` + `OldStore`, `SaveIncompatible` | 23 | 0005, 0006, 0014 |
| [ ] | 25 | `docs/plan/25-prediction-core.md` | `Predicting` overlay, pending queue, reset-and-replay, `Unknown` declines, taint rule, provisional ids | 21 | 0012, 0003 |
| [ ] | 26 | `docs/plan/26-prediction-rendering-and-clocks.md` | overlay change list + `predicted` flag to the renderer, ghost/real swap in one frame, two clocks + lead estimation | 25, 17 | 0012, 0018 |
| [ ] | 27 | `docs/plan/27-server-entrypoint-and-netcode-harness.md` | `engine/server` `createWorldServer` + Node adapter, in-memory `Connection` pairs, virtual-clock netcode suite, WASM-under-Node server tests | 22 | 0009, 0020 |
| [ ] | 28 | `docs/plan/28-sessions-and-reconnect.md` | `Hello`/`Welcome`/`Reject`, build-hash equality, secrets + join key, resume hint, epochs, disconnect grace | 27 | 0013 |
| [ ] | 29 | `docs/plan/29-net-worker-and-reference-server.md` **D** | net worker byte pump + reconnect timing, loopback `ws` tests, `games/reference-server`, multiplayer in the browser | 28 | 0009, 0015 |
| [ ] | 30 | `docs/plan/30-interpolation.md` | remote presence interpolation buffer, adaptive delay, host-time clock | 29, 19 | 0012, 0001 |
| [ ] | 31 | `docs/plan/31-rates-and-integrity.md` | token bucket + visible-first chunk streaming, soft cap, heartbeat, action rate limit, per-chunk desync hashes + `ResyncChunk`, byte counters vs budgets | 29 | 0010, 0013 |
| [ ] | 32 | `docs/plan/32-reference-crafting.md` | inventory, stone unlock, crafting with timer, UI | 20, 21 | 0003, 0006 |
| [ ] | 33 | `docs/plan/33-reference-furnace.md` | 2x2 furnace entity, placement ghost, deposit/take, smelting + fuel | 32, 26 | 0007, 0012 |
| [ ] | 34 | `docs/plan/34-reference-multiplayer.md` | roster + coloured dots via Global scope, remote players, scripted full-game tests single- and multiplayer | 33, 30, 31 | 0011, 0020 |
| [ ] | 35 | `docs/plan/35-packaging-and-adapters.md` | final exports map, tarball-install test, size test, Bun/Deno adapters, worker pattern B, `checkSupport` | 29 | 0017 |
| [ ] | 36 | `docs/plan/36-slow-tier-and-benchmarks.md` | `pnpm test:slow`: heavy mode N=1, release golden replay, standard large save, tick/frame benchmarks, soak | 34 | 0020 |
| [ ] | 37 | `docs/plan/37-robustness-events.md` | device loss + `rendererLost`, `onFatal`, remaining engine events on the TS surface | 34 | 0018, 0005 |
| [ ] | 38 | `docs/plan/38-hosting-checks.md` **T** | Durable Objects feasibility + adapter decision, COOP/COEP on a real static host, Fly deploy of the reference server | 35 | 0009, 0015 |
| [ ] | 39 | `docs/plan/39-acceptance.md` **D** | full coverage + budget audit, complete device checklist, Phase 3 exit, `PROMPT.md` rewritten for Phase 4 | all | — |

## Deferred-items ledger

Every row of `PRE-PLAN.md` section 10, with where it was decided or which milestone owns it: `docs/plan/deferred-ledger.md`.

## Plan-level decisions

- ADRs written or superseded during Phase 2 are listed here with one line each. (none yet)
