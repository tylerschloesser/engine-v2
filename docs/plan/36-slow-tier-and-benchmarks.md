# M36: Slow tier and wall-clock benchmarks

Status: not started · After: 34c, 35 · Tyler-dependent: no

Split: the suite audit and the deferred measurements (demotion audit, 30 s rebuild, build-cache decision, `wasm-opt`/`+simd128`, byte diffing) are `36b-suite-audit-and-measurements.md`; together they were well past the line rule. `After` includes 35 because the slow tier this milestone completes includes M35's packaging tests; M35 needs only M29, so no ordering is lost.

## Goal
`pnpm test:slow` is complete per 0020: heavy mode at N = 1 on every recorded log, golden replay on the release module, the standard large save with the tick and frame wall-clock benchmarks gated at the 25 % threshold on the baseline machine, soak and large-world variants, the WebKit readback scene. The two derived budgets of PRE-PLAN §7 (tick time, frame time) have measured desktop-proxy numbers in checked-in baselines, and three questions other briefs handed here are answered.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` (§2 output contract, §4 slow tag, §5 heavy mode and golden regeneration, §6 WebKit readback and probe rules, §9 all of it, §10 "timings recorded, never gating")
3. `docs/decisions/0010-rates-and-subscriptions.md` ("Tick CPU budget": what a tick covers, the desktop proxy)
4. `docs/decisions/0018-renderer.md` (§9 frame-time budget: shares, desktop proxy, worst-case view)

Mine from spikes: none new (M17b's `scripts/profile-frame.mjs` already carries the trace reader). Rules that apply: `.claude/rules/determinism.md` (the bench `genesis` is sim code), `.claude/rules/hot-paths.md` (no bench hook on a tick or frame path may allocate).

## Scope
- **Slow-tier completeness.** Every `@slow` / `slow_*` test of every suite runs under `pnpm test:slow` with the 0020 §2 contract, including the stray bench commands earlier milestones created (the `worldgen-bench` slow test of M08, already a tier member; the reference worldgen bench of M20; `pnpm bench:frame` of M17b): each is a slow-tier member reporting through the runner, and `pnpm bench:frame` keeps its alias.
- **Heavy mode at N = 1** (0002 §3, 0020 §5): M22b's `heavy_wasm_n1 @slow` covers the `persist` fixture; extend the same `runHeavy` call to every recorded fixture log and to M34b's `tests/golden/full-game.log`, under Node. Native twin through `engine::testing::heavy`.
- **Release-profile golden replay** (0017 §9): every golden log against `buildGame({ profile: 'release' })` under Node and Bun, same checked-in hashes (`release-golden @slow`). Plain release only; the `wasm-opt` and `+simd128` variants are M36b's.
- **The standard large save** (0020 §9): a seeded builder in the reference `sim` crate behind cargo feature `bench`, reached through `Game::genesis` when the worldgen params carry the bench marker. It fills both state budgets exactly as §9 specifies with uniformly staggered furnace timers. A native test asserts entity, modified-tile and entity-chunk counts equal the §9 figures *computed* from `WorldConfig` defaults, and that two builds from one seed hash equal. The reference page accepts `?bench=large-save` on bench builds only (M39's device check loads it on the iPhone, per M07's hand-over).
- **Tick benchmark** (`rust` suite, `slow_tick_large_save`, release profile): warm-up and sample counts per 0020 §9, median and p99. Eight headless players with maximum-view subscriptions at the §9 action rate; frames are built through the Rust entry points behind `sim_admit` / `sim_tick` / `sim_build_frame` (0014 §4) and discarded. Gate: the 0010 desktop proxy and the 25 % rule. A record-only twin, `tick-large-save node @slow`, drives the same save as `.wasm` through `createWorldServer`, so the TS sim host and WASM codegen show up somewhere.
- **Handed-over questions on the large save:** (M22) does `sim_snapshot_*` finish inside the catch-up window of 0005 "Idle pause" on the desktop proxy (one third of it, by 0018 §9's phone factor)? Report time and `lastSnapshotBytes`; "no" is a new ADR, not a tweak. (M07) the sim instance's WASM high-water mark on the large save is asserted against a `budgets.json` ceiling, with `engine_mem_grows() == 0`.
- **Frame benchmark.** M17b's `bench.frame_worstcase` measures a synthetic full DrawList. Add `bench.frame_reference @slow`: reference game single-player on the large save, camera at maximum zoom-out over a dense base, slow pan, real rAF with M17b's flags; main rAF callback and client-worker `frame`, median and p99. Gate: the 0018 §9 proxies and the 25 % rule. Draw-call and upload-byte counters are asserted in the same run against `budgets.json`.
- **Baselines and the gate.** `packages/engine/baselines/` (M17b created `frame.json`): add `tick.json`, `frame-reference.json`, `worldgen.json`. One helper, `scripts/lib/bench-gate.mjs`, applies the 25 % rule to all of them (failing for the gated benchmarks; `warn` only for the record-only Node twin, `gate(name, sample, { warnOnly: true })`) and only when the machine fingerprint matches the baseline's; elsewhere it records to `test-results/<suite>/bench/*.json` and never fails (0020 §9, §10). `pnpm bench:baseline [name]` rewrites a baseline: explicit command, reviewed diff.
- **Soak and large-world variants:** `soak-netcode @slow` (reference game, 8 `HeadlessClient`s, conditioner, 30 virtual minutes with scripted drops and rejoins: replica hash equality at quiescence, zero grows, `net.*` counters within `budgets.json`, memory high-water mark flat after minute 5); `soak-browser @slow` (single-player, 12,000 stepped ticks of M34b's script looped: the M04 assertion over the whole window, `memory.buffer.byteLength` unchanged); `slow_heavy_large_save` (heavy mode every 100 ticks for 300 ticks on the large save).
- **WebKit readback** (`webkit-readback @slow`): one existing M09 readback scene with the same semantic probes in Playwright WebKit on macOS; records `adapter.info`; skipped by platform on Linux with a named notice (0020 §6 promises that adapter on macOS only).

## Non-scope
Everything in M36b. Phone frame times (manual, 0018 Consequences). Optimisation beyond what a gate needs: a missed gate is reported with a profile and handled as a plan edit. Packaging tests (M35; this milestone only confirms they run in the tier).

## Files, packages and crates touched
`games/reference` (`sim/src/bench.rs`, feature `bench`, `sim/tests/` or `benches/` for the tick bench, page param), `packages/engine` (`tests/**` slow tests, `baselines/*.json`, `budgets.json`), repo `scripts/` (`lib/bench-gate.mjs`, `suites.mjs` entries). The engine crate only if `engine::testing` lacks a constructor that runs `genesis` with custom params.

## Seams
**Provides:** cargo feature `bench` on the reference `sim` crate, `bench::standard_large_save(w: &mut dyn WorldWrite, seed)`; `?bench=large-save`; `baselines/{tick,frame-reference,worldgen}.json`; `scripts/lib/bench-gate.mjs` `gate(name, sample, { warnOnly? })`; `pnpm bench:baseline`; tests `slow_tick_large_save`, `tick-large-save node @slow`, `slow_snapshot_large_save`, `bench.frame_reference @slow`, `release-golden @slow`, `heavy-n1 all logs @slow`, `soak-netcode @slow`, `soak-browser @slow`, `slow_heavy_large_save`, `webkit-readback @slow`; `budgets.json` key `mem.simHighWaterLargeSave`.
**Consumes:** `runHeavy`, `replayWorld`, `heavy_wasm_n1` (M22b); `engine::testing::{replay, heavy}`, `lastSnapshotBytes` (M22); golden logs and regeneration commands (M05, M34b `golden:record`); `Sim<G>` driver and the host API behind the 0014 sim exports (M12b, M13, M15); `createWorldServer`, `HeadlessClient`, conditioner, `VirtualClock` (M27); `net.*` counters (M15, M31); `memory_bytes()` and the init-time sum (M07, M21); zero-GC `measure` (M04); readback scenes and probes (M09); `bench.frame_worstcase`, `baselines/frame.json`, `scripts/profile-frame.mjs`, `profile-frame` skill (M17b); the `worldgen-bench` slow test (M08) and the reference worldgen bench (M20); `buildGame({ profile, env })` (M02) and `buildGame({ features })` (M34b); runner, tiers, `scripts/suites.mjs` (M01); M35's slow tests.

## Planning decisions
- **Native gate, WASM record (0024 §14).** 0020 §9 and 0010 define the proxy as a *native* benchmark, while subscriptions and fan-out live in the TS sim host (0015 §1 "Server"). The native bench therefore fixes each player's subscription set directly and measures the Rust side; the Node twin makes a host-side or codegen regression visible. It gets a baseline entry and is warn-only: a regression over 25 % prints a `warn` line, it never fails, and it has no absolute budget (0024 §14). It is not under the failing 25 % rule.
- **Machine fingerprint** = `os.cpus()[0].model` + `os.arch()`, stored in each baseline. No environment variable to forget; CI never matches, which is 0020 §10's "recorded, never gating". If M17b chose another mechanism for `frame.json`, keep one: migrate to this helper.
- **Bench marker through a cargo feature, not a second `Game`.** Tick rules, entity type and encoders are exactly the shipped ones. The feature is never enabled by `vite build` or the fast tier; `buildGame({ features })` is the only way in, and the different build hash keeps a bench client from joining a normal server.
- **`slow_heavy_large_save` uses N = 100.** A full-budget snapshot per tick takes minutes and adds nothing over N = 1 on the scripted logs, where hidden state actually shows.
- **Snapshot stall criterion.** The catch-up rule allows five ticks per wakeup (0005), so a snapshot that fits five tick intervals on the phone loses no wall-clock time that catch-up cannot recover; one third of that is the desktop proxy. This is this brief's reading of M22's question; record it next to the number.
- **If this does not fit one session,** cut `soak-browser` and `slow_heavy_large_save` into `36c` first; never the two gated benchmarks or the handed-over questions.

## Order of work
1. Tier completeness (bench commands under the runner). 2. `heavy-n1 all logs`, `release-golden`. 3. The `bench` feature built through M34b's `buildGame({ features })`, the builder and its native assertions, a 1/64-scale fast test. 4. `slow_tick_large_save`, Node twin, snapshot stall, high-water mark. 5. `bench-gate.mjs`, baselines. 6. `bench.frame_reference`, `?bench=large-save`. 7. Soak variants. 8. `webkit-readback`. 9. Skills and nested `CLAUDE.md`.

## Tests added
By name under Provides; all slow. One fast `rust` test: `large_save_builder_is_deterministic` on a 1/64-scale config (inside the 0020 §4 p95 limit), so the builder cannot rot between slow runs. `unit`: `bench-gate: threshold and fingerprint`.

## Exit criteria
- [ ] `pnpm test:slow` runs every slow test of every suite, one line per suite, exit 0 on Tyler's Mac; `pnpm bench:frame` still works as an alias.
- [ ] `heavy-n1 all logs` and `release-golden` pass under Node (and Bun for the replay).
- [ ] The builder's native test proves the §9 counts and determinism.
- [ ] `slow_tick_large_save` meets the 0010 desktop proxy and `bench.frame_reference` both 0018 §9 proxies, each with a baseline. A miss is not hidden: Deviations gets the profile and a plan edit is raised.
- [ ] The gate fails when a sample is pushed 30 % over baseline on the baseline machine (checked once with an injected delay, then reverted) and only records under another fingerprint (`unit` test).
- [ ] Snapshot-stall answer and the high-water mark are recorded (Deviations and `budgets.json`); a "no" on the stall has its ADR or a plan edit.
- [ ] The three soak variants and `webkit-readback` pass.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm lint` · `pnpm test:slow` · `pnpm test:slow rust -t slow_tick_large_save` · `pnpm test:slow browser -t bench.frame_reference` · `pnpm test:slow netcode -t soak-netcode` · `pnpm bench:baseline tick` (only to create or deliberately move a baseline)

## Budgets
PRE-PLAN §7 "Tick time": `slow_tick_large_save`. "Frame time": `bench.frame_reference` (desktop proxy; phones stay manual). "GPU upload": counters inside the same run. "Memory per instance": `mem.simHighWaterLargeSave`, zero grows in both soaks. "Allocation per isolate": `soak-browser`. "Chunk generation": `baselines/worldgen.json`. "Latency" (snapshot cadence): the stall measurement. M39 reads measured values from `baselines/*.json` and `budgets.json`.

## Context artifacts
`run-tests` skill: slow tier layout, baseline regeneration rule, where bench JSON lands. `profile-frame` skill: `bench.frame_reference` as the capture for reference-game regressions. `games/reference/CLAUDE.md`: the `bench` feature, and that it must never ship.

## Manual device checks
None of its own. It supplies `?bench=large-save` for item M39-large-save: [device-checks.md, M39](device-checks.md#m39-acceptance).

## Deviations
(filled in during Phase 3)
