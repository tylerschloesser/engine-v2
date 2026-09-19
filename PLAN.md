# PLAN

Phase 2 output. The index of Phase 3: milestone order, dependencies and progress. One brief per milestone lives in `docs/plan/<NN>-<slug>.md` (format: `docs/plan/README.md`); a Phase 3 session reads `PROMPT.md`, then its one brief, then the brief's reading list. Architecture, budgets and the ADR index stay in `PRE-PLAN.md`; decisions stay in `docs/decisions/`.

## How milestones work

- One milestone = one session. Tick the box here when every exit criterion in the brief is met and verified; record deviations in the brief's **Deviations** section (or a new ADR if a decision changes).
- **The table is in execution order.** Take the first unticked row whose **After** milestones are all ticked. A `b`/`c` suffix is a split made to meet the sizing rule, not a lesser milestone; `10` runs before `09b`, `35b` before `35`, `37b` before `37`.
- Sizing rule every brief meets: one new subsystem or one vertical cut; at most three packages or crates touched; reading list of `docs/spec/overview.md` plus at most three files; roughly 1,500 lines of new code and tests or fewer; verification that runs in minutes. A session that finds its milestone too big splits it (new brief, new row here) rather than overrunning.
- **T** = planned on the recommended default of an unanswered question in `docs/plan/questions-for-tyler.md`. **D** = a Tyler-run manual device checklist is attached in `docs/plan/device-checks.md`; device checks never block the next milestone, and a failed check opens a plan edit.
- Three markers: **harness complete** after M04 (zero-allocation and cross-runtime determinism assertions running), **vertical slice complete** after M16, **first playable** after M20b.

## Milestones

| | # | Brief | Lands | After | Marks |
|---|---|---|---|---|---|
| [x] | 01 | `01-scaffolding.md` | pnpm + cargo workspaces, toolchain pins, format/lint, `.claude/settings.json` + commit hook, `write-adr` skill, skeleton `pnpm test` / `pnpm lint` | — | |
| [x] | 02 | `02-build-and-determinism.md` | engine crate ABI + `export_game!` + loader, `buildGame`, first fixture, import allowlist, state hash equal natively / Node / Bun | 01 | |
| [ ] | 02b | `02b-vite-plugin.md` | Vite plugin, `virtual:engine/wasm`, COOP/COEP fixture app | 02 | |
| [ ] | 03 | `03-browser-harness.md` | Playwright in `pnpm test`, `engine/test` skeleton (clock, stepping, quiescence), determinism hash in three browsers, `run-tests` skill | 02b | D |
| [ ] | 04 | `04-zero-gc-harness.md` | zero-allocation assertion with permanent negative controls, `budgets.json`, `gc-test` skill. **Harness complete.** | 03 | |
| [ ] | 05 | `05-codec-and-state-hash.md` | `Codec`, NaN canonicalisation, `StateHash`, golden-bytes pattern | 04 | |
| [ ] | 06 | `06-sab-primitives-and-workers.md` | SAB ring / seqlock / triple buffer, control block, camera block | 04 | |
| [ ] | 06b | `06b-workers-and-spawn.md` | worker kinds in `engine/worker`, `createClient` spawn path, `yield` protocol | 06 | |
| [ ] | 07 | `07-world-model-core.md` | tiles, chunk coords, `Registry` + trait tables, pristine + overlays + invisible dense cache | 05 | |
| [ ] | 08 | `08-worldgen-and-gen-worker.md` | `Worldgen` trait, `gen` role, `engine::noise`, worldgen golden + benchmark | 05, 07 | D |
| [ ] | 08b | `08b-gen-workers-and-queue.md` | gen workers over request ring / result slabs, generation queue, client pristine-cache feed | 06b, 08 | |
| [ ] | 09 | `09-renderer-terrain.md` | WebGPU ferry, terrain shader over page/indirection textures, chunk-upload ring, readback test | 08b | |
| [ ] | 10 | `10-ci-workflow.md` | GitHub Actions + SwiftShader, x86-64 determinism, software-adapter GC assertion | 09 | T |
| [ ] | 09b | `09b-terrain-art-and-lifecycle.md` | art contract sampling + mips, canvas lifecycle, device page | 09 | D |
| [ ] | 11 | `11-camera-and-input.md` | main-thread camera, gestures, semantic input events, input ring | 09 | D |
| [ ] | 12 | `12-store-and-game-trait.md` | `Game` trait, `Delta`, `Store` | 07, 08 | |
| [ ] | 12b | `12b-world-access-and-sim-driver.md` | `WorldRead`/`WorldWrite`, `Authority`, `Ticks`, `Sim` driver, goldens | 12 | |
| [ ] | 13 | `13-sim-host-tick-loop.md` | TS sim host, sim worker, injected timer, catch-up cap, chunk warmer | 06b, 08b, 12b | |
| [ ] | 14 | `14-wire-framing.md` | frame + sections + uplink batch, golden bytes | 12b | |
| [ ] | 15 | `15-connection-and-subscriptions.md` | subscriptions, frame building, client replica (Rust core) | 13, 14 | |
| [ ] | 15b | `15b-ring-connection-and-replica-rendering.md` | in-browser `Connection` over rings, worker plumbing, replica → renderer | 11, 15 | |
| [ ] | 16 | `16-action-round-trip.md` | `dispatch` → admit → apply → ack → `onActionResult`, `add-action-type` skill. **Vertical slice complete.** | 15b | D |
| [ ] | 16b | `16b-ui-observation-and-clock.md` | `G::Ui` → UI ring → `onUi`, `client.clock()`, ts-rs bindings | 16 | |
| [ ] | 17 | `17-drawlist-and-sprites.md` | `extract` → DrawList, `FrameView`, shapes, triple-buffer publish | 16b | |
| [ ] | 17b | `17b-sprites-and-frame-budget.md` | sprite atlas, frame-time budget, `profile-frame` skill | 17, 09b | D |
| [ ] | 18 | `18-picking-and-overlay.md` | CPU picking, DOM anchoring, `FrameCx` | 17, 09b | D |
| [ ] | 19 | `19-presence-channel.md` | presence uplink, host table, `admit` witness, relay | 17 | |
| [ ] | 20 | `20-reference-game-v0.md` | `games/reference`: worldgen, assets, headless collect rules | 16b | |
| [ ] | 20b | `20b-reference-player-and-collect-ui.md` | player spring + presence, collect UI. **First playable.** | 20, 17b, 18, 19 | |
| [ ] | 21 | `21-entities-and-timers.md` | prototypes, footprints, occupancy, state budget + `growth` | 16 | |
| [ ] | 21b | `21b-timers-wakeups-and-tickcx.md` | timer wheel, wake-ups, active lists, full `TickCx`, undo-journal decision | 21 | |
| [ ] | 22 | `22-persistence-log-and-snapshots.md` | containers, write-ahead log, snapshots, native replay + heavy mode | 21b | |
| [ ] | 22b | `22b-persistence-load-and-fs.md` | load path, crash recovery from storage, `node:fs` storage, heavy mode in `engine/test` | 22 | |
| [ ] | 23 | `23-persistence-opfs-and-lifecycle.md` | OPFS + Web Lock, storage events, export/import | 22b | T D |
| [ ] | 24 | `24-recovery-and-migration.md` | panic recovery by re-instantiation (sim role) | 23 | |
| [ ] | 24b | `24b-upgrade-and-migration.md` | `SCHEMA_VERSION`, `migrate`, `OldStore`, `SaveIncompatible`, tick rescale | 24 | T |
| [ ] | 25 | `25-prediction-core.md` | `Predicting` overlay, pending queue, taint rule, provisional ids, `entities_in` | 21b, 16b | |
| [ ] | 26 | `26-prediction-rendering-and-clocks.md` | overlay diff → renderer, ghost/real swap, lead estimation, host clock | 25, 17 | |
| [ ] | 27 | `27-server-entrypoint-and-netcode-harness.md` | `createWorldServer`, Node adapter, in-memory pairs, virtual-clock netcode suite | 22b, 24, 16b | |
| [ ] | 28 | `28-sessions-and-reconnect.md` | handshake, identity, heartbeat, link policy | 27 | |
| [ ] | 28b | `28b-reconnect-and-lifecycle.md` | resume hint, epochs, grace, idle, resend | 28, 19, 24 | |
| [ ] | 29 | `29-net-worker-and-reference-server.md` | net worker, loopback `ws`, `games/reference-server`, multiplayer in a browser | 28b | D |
| [ ] | 30 | `30-interpolation.md` | remote presence interpolation, adaptive delay | 29, 19, 26 | |
| [ ] | 31 | `31-rates-and-integrity.md` | chunk token bucket, soft cap, rate limits, byte budgets, zoom-out churn measurement | 29 | |
| [ ] | 31b | `31b-desync-hashes.md` | per-chunk desync hashes, `ResyncChunk` | 31 | |
| [ ] | 32 | `32-reference-crafting.md` | inventory, unlock, crafting | 20b, 21b | |
| [ ] | 33 | `33-reference-furnace.md` | furnace entity, predicted placement | 32, 26 | T |
| [ ] | 33b | `33b-reference-furnace-operation.md` | deposit/take, smelting, panel | 33 | T |
| [ ] | 34 | `34-reference-multiplayer.md` | roster, remote players, play through the reference server | 33b, 30, 31b | D |
| [ ] | 34b | `34b-reference-scripted-single-player.md` | scripted full game, golden log, persistence extras | 34, 23, 24b | T |
| [ ] | 34c | `34c-reference-scripted-multiplayer.md` | scripted multiplayer races + reconnect in the netcode suite | 34b | |
| [ ] | 35b | `35b-bun-and-deno-adapters.md` | Bun and Deno server adapters | 29 | |
| [ ] | 35 | `35-packaging-and-adapters.md` | final exports map, tarball + size tests, pattern B, `checkSupport`, release profile | 29, 35b | D |
| [ ] | 36 | `36-slow-tier-and-benchmarks.md` | `pnpm test:slow`, standard large save, benchmarks | 34c, 35 | |
| [ ] | 36b | `36b-suite-audit-and-measurements.md` | suite audit, deferred measurements (byte diffing, `wasm-opt`/simd, rebuild time) | 36 | |
| [ ] | 37b | `37b-device-loss.md` | WebGPU device loss, `rendererLost` | 34c | D |
| [ ] | 37 | `37-robustness-events.md` | trap reactions, `onFatal`, engine-event surface audit | 34c, 37b | |
| [ ] | 38 | `38-hosting-checks.md` | Durable Objects go/no-go, COOP/COEP on a real host, Fly deploy | 35, 31 | D |
| [ ] | 39 | `39-acceptance.md` | coverage + budget audit, full device checklist, Phase 3 exit | all above | D |
| [ ] | 39b | `39b-phase-4-handoff.md` | capture what code cannot say in ADRs, `PROMPT.md` for Phase 4 | 39 | |

## Companion files

- `docs/plan/deferred-ledger.md`: every row of `PRE-PLAN.md` §10 with where it was decided or which milestone owns it.
- `docs/plan/questions-for-tyler.md`: the batched questions, defaults, and what depends on each.
- `docs/plan/device-checks.md`: the Tyler-run manual device checklist, one section per **D** milestone.
- `docs/plan/reference-coverage.md`: engine feature → reference-game feature → milestone.
- `docs/plan/coverage.md`: spec Requirement → milestone exit criterion. `docs/plan/coverage-adrs.md`: ADR decision, budget, engine event and context artifact → milestone exit criterion. A milestone that changes an exit criterion updates its rows; M39 re-audits both.

## Plan-level decisions

ADRs written during Phase 2:

- `docs/decisions/0022-entity-ids-and-provisional-ids.md`: `EntityId` is host-allocated, monotonic, never reused; predicted entities get client-local provisional ids and are addressed by tile. Supersedes the "type-segregated stores" wording of 0007 §5 and makes the interim rule of 0012 permanent.
- `docs/decisions/0023-action-growth-declaration.md`: `Game::growth(&Action)` so shrinking actions pass the state-budget check. Amends 0004, 0003, 0007 §8.
- `docs/decisions/0024-planning-amendments.md`: the ADR gaps and contradictions found while cutting milestones, each with the amendment and the milestone that implements it.
