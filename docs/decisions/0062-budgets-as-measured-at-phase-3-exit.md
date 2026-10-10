# 0062: Budgets as measured at Phase 3 exit

Status: Accepted (2026-10-10). Supersedes nothing; amends nothing. It is the permanent record of the performance budgets and what Phase 3 measured against them, written because the table in `PRE-PLAN.md` §7 is deleted in Phase 4. Written in M39b from the M39 budget ledger.

## Context
Phase 1 derived one table of budgets (15 rows, each owned by an ADR). Phase 3 measured them on Tyler's Mac (Apple M3 Max, arm64, shared with other sessions) and on his iPhone 12 (iOS 18.7, Safari 27). This ADR keeps, per budget: the number, the owner ADR (which holds the reasoning and is not copied), the value measured at exit, and how to measure it again. The numbers the tests assert live in `packages/engine/budgets.json` and `packages/engine/baselines/*.json`; they are the enforcement, this is the record. Where a number is a test ceiling set from a measurement (`ceil(measured) + margin`), the row says so.

Verdicts: **met**, **manual** (only a phone or Tyler can measure it; a device check id is given), **computed** (arithmetic from a measured part), **recorded** (the measurement differs from the Phase 1 text and this ADR states which figure stands). Dates are measurement dates; "device" rows were taken on the iPhone 12 in the rounds of 2026-10-07 to 2026-10-10.

## Decision

**1. Rules for wall-clock budgets.** A gated benchmark fails only when it is over 25 % above its checked-in baseline **and** more than `minDeltaMs` above it ([0047](0047-bench-gate-absolute-floor.md) §1). `minDeltaMs` is twice the max-minus-min spread over at least ten runs on the baseline machine, with its derivation in the baseline's `conditions`; it is never raised to clear a red run (0047 §2). A `limits` figure (the proxies below) fails on its own regardless (0047 §3). Baselines are promoted with `pnpm bench:baseline [name]` and only on the same machine fingerprint. Absolute numbers from another machine are warn-only evidence.

**2. The ledger.** One entry per Phase 1 row. "Re-measure" gives a command (run on the baseline machine) or a device check id (`pnpm device:walk`; the bench build is served with `pnpm device:serve --app reference --bench`, add `--tunnel` for a phone, page `?bench=large-save`).

*Frame time* (owner [0018](0018-renderer.md) §9; confirmed, no change). Baseline phone 60 fps = 16.6 ms.
- Main rAF callback <= 4 ms: 0.3 ms p95 (device, 2026-10-09). Re-measure: device check `M39-frame-shares` (bench HUD `main p95`).
- Client-worker `frame` <= 8 ms: 1.38 ms p95 (device). Re-measure: `M39-frame-shares` (`frame p95`).
- GPU <= 6 ms: 2.43 ms GPU execution p95 (device). Re-measure: `M09b-fill-rate` (the GPU share is that check's, not the HUD's).
- Desktop proxy, main <= 1.3 ms: p50 0.082 ms at maximum zoom-out over the large save (2026-10-01); the older worst-case scene 0.64 ms. Met.
- Desktop proxy, worker <= 2.7 ms: p50 0.120 ms (reference scene); worst-case scene 2.15 ms p50 (2026-09-23). Met.
- Re-measure the proxies: `pnpm test:slow frame-bench` (the reference scene alone: `-t bench.frame_reference`), or `pnpm bench:frame` to print the table; for a cause, the `profile-frame` skill. The reference scene is the gated one and carries `minDeltaMs` 0.1 (0047 §4).

*Tick time* (owner [0010](0010-rates-and-subscriptions.md); the derived figures are **confirmed**). Budget <= 10 ms per 50 ms tick on the slowest host; desktop proxy <= 3 ms on the standard large save (state budget full, 8 players).
- Desktop proxy: **2.87 ms** median against the 3 ms proxy (p99 3.53, max 4.24), native release, 2026-10-01. About 4 % headroom: a tick change that adds cost is a deliberate trade against this number, not noise. Re-measure: `pnpm test:slow rust` (`slow_tick_large_save`); `pnpm bench:baseline tick` to promote.
- Node twin of the same save: median 10.63 ms, warn-only by design ([0024](0024-planning-amendments.md) §14), computed. Re-measure: `pnpm test:slow wasm` (`tick-large-save node`).
- Phone sim worker: **9.34 ms** `tick_p95_ms` on the iPhone 12 after M39ag (driverless, 2026-10-09; sim_tick p50 6.34 ms) against 10 ms: met with 7 % headroom. Earlier rounds failed (10.9 to 13.9 ms on 2026-10-07/08); the figure above is the one after M39ag. Re-measure: `M39-large-save` on a bench build, read the HUD `tick p95` after at least 10 s (it is inflated early: the first tick visits all 262,144 furnaces). On Android `tick p95` is reported, not judged ([0056](0056-ios-pacing-and-tick-bar.md)).
- Fly shared-cpu-1x: tick p50 0.06-0.43 ms, window p99 up to 5.02 ms, max single tick 7.90 ms, `overruns=0`, 20 Hz, 8 clients, on the small reference world (not the large save), 2026-10-02. Met. Re-measure: the load test against a deployed server ([0051](0051-durable-objects-no-go.md) holds the host decision); the Fly machine used then is destroyed.

*Chunk generation* (owner [0008](0008-chunk-generation.md)).
- Desktop warn above 0.25 ms per chunk: 0.0685 ms (2026-10-01; the Phase 1 text said 0.09-0.11). Met. Re-measure: `pnpm test:slow rust` (`slow_worldgen_chunk_reference`) and the wasm `worldgen-bench`; `pnpm bench:baseline worldgen`.
- Baseline phone <= 1 ms per chunk: 0.1 ms median (device). Re-measure: `M08-worldgen-ms-per-chunk` (and `M08-warn-threshold` for the phone/desktop factor).
- Join at full zoom-out, 81 visible chunks: desktop about 5.5 ms (computed, 81 x 0.0685; Phase 1 estimate 8 ms), phone about 8 ms (computed, 81 x 0.1 ms; Phase 1 estimate 25-40 ms). Both are better than estimated; no direct timing exists.
- Host warmer 2 ms per tick gap: a design limit of 0008, **not measured**. No baseline asserts it. Trigger to measure: any host where `tick p99` rises while the warmer runs.

*GPU upload* (owner [0018](0018-renderer.md)). <= 64 KiB of chunk texels per frame: max 65,536 B per frame in the reference run, equal to the budget, 2026-10-01. Draws 2-10: at most 3 per frame. Met. Re-measure: `pnpm test` browser suite (the `terrain: upload budget while panning` and `device loss: uploads stay under the frame budget` tests); `counters.render.*` in `budgets.json`.

*Bandwidth, steady* (owner [0010](0010-rates-and-subscriptions.md)). All measured 2026-10-01 over the netcode suite's rate tests. Met.
- Down 1-5 KB/s typical: busy field 1.4 KB/s; an observer with 200 lit furnaces 0.84 KB/s (3.1 KB/s at 1,000), below the typical range at both. Re-measure: `pnpm test:slow netcode -t busy-furnace-field`, and the fast `rates/steady-busy-field`.
- Remote presences: 7 remote presences 911 B/s measured (budget 1,220 B/s). Test `rates/seven-remote-presences`.
- Up while panning about 0.4 KB/s, about 0 at rest: 324 B/s panning, idle heartbeats 200 B in 10 s. Tests `rates/uplink-panning`, `rates/idle-sends-only-heartbeats`.
- Soft cap 16 KB/s for tick frames: no steady run reaches it; the degrade path is asserted at the cap (`rates/degrade-on-soft-cap`, `rates/degrade-on-stall`).
- Re-measure all: `pnpm test netcode`.

*Bandwidth, burst* (owner [0010](0010-rates-and-subscriptions.md), [0013](0013-sessions-and-integrity.md)). Met, 2026-10-01.
- Refill 48 KB/s and burst 128 KB: exact (2,400 B per tick, 128,000 B). Test `rates/bucket-refill-exact`.
- Hard ceiling <= 64 KB/s: worst second 51,645 B (join), 49,012 B (pan).
- 10-20 MB per hour: 324,399 B per simulated hour on the test scenario.
- Reconnect about 1 KB each way: 280 B up, 130 B down (wilderness). Test `reconnect/cost`.
- Subscription cap: **144 chunks per client, not 128** ([0059](0059-subscription-cap-144.md), 2026-10-10); the burst rows above were measured at the earlier cap and the `zoomout/*` rows measure 144. Re-measure: `pnpm test netcode` (`zoomout/*`, `rates/*`).

*Action rate and log* (owner [0004](0004-action-timing-and-rejection.md)). Met, 2026-10-01. 20 per second sustained, burst 40: the limiter holds at both (`rates/action-rate-limited`). 12 B per logged action (budget 12-18). 65 KB per active player-hour is an enforced ceiling (`budgets.json` `action.logBytesPerPlayerHour`), **computed**: no separate measured hour exists.

*Memory per instance* (owner [0015](0015-threads-memory-and-topology.md) §5, [0007](0007-world-model.md)).
- Sim arena 96 MiB: high water 88 MiB on the large save (`memoryBytes` 101,974,016, 0 grows), 2026-10-01. Met. Re-measure: `pnpm test:slow netcode` (soaks) and `pnpm test:slow wasm` (`bench-build`); `mem.simHighWaterLargeSave` is record-only.
- Client arena 48 MiB, gen arena 4 MiB: no per-arena high-water exists (no ABI export for live arena bytes); the evidence is `engine_mem_grows` 0 on every zero-GC page and soak. Met by that proxy.
- Ceiling 256 MiB on mobile: no reload with scratch memory grown to 1 GiB (device). Re-measure: `M11-memory`.
- World budget 64 MiB (262,144 entities, 1,048,576 modified tiles): the full-budget runs of tick, genesis, join and persistence pass (`reference_state_budget_full`). Met.
- Dense cache 1,024 chunks = 4 MiB: **not measured**; the 4 MiB follows from 4 KiB per chunk and no test reads the size. Trigger to measure: a change to the dense chunk layout.

*Memory, whole tab* (owner [0015](0015-threads-memory-and-topology.md), [0018](0018-renderer.md)).
- <= 256 MiB single-player on the phone: no MiB figure is readable on iOS; 10 minutes on the large save with no reload and `engine_mem_grows` 0 (device). Manual. Re-measure: `M39-large-save`, `M11-memory`, `M16-coexist`.
- About 160 MiB multiplayer: **not measured** (no reading was taken). Re-measure: the M34 section and `M39-two-devices`.
- GPU about 6 MiB plus art: ceiling 20 MiB asserted (`counters.render.gpuBytes`). SABs about 12 MiB: exactly 12,582,912 B. Met.

*Download* (owner [0017](0017-packaging-and-build.md), [0045](0045-build-profiles-measured.md) §1, §5; measured 2026-09-30). Game `.wasm`: 194,946 B brotli (713,183 B raw) against 1 MB warn and 2 MB fail. Engine JS as downloaded: 53,251 B brotli against a 58,000 B ceiling (`ceil(exact x 1.1)`). Met. Re-measure: `pnpm test wasm` (`size.test.ts`).

*Allocation per isolate* (owner [0016](0016-zero-gc-definition.md) §1; **recorded**, not changed). Measured 2026-10-01.
- Main thread: 110 B per frame is the WebGPU floor and holds on engine-only pages (110-117 B). Pages with game, UI or input code carry their own measured ceiling, `ceil(measured clean) + 8 B` by 0016 §1's formula: reference 234 B, input 190 B, anchors 508 B, `zero_gc_action` 115 B. **The per-page number in `budgets.json` is the budget; 110 B is the floor under it**, not a limit for those pages. Zero MinorGC/MajorGC is asserted everywhere.
- Client, sim, gen workers: 8 B per frame holds on `sim`, `gc-loop`, `topology` and `reference`; the sim worker measures 13-18 B on the four pages that connect a client (`connected-terrain`, `device-loss`, `zero_gc_action`, `drawables`), recorded in each page's formula. The 8 B is the target for a worker with no connected-page work.
- Net worker <= 1 KB per message: 244 B per frame (660 B on the software adapter). Zero `memory.grow` on every page, both soaks and the device-loss window.
- Re-measure and change numbers only through the `gc-test` skill; attributed-minimum rules are [0058](0058-zero-gc-attributed-minimum-per-window.md).

*Latency* (owner [0004](0004-action-timing-and-rejection.md), [0010](0010-rates-and-subscriptions.md), [0005](0005-persistence-and-recovery.md)).
- Interpolation delay 100-400 ms adaptive, initial 150: adaptation asserted under jitter profiles (`interpolation/*`). Met.
- Snapshot every 60 s (1,200 ticks): asserted (`snapshot_every_1200_ticks_if_dirty`). Met.
- Action to authority <= 1 tick plus network, and log sync <= 1 s: **not measured as numbers**; prediction and ack tests prove the behaviour, not the latency. Trigger to measure: any deploy where a player reports lag; use the loadtest against a real host.

*Dev loop* (owner [0020](0020-testing-strategy.md) §3, amended by [0049](0049-compile-budget-45s.md); **changed**: 30 s became 45 s). One-line edit to tests starting: engine-crate edit 37.6 s (37.1-39.5), reference `sim` edit 17.0 s, flat over five reps, 2026-10-01, with `split-debuginfo = "packed"` ([0048](0048-fast-tier-budgets-dev-loop-and-wire-measurements.md) §3). Met against 45 s. Re-measure: `pnpm measure:rebuild`.

*Test suite* (owner [0020](0020-testing-strategy.md)). Fast tier < 60 s warm: `pnpm test` wall p50 48.5 s quiet at M36b (2026-10-01), 51.7 s p50 and 53.1 s max over five runs under load 6-20 (2026-10-02). Per-suite budgets and their measured p50/p95 are in [0048](0048-fast-tier-budgets-dev-loop-and-wire-measurements.md) §1 and are not copied. **Changed 2026-10-10:** the `browser` fast-tier budget is 60 s ([0060](0060-browser-fast-tier-budget-60s.md); Tyler accepted a fast tier of about 70 s with the build); the fast tier is therefore "under about 70 s", the 60 s above describing the earlier requirement. Slow tier: all five slow suites passed on 2026-10-02 (browser 65 s, rust 33 s, wasm 45 s, netcode 81 s, frame-bench 7 s). Re-measure: `pnpm test:timings` (`--runs K`, p95 per test in `test-results/timings/summary.json`), `pnpm test:slow`.

*Hosting cost* (owner [0009](0009-transport-and-hosting.md)). About $5 per month always-available: Fly shared-cpu-1x 512 MB computes to $3.69-4.62 plus $0.15 volume, computed; the billed figure Tyler read on 2026-10-10 was $0.04 month-to-date with the machine mostly stopped, consistent with the idle projection (always-on was never billed: the app was destroyed that day). About $0 idle: a stopped machine costs about $0.16 per month; idle stop was observed 30 s after the last client left. Durable Objects as a second target failed its go criteria and were dropped ([0051](0051-durable-objects-no-go.md)). Re-measure: the provider's invoice.

**3. Measured and decided not to build.** From M36b ([0048](0048-fast-tier-budgets-dev-loop-and-wire-measurements.md) §4-§6); each was measured against a stated trigger that did not fire. Re-measure with `pnpm test:slow wasm -t feature-matrix` and `pnpm test:slow netcode -t busy-furnace-field`.
- `wasm-opt` and `+simd128` stay **off** in the build identity (gain: 1.75 % and 0.18 % brotli, about 1 % tick); `wasm-opt` remains an opt-in deploy choice ([0045](0045-build-profiles-measured.md) §1).
- Byte diffing is **not needed**; it stays a non-API option (the `measure-diff` feature measures it). Revisit if a game's steady downlink at its typical view passes 10 KB/s.
- **No build cache** (no `sccache`, no shared `CARGO_TARGET_DIR`): cold build in a fresh worktree 94 s, cached CI build 208-254 s, against triggers of 3 and 5 minutes.

**4. Changes of 2026-10-10 to budgets.** The `browser` fast-tier budget is 60 s ([0060](0060-browser-fast-tier-budget-60s.md)); the default subscription cap is 144 chunks ([0059](0059-subscription-cap-144.md)).

**5. Not yet measured.** Rows marked "not measured" above (warmer yield, dense cache size, multiplayer tab memory, action latency, log sync) have no number behind them. They are the budget as designed, not as measured; a future session that measures one writes the figure in a new ADR that cites this one.

## Alternatives rejected
- **Copy the Phase 1 table forward unchanged.** It would claim measurements nobody made and keep three figures (tick, frame, tests) that the project has since confirmed or changed.
- **Amend 0016 to a per-page main-thread number.** The formula in 0016 §1 already produces it; the entry above records the reading without rewriting an accepted ADR.
- **Copy the fast-tier table from 0048.** One owner per fact; the table is there.

## Consequences
- After `PRE-PLAN.md` is deleted, this ADR and the owner ADRs are the only budget record; `budgets.json` and `baselines/*.json` are the enforcement.
- The tick proxy has 4 % headroom (2.87 of 3 ms) and the phone tick 7 % (9.34 of 10 ms): the next change to the sim hot path should re-run both before landing.
- A baseline is promoted only on the baseline machine's fingerprint, by a reviewed edit.

## Sources
- `docs/plan/acceptance/budgets.md` (M39 ledger), `PRE-PLAN.md` §7, `packages/engine/budgets.json`, `packages/engine/baselines/*.json` (all checked 2026-10-10).
- Re-measure commands from the M36 and M36b Deviations (`docs/plan/36-slow-tier-and-benchmarks.md`, `docs/plan/36b-suite-audit-and-measurements.md`), checked 2026-10-10; digest in [0048](0048-fast-tier-budgets-dev-loop-and-wire-measurements.md).
- Device rounds `m39ad-iphone-driven`, `m39ad-iphone-qr`, `m39ag-iphone-large-save` (`docs/plan/device-checks.md`, 2026-10-07 to 2026-10-10).
- [0047](0047-bench-gate-absolute-floor.md), [0049](0049-compile-budget-45s.md), [0051](0051-durable-objects-no-go.md), [0059](0059-subscription-cap-144.md), [0060](0060-browser-fast-tier-budget-60s.md).
