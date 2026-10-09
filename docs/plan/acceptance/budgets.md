# Budget ledger (M39)

One row per PRE-PLAN §7 row, and per number inside a row that holds several. Per-suite numbers (rust, unit, wasm, netcode, browser) are in [ADR 0048](../../decisions/0048-fast-tier-budgets-dev-loop-and-wire-measurements.md) §1 and not copied here. All desktop numbers are Tyler's Mac (Apple M3 Max, arm64). Verdicts: `met`, `missed`, `manual` (only a phone or Tyler can measure it; cites a device check, not yet ticked unless the device-checks file says so), `computed` (arithmetic, no direct measurement). A `missed` row ends its Target-to-Verdict cells with the decision note.

Sources used: `PRE-PLAN.md` §7, `packages/engine/budgets.json`, `packages/engine/baselines/*.json`, ADRs 0045-0049 and 0051, M36 / M36b / M37 / M37b / M38 Deviations (as quoted in `docs/plan/39-acceptance.md` Seams and `docs/plan/38-hosting-checks.md`).

| Budget (PRE-PLAN §7 row / number) | Owner ADR | Target | Measured | Where measured | Date | Verdict |
|---|---|---|---|---|---|---|
| Frame time: main rAF callback, phone | [0018] §9 | <= 4 ms | not yet read | device: M39-frame-shares (`main p95` of the bench HUD) | n/a | manual |
| Frame time: client-worker `frame`, phone | [0018] §9 | <= 8 ms | not yet read | device: M39-frame-shares (`frame p95`) | n/a | manual |
| Frame time: GPU, phone | [0018] §9 | <= 6 ms | not yet read | device: M09b-fill-rate (the GPU share is that check's, not the HUD's) | n/a | manual |
| Frame time: desktop proxy, main | [0018] §9 | <= 1.3 ms | p50 0.082 ms (p95 0.109) at maximum zoom-out, large save | baselines `frame-reference.json` (`bench.frame_reference`); older worst case 0.637 ms in `frame.json` (`bench.frame_worstcase`) | 2026-10-01 | met |
| Frame time: desktop proxy, worker | [0018] §9 | <= 2.7 ms | p50 0.120 ms (p95 0.214); worst case 2.152 ms (p95 2.344) | baselines `frame-reference.json`, `frame.json` (gated `mainP50Ms`, `workerP50Ms`, limits 1.3 / 2.7; ADR [0047] floor) | 2026-10-01 (worst case 2026-09-23) | met |
| Tick time: desktop proxy on the standard large save | [0010] | <= 3 ms (state budget full, 8 players) | median 2.87 ms (p99 3.53, max 4.24; about 4 % headroom) | baselines `tick.json` (native release, `slow_tick_large_save`) | 2026-10-01 | met |
| Tick time: Node twin of the same save | [0010], [0024] §14 | warn-only, no limit | median 10.63 ms (p99 12.70) | baselines `tick-node.json` (no limit by design) | 2026-10-01 | computed |
| Tick time: phone sim worker | [0010] | <= 10 ms per 50 ms tick | 9.34 ms p95 (iPhone 12, iOS 18.7, driverless, 2026-10-09, `m39ag-iphone-large-save`; sim_tick p50 6.34) | device: M39-large-save (HUD `tick p95`, read after 10 s) | n/a | manual |
| Tick time: Fly shared-cpu-1x | [0010] | <= 10 ms per 50 ms tick | tick p50 0.06-0.43 ms (median 0.13), window p99 0.79-5.02 ms, max single tick 7.90 ms, `overruns=0`, 20 Hz; 8 clients on the small reference world, not the large save | M38 Deviations, "Results (Fly ...)" load row (`loadtest.mjs` and the server `stats:` line) | 2026-10-02 | met |
| Chunk generation: desktop warn | [0008] | warn above 0.25 ms per chunk | 0.0685 ms per chunk (re-runs 0.062-0.067) | baselines `worldgen.json`; `budgets.json` key `worldgenMsPerChunkWarn` (0.25) | 2026-10-01 | met |
| Chunk generation: baseline phone | [0008] | <= 1 ms per chunk | not yet read | device: M08-worldgen-ms-per-chunk (and M08-warn-threshold for the phone/desktop factor) | n/a | manual |
| Chunk generation: join at full zoom-out, desktop | [0008] | about 8 ms for 81 visible chunks | about 5.5 ms (81 x 0.0685 ms); no direct timing | derived from `worldgen.json`; wire side in `budgets.json` `gen.genJoinChunks` (169) and `net.joinWildernessMaxZoomBytes` | 2026-10-01 | computed |
| Chunk generation: join at full zoom-out, phone | [0008] | 25-40 ms (estimate) | not yet read | device: M08-worldgen-ms-per-chunk (x 81) | n/a | manual |
| Chunk generation: host warmer 2 ms per tick gap | [0008] | 2 ms per tick gap | NOT SOURCED in the files read (no baseline or budgets key for the warmer's yield) | owner brief: M13 (warmer yield per gap); not cited here | n/a | manual |
| GPU upload per frame | [0018] | <= 64 KiB of chunk texels | max 65,536 B per frame (equal to the budget) in the `frame-reference` run | `budgets.json` `counters.render.uploadBytesPerFrame` (65,536) and `uploadBacklogRecords` (16); browser tests `terrain: upload budget while panning`, `device loss: uploads stay under the frame budget` | 2026-10-01 | met |
| GPU draws | [0018] | 2-10 draws | max 3 per frame in the `frame-reference` run | `budgets.json` `counters.render.drawCallsTerrain` (1), `drawCallsMax` (9), `pipelineSwitches` (1); `frame-reference.json` conditions | 2026-10-01 | met |
| Bandwidth steady: down | [0010] | 1-5 KB/s typical | busy field 7,046 B in 5 s (1.4 KB/s); observer with 200 lit furnaces 839 B/s, 3.1 KB/s at 1,000 (below the typical range at both) | `budgets.json` `net.steadyBusyFieldBytes5s`; browser/netcode test `rates/steady-busy-field`; ADR [0048] §6 | 2026-10-01 | met |
| Bandwidth steady: remote presences | [0010] | within the steady range | 7 remote presences 1,220 B/s down budgeted, 9,109 B in 10 s measured (911 B/s) | `budgets.json` `net.sevenRemotePresencesBytes10s`, `presence.downBytesPerSec7Remotes`; test `rates/seven-remote-presences` | 2026-10-01 | met |
| Bandwidth steady: up while panning | [0010] | about 0.4 KB/s; about 0 at rest | 1,620 B in 5 s (324 B/s) panning; presence uplink 330 B/s; idle heartbeats 200 B in 10 s | `budgets.json` `net.uplinkPanningBytes5s`, `presence.uplinkBytesPerSec`, `net.idleHeartbeatBytes10s`; tests `rates/uplink-panning`, `rates/idle-sends-only-heartbeats` | 2026-10-01 | met |
| Bandwidth steady: soft cap for tick frames | [0010] | soft cap 16 KB/s | degrade path asserted at the cap; no steady run reaches it (see steady rows) | tests `rates/degrade-on-soft-cap`, `rates/degrade-on-stall`; `budgets.json` `net.degradeMaxLevel` (4) | 2026-10-01 | met |
| Bandwidth burst: refill and burst | [0010] | 48 KB/s refill, 128 KB burst | refill 2,400 B per tick (48 KB/s), burst 128,000 B, exact | `budgets.json` `net.bucketRefillBytesPerTick`, `net.bucketBurst`; test `rates/bucket-refill-exact` | 2026-10-01 | met |
| Bandwidth burst: hard ceiling | [0010] | <= 64 KB/s | worst second 51,645 B (join); 49,012 B (pan) | `budgets.json` `net.hardCeilingBytesPerS`, `net.hardCeilingBytesPerSPan` (ceiling 64,000) | 2026-10-01 | met |
| Bandwidth burst: per hour of play | [0010], [0013] | 10-20 MB per hour | 324,399 B per simulated hour on the test scenario (ceiling 20,000,000) | `budgets.json` `net.bytesPerHour`; test `integrity/hash-bytes-per-second` for the hash share | 2026-10-01 | met |
| Bandwidth burst: reconnect | [0010], [0013] | about 1 KB each way | 280 B up, 130 B down (wilderness) | `budgets.json` `reconnect.wildernessBytesUp`, `reconnect.wildernessBytesDown`; test `reconnect/cost` | 2026-10-01 | met |
| Action rate: sustained and burst | [0004] | 20 per s sustained, burst 40 | limiter holds at both; 21 rate-limited at default, 29 at burst-10 (ceiling 24 / 32) | test `rates/action-rate-limited`; `budgets.json` `net.actionRateLimitedDefault`, `net.actionRateLimitedBurst10`, `net.cameraReportsAcceptedPerS` (20) | 2026-10-01 | met |
| Action log: bytes per logged action | [0004] | about 12-18 B | 12 B per action (uplink 12 B) | `budgets.json` `action.logBytesPerAction`, `action.uplinkBytesPerAction` | 2026-10-01 | met |
| Action log: per active player-hour | [0004] | 65 KB | enforced ceiling 65,000 B; no separate measured hour found | `budgets.json` `action.logBytesPerPlayerHour.ceiling` | 2026-10-01 | computed |
| Memory per instance: sim arena | [0015] §5 | 96 MiB | high water 88 MiB (92,274,688 B) on the large save; `memoryBytes` 101,974,016; `memGrows` 0 | `budgets.json` `mem.simHighWaterLargeSave` (record-only); soaks `soak-netcode @slow`, `gc-reference-soak.spec.ts` | 2026-10-01 | met |
| Memory per instance: client arena 48 MiB, gen arena 4 MiB | [0015] §5 | 48 MiB / 4 MiB | `engine_mem_grows` 0 on every zero-GC page and soak; no per-arena high-water (no ABI export; ledger item of M36) | `budgets.json` `gc.pages.*` (memGrows asserted 0); test `frame-bench-reference.spec.ts` HUD `engine_mem_grows` check; ADR 0014 lists the exports | 2026-10-01 | met |
| Memory per instance: ceiling 256 MiB on mobile | [0015] §5 | 256 MiB | not yet read | device: M11-memory (scratch memory grown to 1 GiB, pan for 2 min) | n/a | manual |
| Memory per instance: world budget 64 MiB (262,144 entities, 1,048,576 modified tiles) | [0007] | state budget full | full budget runs: tick, genesis, join, persistence | test `reference_state_budget_full`; baselines `tick.json` conditions | 2026-10-01 | met |
| Memory per instance: dense cache 1,024 chunks = 4 MiB | [0007] | 4 MiB | NOT SOURCED in the files read (only `snapshot_excludes_dense_cache` found, which does not measure the size) | none cited | n/a | manual |
| Memory, whole tab: single-player on the phone | [0015] §5 | <= 256 MiB | not yet read | device: M11-memory; M16-coexist; M39-large-save (10 min, no reload, `engine_mem_grows` 0) | n/a | manual |
| Memory, whole tab: multiplayer on the phone | [0015] §5 | about 160 MiB | not yet read | device: M34 section (reference multiplayer on real devices); M39-two-devices | n/a | manual |
| Memory, whole tab: GPU | [0018] | about 4 MiB page + 2 MiB instances + art | ceiling 20 MiB (20,971,520 B) asserted | `budgets.json` `counters.render.gpuBytes` | 2026-10-01 | met |
| Memory, whole tab: SABs | [0015] | about 12 MiB | exactly 12,582,912 B (12 MiB) | `budgets.json` `counters.sab.totalBytes` | 2026-10-01 | met |
| Download: game `.wasm`, warn | [0017], [0045] §1 | <= 1 MB brotli (decimal) | reference release 194,946 B brotli (19 %), 713,183 B raw | ADR [0045] §1; `budgets.json` `size.wasmBrotliWarn`; wasm test `size.test.ts` | 2026-09-30 | met |
| Download: game `.wasm`, fail | [0017], [0045] §1 | <= 2 MB brotli | same 194,946 B | `budgets.json` `size.wasmBrotliFail` | 2026-09-30 | met |
| Download: engine JS as downloaded | [0015] §6, [0045] §5 | <= 58 KB brotli | 53,251 B exact (ceiling 58,000 = ceil(exact x 1.1)) | `budgets.json` `size.engineJsBrotliExact`, `size.engineJsBrotli` (ADR [0045] §5) | 2026-09-30 | met |
| Allocation: main thread on engine-only pages | [0016] §1 | 110 B per frame (WebGPU floor), zero MinorGC / MajorGC | 110 B (`terrain`), 111 B (`connected-terrain`, `device-loss`), 117 B (`drawables`) with the page's formula; zero majors | `budgets.json` `gc.pages.terrain`, `connected-terrain`, `device-loss`; browser suite `gc-*.spec.ts` | 2026-10-01 | met |
| Allocation: main thread on pages with game, UI or input code | [0016] §1 | 110 B per frame | reference 234 B, input 190 B, anchors 508 B, zero_gc_action 115 B | `budgets.json` `gc.pages.reference`, `reference_single_player`, `input`, `anchors`; each row's `formula` string | 2026-10-01 | missed: each page's number is `ceil(measured clean) + 8 B` under ADR 0016 §1's own formula (and its Amendments), the §7 text of 110 B was never amended: needs decision (amend §7 to "110 B floor plus the page's own measured allocation" or accept as is) |
| Allocation: client, sim, gen workers | [0016] §1 | 8 B per frame | client 8, gen 8, sim 8 on `sim`, `gc-loop`, `topology`, `reference`; sim 17-18 B on `connected-terrain`, `device-loss`, `zero_gc_action`, 13 B on `drawables` | `budgets.json` `gc.pages.*.isolates.sim` | 2026-10-01 | missed: sim worker figure is above 8 B on four connected pages, set by each row's measured formula, no ADR changes the 8 B: needs decision |
| Allocation: net worker | [0016] | <= 1 KB per message | 244 B per frame (budgeted class), software adapter 660 B | `budgets.json` `gc.pages.multiplayer-topology.isolates.net` | 2026-10-01 | met |
| Allocation: zero major GCs, zero `memory.grow` | [0016] | 0 and 0 | 0 grows asserted by every gc page and both soaks; device-loss window included | browser tests `device loss then zero-GC window @slow` (`gc-device-loss.spec.ts`), `gc-reference-soak.spec.ts`; HUD `engine_mem_grows` | 2026-10-01 | met |
| Latency: action to authority | [0004], [0010] | <= 1 tick plus network | NOT SOURCED as a number (prediction and ack tests exist, none cited as the latency measurement) | none cited | n/a | manual |
| Latency: interpolation delay | [0010] | 100-400 ms adaptive, initial 150 | adaptation asserted under jitter profiles | tests `interpolation/jitter_profile_adapts`, `interpolation/lead_tracks_rtt_under_jitter`, `interpolation/stall_then_recover` | 2026-10-01 | met |
| Latency: snapshot cadence | [0005] | snapshot every 60 s (1,200 ticks) | asserted | test `snapshot_every_1200_ticks_if_dirty` (rust) | 2026-10-01 | met |
| Latency: log sync | [0005] | <= 1 s | NOT SOURCED in the files read | none cited | n/a | manual |
| Dev loop: reference `sim` edit to tests starting | [0020] §3, [0049] | <= 45 s | 17.0 s (median of 5, flat) | `pnpm measure:rebuild`; ADR [0048] §3 | 2026-10-01 | met |
| Dev loop: engine-crate edit to tests starting | [0049] (was [0020] §3 30 s) | <= 45 s | 37.6 s (37.1-39.5): missed the old 30 s, met under 45 s | `pnpm measure:rebuild`; ADR [0048] §3, ADR [0049] | 2026-10-01 | met |
| Test suite: whole fast tier wall time | [0020] | < 60 s warm | p50 51.7 s, max 53.1 s over 5 runs at 1-minute load 6-20 (M36b: 48.5 s p50 quiet) | `pnpm test:timings` (`test-results/timings/summary.json` `totalMs`) | 2026-10-02 | met |
| Test suite: `rust` fast suite | [0020] §3, [0048] §1 | <= 10 s | 1.6 s | baseline run, Tyler's Mac; per-suite table in ADR [0048] §1 | 2026-10-02 | met |
| Test suite: `unit` fast suite | [0020] §3, [0048] §1-2 | <= 3 s | 1.3 s | same; `unit` runs first (`first: true`) | 2026-10-02 | met |
| Test suite: `wasm` fast suite | [0020] §3, [0048] §1 | <= 7 s | 3.1 s | same | 2026-10-02 | met |
| Test suite: `netcode` fast suite | [0020] §3, [0048] §1 | <= 10 s | 4.1 s | same | 2026-10-02 | met |
| Test suite: `browser` fast suite | [0020] §3, [0048] §1 | <= 48 s | 43 s | same (M37b: 246 tests, about 42 s p95) | 2026-10-02 | met |
| Test suite: slow tier | [0020] §3 | all pass | browser 82 tests 65 s, rust 9 tests 33 s, wasm 22 tests 45 s, netcode 14 tests 81 s, frame-bench 2 tests 7.2 s; all pass | `pnpm test:slow`, Tyler's Mac | 2026-10-02 | met |
| Hosting cost: always-available | [0009] | about $5 per month | Fly shared-cpu-1x 512 MB, 30 days always-on: $3.69 at the base rate, $4.62 with the `ord` markup, plus volume $0.15 (ADR 0009 said $3.32; Fly's page constants do not reproduce it). Billed figure awaiting Tyler (Fly dashboard, "Upcoming invoice") | M38 Deviations, "Results (Fly ...)" cost row; Durable Objects projected $0.18 over the plan for 2 observers but no-go, ADR [0051] | 2026-10-02 | computed |
| Hosting cost: idle | [0009] | about $0 | stopped machine: volume $0.15 + rootfs about $0.01 = about $0.16 per month ($0.20 with markup); idle stop observed 30 s after the last client left | M38 Deviations cost row and Idle stop row | 2026-10-02 | computed |
| Hosting: Durable Objects as second target | [0009], [0051] | go needs usable memory >= 96 MiB, no tick throttling, cost in plan, at most 1 restart per hour | restore from a snapshot fails on the deployed object (usable arena 40-48 MiB at scale 4, none at scale 1); timer and cost items met; restarts measured for one hour only | ADR [0051] (Decision 2, Measurements) | 2026-10-02 | missed: decided, ADR 0051 changes the target list to Node/Bun on a process (Fly), DO dropped |

[0004]: ../../decisions/0004-action-timing-and-rejection.md
[0005]: ../../decisions/0005-persistence-and-recovery.md
[0007]: ../../decisions/0007-world-model.md
[0008]: ../../decisions/0008-chunk-generation.md
[0009]: ../../decisions/0009-transport-and-hosting.md
[0010]: ../../decisions/0010-rates-and-subscriptions.md
[0013]: ../../decisions/0013-sessions-and-integrity.md
[0015]: ../../decisions/0015-threads-memory-and-topology.md
[0016]: ../../decisions/0016-zero-gc-definition.md
[0017]: ../../decisions/0017-packaging-and-build.md
[0018]: ../../decisions/0018-renderer.md
[0020]: ../../decisions/0020-testing-strategy.md
[0024]: ../../decisions/0024-planning-amendments.md
[0045]: ../../decisions/0045-build-profiles-measured.md
[0047]: ../../decisions/0047-bench-gate-absolute-floor.md
[0048]: ../../decisions/0048-fast-tier-budgets-dev-loop-and-wire-measurements.md
[0049]: ../../decisions/0049-compile-budget-45s.md
[0051]: ../../decisions/0051-durable-objects-no-go.md

## Notes for the orchestrator

- Phone rows stay `manual` until Tyler runs M39-frame-shares, M39-large-save, M08-worldgen-ms-per-chunk, M11-memory, M16-coexist, M09b-fill-rate and the M34 section; fill their **Run on** numbers into the Measured column then.
- The fast-tier whole wall time was measured by the orchestrator (`pnpm test:timings`, 2026-10-02).
- The two Allocation `missed` rows are a documentation mismatch between PRE-PLAN §7 and the per-page rows of `budgets.json`, not a runtime regression; the 0016 ADR formula produced them. Decide before M39b writes the permanent ADR.
