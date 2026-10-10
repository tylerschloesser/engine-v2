# Testing and tooling

Everything is run through a few Node scripts in `scripts/` (plain `.mjs`, `node:fs`, no shell file operations). `scripts/suites.mjs` registers build steps and suites and nowhere else; `scripts/test.mjs` runs them (`pnpm test`, `pnpm test:slow`); `scripts/lint.mjs` runs `pnpm lint`; `scripts/lib/` holds the adapters, report formatting and bench gate. Strategy: [0020](../decisions/0020-testing-strategy.md). Procedures for running things: `.claude/skills/run-tests/SKILL.md`. Budgets as measured: [0062](../decisions/0062-budgets-as-measured-at-phase-3-exit.md).

## Design rules the tests rely on

- The engine reads no wall clock and schedules no frame a test cannot drive: clock, `stepTick()`, `stepFrame(dt)` and input are injectable (behind the `engine/test` entrypoint, absent from production bundles). Everything random is seeded. Browser tests step frames; they never depend on real `requestAnimationFrame` pacing except `frame-bench`.
- Mocking is avoided. `scripts/lib/no-module-mocks.test.mjs` scans test files and allowlists `vi.mock`-style module mocks by file. The netcode harness fakes only the transport (in-memory `Connection`) and the clock (virtual).
- The sim runs headless outside a browser (nextest, and the `.wasm` under Node and Bun), so most logic is tested without one.

## Tiers and the runner

`pnpm test [suite] [-t substring]` is the fast tier; `pnpm test:slow [suite] [-t substring]` is `--tier slow`. `-t` is a plain substring. Slow tests are tagged `@slow` in the title (Vitest, Playwright) or named `slow_*` (nextest; `.config/nextest.toml` filters on it). A test stays fast only if p95 is at most 0.5 s (Rust, Node) or 3 s (browser); demotion order and the never-demote-the-only-test rule: [0020](../decisions/0020-testing-strategy.md) §4. Output is one line per suite (`name pass|FAIL N tests 1.2s/3s`), details only on failure, logs in `test-results/<suite>/`. Exit 0 pass, 1 test/budget/build failure, 2 usage or a missing pinned tool (`pnpm setup:tools` installs nextest, Bun, Playwright browsers; `pnpm test` only probes them).

Runner phases (`scripts/test.mjs`):

1. Clear old artefacts, probe pinned tools.
2. Build steps, serially (cargo steps would only queue on the target-dir lock): `tsc` (`pnpm --filter engine build`) -> `fixtures` (`packages/engine/scripts/build-fixtures.mjs`, every fixture crate, dev profile) -> `game-sims` (dev build of each `games/*/sim`) -> `cargo-tests` (`cargo nextest run --workspace --no-run`) -> `doctests` (`cargo test --doc -p engine`; nextest runs none) -> `pages` (`vite build` of the fixture app) -> `reference` (`vite build --minify false` of `games/reference`; unminified so software-mode zero-GC attribution has function names). Slow tier only: `reference-bench` (`games/reference/dist-bench/`). Every cargo call must share one package scope (`--workspace`) or a shared dependency recompiles every run. Per-step times go to `test-results/build/timings.json`. The build has a 10 s budget (`buildBudgetMs`, [0033](../decisions/0033-fast-tier-budget-after-build-fix.md)) that only warns on stderr; it cannot tell cold from warm.
3. Suites: `first` suites alone, then all concurrent suites together, then `solo` suites one at a time.
4. One line per suite in registration order, then failure blocks.

Scheduling flags in `scripts/suites.mjs`:

- `first: true` (only `unit`): runs alone before the concurrent suites. `unit` takes 1.3 s alone and 3.3-3.8 s beside nextest, two more Vitest runs and the Playwright pool, which is pure CPU contention; running it first brings it under its 3 s budget at no total wall-time cost ([0048](../decisions/0048-fast-tier-budgets-dev-loop-and-wire-measurements.md) §2; the budget number it needs is in 0062). ADR 0060 is the `browser` budget, not this.
- `solo: true` (`frame-bench`) and `soloTiers: ['slow']` (`rust`, `netcode`): run alone after the concurrent suites, because wall-clock gates and real-socket tests are meaningless beside a Playwright worker pool. Their fast tier stays concurrent.
- `legs`: extra runs reported on the suite's line, concurrent with the main leg; `after: true` legs start once the others finish (`browser`'s `packaging`).

Budgets apply to the fast tier only. A suite over budget prints `WARN over budget`; over 1.5x budget it FAILs (`classifyBudget` in `scripts/lib/report.mjs`). `--budget-scale n` multiplies budgets (CI passes 1000, so timings are recorded and never gate); `--timings-json path` writes per-suite times.

## Suites

Fast-tier budgets are in `scripts/suites.mjs` (owners: [0020](../decisions/0020-testing-strategy.md) §3, [0060](../decisions/0060-browser-fast-tier-budget-60s.md)). The whole fast tier is about 70 s with the build, accepted by Tyler (2026-10-10, [0060](../decisions/0060-browser-fast-tier-budget-60s.md)); the earlier target was under 1 minute. Move past 70 s only with Tyler.

| Suite | Runner | Budget | Holds |
|---|---|---|---|
| `rust` | cargo-nextest | 10 s | Unit tests of the crates; golden-hash scenarios and log replay (`crates/engine/tests/main/`, `golden/`); the `no_alloc_*.rs` zero-allocation tests; `games/reference/sim/tests`. Slow: release-profile benches (`slow_tick_large_save`, `slow_worldgen_chunk_reference`) |
| `unit` | Vitest | 3 s | Pure TS in `packages/*/src`, `games/*/src`, `scripts/**/*.test.mjs`, gc analysis logic. Runs `first` |
| `wasm` | Vitest + a `bun` script leg | 7 s | The built `.wasm` through the server entrypoint under Node (`packages/engine/tests/wasm/`): ABI, import allowlist and target features, loader, golden replays, persistence, packaging/plugin builds. The Bun leg (`bun-leg.mjs`) re-runs the golden and adapter tests |
| `netcode` | Vitest | 10 s | Real server entrypoint + real `.wasm` + K `HeadlessClient`s over in-memory `Connection`s behind a seeded conditioner on a virtual clock (`packages/engine/tests/netcode/CLAUDE.md`, [0020](../decisions/0020-testing-strategy.md) §7), plus `games/reference/tests/netcode`. Slow tier runs `--no-file-parallelism` (real sockets, soaks) |
| `browser` | Playwright, 5 workers ([0031](../decisions/0031-browser-suite-five-workers.md)) | 60 s | Projects `chromium`, `gc`, `reference`, `gc-reference` in the fast tier (specs in `packages/engine/tests/browser/`, `games/reference/tests/`): wiring, workers/SAB, readbacks, zero-GC. Slow tier adds an `engines` leg (`webkit`, `firefox`, `@engines` specs) and a `packaging` leg |
| `frame-bench` | Playwright | none (slow only) | `bench.frame_worstcase` and `bench.frame_reference`, real-rAF frame times; `solo`. `pnpm bench:frame` runs both (`**/frame-bench*.spec.ts`) |

Rendering is verified without golden images: DrawList bytes are hashed on the CPU, and `*-readback.spec.ts` render offscreen and assert individual pixels (`expectPixel`). `adapter.info` is asserted and a null adapter fails, never skips.

Rebuild budget: at most 45 s from a one-line Rust edit to tests starting, for any crate (Tyler, 2026-10-01, raised from 30 s instead of splitting the engine crate; [0049](../decisions/0049-compile-budget-45s.md)). `pnpm measure:rebuild` measures it and flags a median over 45 s. Cold builds are outside every budget.

### `split-debuginfo = "packed"`

Set in `[profile.dev]` of the root `Cargo.toml` next to `debug = "line-tables-only"`. macOS's default `unpacked` keeps every `.rcgu.o` beside the binaries (thousands per engine edit); each freshly linked test binary then took 0.5-0.9 s to first launch instead of 0.16 s and the rebuild drifted from 38 s past 60 s. `"off"` is flat but drops file:line from native backtrace frames; `"packed"` is flat and keeps them. Decided in [0048](../decisions/0048-fast-tier-budgets-dev-loop-and-wire-measurements.md) §3 (amending [0045](../decisions/0045-build-profiles-measured.md) §3), which is what [0049](../decisions/0049-compile-budget-45s.md)'s 45 s is measured on. A second, unrelated slowdown is a stale `target/` carrying the `com.apple.provenance` xattr ([0068](../decisions/0068-phase-3-decisions-testing-and-tooling.md) §7): `command mv -f target target-old` outside the repo and rebuild cold. Do not leave `target-*` directories inside the repo: `context-artifacts.test.mjs` fails with `ENOBUFS`.

## Determinism checks

[0002](../decisions/0002-determinism-same-wasm-everywhere.md) makes the `.wasm` run under Node authoritative. A scenario is replayed with state hashes compared at several checkpoints (the first divergent tick is reported) in:

- native nextest (`scenario_matches_golden` and the reference `golden_replay`),
- the `.wasm` under Node and Bun (`wasm` suite, including release builds and, in the slow tier, `feature-matrix`: plain, `wasm-opt`, `+simd128`),
- a worker in Chromium, WebKit and Firefox (`determinism.spec.ts`, `@engines`; the fast tier runs only Chromium, the engines leg runs all three; Firefox and WebKit need no GPU for a sim hash).

CI on x86-64 matched the Apple-silicon goldens in every runtime ([0068](../decisions/0068-phase-3-decisions-testing-and-tooling.md) §1). A mismatch is a finding against 0002: report the first divergent checkpoint and write an ADR before touching a golden. `scripts/lib/no-usize.test.mjs` forbids `usize`/`isize` in hashed or serialized state.

### Goldens

- `pnpm golden [fixture]` is the only writer of `packages/engine/fixtures/<name>/golden/golden.json` (beside a checked-in `scenario.json`). It rebuilds, then writes what the `.wasm` produces under Node. Review the diff: a changed golden is a changed sim; never regenerate to make a red test pass.
- `pnpm golden:bytes [-- filter]` is the only writer of the native byte-format goldens (`crates/engine/tests/golden/*.hex|.hash`, via `GOLDEN_BLESS=1`).
- `pnpm --filter reference golden:record` regenerates the reference game's full-game golden.

## Zero GC

[0016](../decisions/0016-zero-gc-definition.md) defines it; `.claude/skills/gc-test/SKILL.md` is the procedure; `.claude/rules/hot-paths.md` is the coding rule. A page that calls `installGcPage` (`packages/engine/src/test/gc-page.ts`) and has a `gc.pages.<id>` entry in `packages/engine/budgets.json` gets a generated suite (`tests/browser/gc/suite.ts`, `zeroGcSuite`) in the `gc` project: per isolate, zero Minor/Major GC trace events in a stepped window and sampled allocation bytes within the budget, plus unchanged WASM memory. Negative controls (`object`, `burst`, `post-message`) must fail on the named isolate and nowhere else, which proves the instrument is live. Budgets by isolate class: strict workers 8 B/frame; the render thread carries WebGPU's ~110 B/frame wrapper floor; the net worker is at most 1 KB per message with zero major GCs (Tyler, 2026-09-19). Every page's budget is `ceil(measured clean) + 8 B`. Raising a number in `budgets.json` is a reviewed change. Only `gc-loop` keeps `burst` controls in the fast tier; other pages' are `@slow` ([0026](../decisions/0026-zero-gc-burst-controls-in-slow-tier.md)). Modes the runner never runs: `pnpm gc [software|flat|reliability]`. CI sets `GC_MODE=software` (SwiftShader) and 2 gc workers. Rust-side steady-state allocation is asserted natively by `crates/engine/tests/no_alloc_*.rs`.

`budgets.json` also holds `counters` (exact per-client bytes and messages, draw calls, upload bytes), `size` (release `game.wasm` brotli warn 1 MB / fail 2 MB; engine JS brotli ceiling), and `mem`.

## Benchmarks and baselines

Wall-clock benchmarks are slow-tier only and call `gate(name, sample)` from `scripts/lib/bench-gate.mjs`. Baselines are `packages/engine/baselines/{tick,tick-node,worldgen,frame,frame-reference}.json`, each with a machine `fingerprint` (`os.cpus()[0].model` + `os.arch()`), `gated` metrics, absolute `limits` (the proxies of 0010 and 0018) and `conditions`.

- The 25 % rule (`TOLERANCE = 0.25`, [0020](../decisions/0020-testing-strategy.md) §9) fails a gated metric only when the running machine's fingerprint equals the baseline's (Tyler's M3 Max). Elsewhere (CI, another Mac) nothing fails; the sample is recorded to `test-results/<suite>/bench/<name>.json`.
- It also needs the metric to exceed the baseline by more than the baseline's `minDeltaMs` ([0047](../decisions/0047-bench-gate-absolute-floor.md); derived as twice the spread over 10+ runs, only `frame-reference` sets one, 0.1 ms). A `limits` figure fails on its own.
- `tick-node` is warn-only. A baseline is rewritten only by `pnpm bench:baseline <name>` (promotes the newest record from this machine; fill `conditions` by hand; review the diff), for a reviewed expected cost. A miss is diagnosed with `.claude/skills/profile-frame/SKILL.md`, never fixed by moving a baseline, limit or workload. Check `uptime` first: the machine is shared.
- Tick time desktop proxy 3 ms median on the standard large save ([0010](../decisions/0010-rates-and-subscriptions.md); the save is defined in 0020 §9).

## Lint and the commit gate

`pnpm lint` (`scripts/lint.mjs`) runs four checks in parallel, quiet on success, each printing its fix command: `biome check .`, `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `pnpm -r run typecheck` (a package opts in with a `typecheck` script). `pnpm format` is `biome check --write . && cargo fmt`.

`.claude/hooks/pre-commit-check.sh` is a PreToolUse hook (`.claude/settings.json`, `if: Bash(git commit *)`) that runs Biome and rustfmt on the working tree (not the index) and blocks the commit with exit 2 and the fix command. It needs no compile and exits silently for anything that is not a commit. Run `pnpm format` before committing. Tested by `scripts/lib/pre-commit-check.test.mjs`.

## CI

`.github/workflows/ci.yml`: one job on `ubuntu-latest` for pushes to `main` and pull requests; a newer push cancels the older run. It asserts x86_64, installs pinned Rust (`rust-toolchain.toml`), nextest, Bun, Deno, binaryen (`wasm-opt`, SHA-256 checked), Vulkan packages and the three Playwright browsers, then `pnpm lint`, `pnpm test`, `pnpm test:slow`, both with `--budget-scale 1000`, `ENGINE_GPU=swiftshader` and `GC_MODE=software`, and `--timings-json`. The slow step sets `REQUIRE_DENO` and `REQUIRE_WASM_OPT` so a missing tool fails instead of warning. `test-results/` is uploaded always and a timings table goes to the step summary. Local macOS SwiftShader cannot present a canvas, so some canvas tests are red locally and green in CI; fix pages, not the runner ([0068](../decisions/0068-phase-3-decisions-testing-and-tooling.md) §5). Read red CI runs by rerunning once, then `gh run download`; known intermittents are listed in 0068 §6.

## Manual device checks

What automation cannot prove (iOS frame pacing, gestures, OPFS, backgrounding, reconnect, hosted COOP/COEP, memory) lives in `.claude/skills/device-check/SKILL.md`: every on-hardware item (iPhone 12 Safari is the pass/fail device; Pixel 5 Chrome is evidence only; desktop Safari and Firefox) with page, steps, pass criteria and failure handling. `pnpm device:serve [--tunnel]` (`packages/engine/scripts/device-serve.mjs`) serves the fixture app over a secure context for a phone; a `http://<LAN IP>` URL never works. iOS frame pacing is judged only from driverless runs ([0056](../decisions/0056-ios-pacing-and-tick-bar.md)). A failed check becomes a fix or a plan change; never retry it into a pass.

## Repo-structure tests (`scripts/lib/*.test.mjs`, `unit` suite)

Tests that guard repository shape rather than behaviour: `context-artifacts` (every `CLAUDE.md` within 60 lines; each `.claude/rules/*` has `paths:` globs matching a file and is named in root `CLAUDE.md`; skills and agents have required frontmatter), `repo-config` (literal values fixed by ADRs), `crate-policy` (engine crate dependency policy, [0017](../decisions/0017-packaging-and-build.md) §7), `no-usize`, `no-module-mocks`, `engine-test-binary-layout` (no new top-level `crates/engine/tests/*.rs`: each is a linked binary paying macOS's first-launch tax), `game-sync-surface` (a game defines no delta, prediction or interpolation code), `build-game-bindings-scope`, `env`, `build-steps-tier`, `pre-commit-check`, plus tests of the runner itself (`args`, `report`, `timings`, `bench-gate`, `adapters`, `runner-control`). A new context file, rule or skill needs no test of its own; this suite checks it.

## Other scripts

`pnpm test:timings` (`scripts/test-timings.mjs`) runs the fast tier K times and reports per-suite wall time and tests over the p95 limit. `scripts/repeat.mjs` repeats a suite, optionally under `--load`, to reproduce flakes. `scripts/build-game-sims-dev.mjs` is the `game-sims` build step. `packages/engine/scripts/profile-frame.mjs` is the script behind the `profile-frame` skill.
