# M10: CI workflow on `ubuntu-latest` with SwiftShader (spike B)

Status: not started · After: 09 · Tyler-dependent: Q8, CI trigger policy and Actions minutes (unanswered; default assumed: every push to `main` and every pull request, superseded runs cancelled, both tiers)

## Goal
One GitHub Actions workflow runs `pnpm lint`, `pnpm test` and `pnpm test:slow` on a stock `ubuntu-latest` runner with Chromium's WebGPU on SwiftShader. It closes three deferred measurements: spike B (does the flag set of 0020 §6 give an adapter on a runner, and does it agree with Metal within tolerance), determinism on real x86-64 hardware (0002), and the software-adapter numbers of GC assertion B (0016). Timings are recorded on every run and never gate.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` (§6, §10, Consequences: spike B)
3. `docs/decisions/0016-zero-gc-definition.md` (§3 caveat b, Consequences: software-adapter form)
4. `docs/plan/04-zero-gc-harness.md` (Seams; "Software-adapter form of B")

Cited below, open only if needed: 0002 §2 NaN row and Consequences. The GPU tests this milestone must make pass on a software adapter are whatever M09 landed: list them with `grep -rl "expectAdapter\|readback" packages/engine/tests/browser`.
Mine from spikes: `spikes/zero-gc-webgpu/RESULT.md` (SwiftShader caveat: 58 ms/frame, N = 100, frame function bytes unchanged; knobs `CHANNEL=shell ALLOW_FALLBACK=1 FRAMES=100`), `spikes/determinism-hash/docker-native.sh` and `docker-node-amd64.sh` (what the emulated x86 run did, for comparison). Rules that apply: none.

## Scope
- `.github/workflows/ci.yml`.
- `ENGINE_GPU=swiftshader` switch in `packages/engine/playwright.config.ts` adding the flags of 0020 §6; adapter class recorded by every GPU test.
- Budgets do not gate in CI (M01's `--budget-scale`); a new runner flag records timings as artefact and job summary.
- `budgets.json` `software` blocks for every zero-GC page that has WebGPU; per-adapter-class readback goldens only if needed (0020 §6 last sentence).
- The Linux results for items first exercised here: recursive `fs.watch` (M02b), Linux WebKit and headless Firefox determinism (0020 §5), `bun` leg.
- Findings written into this brief's Deviations and `docs/plan/deferred-ledger.md`.

## Non-scope
Deploys, releases, publishing. macOS or GPU runners (0020 rejects them). Wall-clock benchmarks (Tyler's Mac only, M36). sccache unless the trigger in M02 fires. Branch protection rules (Tyler's repo settings).

## Files, packages and crates touched
Repo root and `packages/engine` test config only; no engine source.
```
.github/workflows/ci.yml
packages/engine/playwright.config.ts            (ENGINE_GPU)
packages/engine/budgets.json                    (software blocks)
scripts/test.mjs, scripts/lib/report.mjs        (--timings-json)
packages/engine/src/vite.ts                     (only if recursive fs.watch fails on Linux: watchCrate fallback)
.claude/skills/run-tests/SKILL.md               (CI section)
```

## Seams
**Provides:**
- Env `ENGINE_GPU=swiftshader`: Chromium projects add the 0020 §6 SwiftShader flags; `zeroGcSuite` and readback helpers accept `isFallbackAdapter: true` only under this env and fail on a null adapter always.
- Runner flag `--timings-json <path>`: writes `{ suite, ms, budgetMs, tests }[]` plus build ms, CPU model and commit. CI calls `pnpm test --budget-scale 1000 --timings-json test-results/timings.json` (`--budget-scale` is M01's; with it no suite can fail on time, 0020 §10), and the same for `pnpm test:slow`; the unscaled budgets are what the summary table shows.
- `GC_MODE=software` is set by the workflow (mechanism from M04).
- The workflow as the place later milestones add nothing to: any test in the two tiers runs in CI by default. A test that cannot run on a software adapter is tagged `@gpu-local` and excluded in CI by grep; the tag needs a sentence in the test saying why.

**Consumes:** M01: `pnpm test`, `pnpm test:slow`, `pnpm lint`, `--budget-scale`, `scripts/test.mjs`, `TOOLS` pins. M02: goldens, Bun leg, the sccache trigger. M02b: `watchCrate`. M03: projects `chromium`/`webkit`/`firefox`, `@engines`, adapter `warnings`. M04: `GC_MODE=software`, `budgets.json` `software` blocks, `attributionRoots`, `pnpm gc reliability`. M09: its readback scenes, pixel probes, goldens, and its zero-GC page.

## Planning decisions
**Workflow shape.** One job, `ubuntu-latest`, triggers `push` (branch `main` only: there are no other branches, 0025 §4) and `pull_request`, `concurrency` group per ref with `cancel-in-progress` (a newer push to `main` cancels the run of the older one; only the tip needs to be green). Steps in order: checkout; assert `uname -m` is `x86_64` and print the CPU model (the x86-64 evidence); pnpm via `packageManager` and Node from `.node-version`; Rust from `rust-toolchain.toml` (`rustup show`); `Swatinem/rust-cache`; `cargo-nextest` and Bun at the pins of 0017 §10 through version-pinned install actions; `apt-get install libvulkan1 mesa-vulkan-drivers`; Playwright browser cache keyed on the Playwright version, then `playwright install --with-deps chromium webkit firefox`; `pnpm install --frozen-lockfile`; `pnpm lint`; `pnpm test`; `pnpm test:slow`; upload `test-results/` always; append the timings table to `$GITHUB_STEP_SUMMARY`. Env for the test steps: `CI=true ENGINE_GPU=swiftshader GC_MODE=software`; cargo-nextest comes from a prebuilt-binary install action at the pin (M01 decision (c)). Third-party actions are pinned by commit SHA.

**Spike B procedure and what counts as done.** Record, in Deviations: the apt packages actually needed; whether new headless (`channel: 'chromium'`) returns a SwiftShader adapter or only the old headless shell does (spike A saw SwiftShader locally under the old shell); `adapter.info`; install time cold and cached; ms per frame on M09's scenes; probe results and golden diffs against the Metal goldens. Done = every M09 GPU test passes on the runner with semantic probes green. Golden mismatch beyond the tolerance of 0020 §6 with probes green → add a per-adapter-class golden (`<scene>.swiftshader.png`), never widen tolerance.

**Fallbacks if SwiftShader fails (0020 Consequences, risk 6), in order, each time-boxed to about an hour:** (1) old headless shell channel for the Chromium projects in CI only; (2) flag variations from the Chrome WebGPU testing post cited in 0020; (3) Dawn node bindings for the readback scenes only, in CI only, behind the same scene descriptions (needs a new ADR: it adds a dev dependency and a second GPU stack); (4) GPU tests local-only: tag them `@gpu-local`, CI runs everything else, and because CI on a software adapter is a Requirement (`docs/spec/testing.md`), this outcome is a question to Tyler, not a silent plan edit. Whatever happens, non-GPU suites, the sim hash in three browsers and the no-WebGPU `gc-loop` page run in CI.

**Software-adapter form of assertion B: numbers (0016 deferred).** For each zero-GC page with WebGPU (first: M09's), measure on the runner with `pnpm gc reliability` semantics: choose `software.frames` so the page's window finishes under the browser p95 rule of 0020 §4 (start at 100, the spike's value), confirm `attributedBytesPerFrame` for each isolate is the same exact constant as on Metal (the spike's frame function was), and write that constant plus the margin of 0016 §1 into `software.isolates`. If the M09 scene is too slow even at small N, give the page a trivial-scene query option rather than dropping the test (0016 caveat b allows either). Negative controls must still trip on the named isolate in software mode; if the `burst` controls no longer produce a GC event within the smaller window, assert them on B only in software mode and say so in `budgets.json`'s `formula` text.

**Determinism on real x86-64 (0002 deferred).** Closed when one run shows `scenario_matches_golden` (native x86-64), `determinism: node matches golden`, the Bun leg, and `determinism.spec.ts` in Chromium, Linux WebKit and Firefox all green against the goldens generated on Apple silicon. Record the run URL and CPU model in `docs/plan/deferred-ledger.md`. A mismatch is a finding against 0002, not a CI problem: stop, report the first divergent checkpoint, and write an ADR before changing any golden. Physical phones stay with the device checklist (M03's page).

**Timings recorded, not gating (0020 §10).** `--budget-scale` + `--timings-json`; the summary shows suite ms against the Mac budgets so drift is visible. Build time cold and with `rust-cache` is recorded too; above 5 minutes cached, apply M02's sccache trigger.

**Pushing.** `git push` is outside the allowlist (0021 §7), so each push asks Tyler, and the implementer never pushes (`.claude/agents/milestone-implementer.md`): wherever a step needs a CI run it commits, stops and reports; the orchestrator pushes `main` and hands back the run's result. This milestone is the one exception to "push only `done` commits" (0025 §4), because bringing CI up is its purpose; from its `done` commit on, only `M<NN> done` commits are pushed, so every CI run is of a tree that was green locally. Batch: get the workflow green in as few pushes as possible; use `gh run watch` and `gh run view --log-failed` to read results; download `test-results` with `gh run download` instead of re-running to look.

## Order of work
1. `--timings-json`; `ENGINE_GPU` in the Playwright config; try `ENGINE_GPU=swiftshader` locally once (expect the spike's fallback adapter under the old shell; this only checks wiring).
2. `ci.yml` without the slow tier; first push; fix environment failures (packages, browsers, Bun, nextest).
3. Spike B loop on the GPU tests; fallbacks if needed.
4. Software numbers into `budgets.json`; negative controls on the runner.
5. Add `pnpm test:slow`; check the Linux-first items (watcher test, WebKit/Firefox determinism).
6. Ledger, Deviations, skill update.

## Tests added
None of its own beyond a `unit` test beside the runner (`runner: timings json shape`). Its product is the existing suites green on Linux x86-64 and the `software` budget entries.

## Exit criteria
- [ ] A workflow run on `ubuntu-latest` is green for `pnpm lint`, `pnpm test`, `pnpm test:slow`; its URL is in Deviations.
- [ ] That run's log shows `x86_64`, a non-null adapter with its `adapter.info` on every GPU test, and all determinism tests passing against unchanged goldens; `docs/plan/deferred-ledger.md` marks "determinism on real x86-64" and "spike B" closed with the URL.
- [ ] Every zero-GC page with WebGPU has a non-null `software` block, and clean + negative controls pass on the runner in `GC_MODE=software`. (If fallback 4 was taken: this criterion is replaced by the recorded question to Tyler and the `@gpu-local` list.)
- [ ] `test-results/timings.json` is uploaded and the job summary shows the table; a deliberately slow suite does not fail the job (checked once with a sleep, then reverted).
- [ ] `plugin-dev: touch triggers rebuild and full-reload` passes on Linux, or `watchCrate` has the per-directory fallback and passes.
- [ ] Spike B findings (packages, headless mode, ms/frame, Metal agreement, install times) are under Deviations.
- [ ] `pnpm test` and `pnpm lint` are green locally as well.

## Verification commands
`gh run watch` · `gh run view <id> --log-failed` · `gh run download <id> -n test-results` · locally: `pnpm test --budget-scale 1000 --timings-json test-results/timings.json` · `pnpm test` · `pnpm lint`

## Budgets
None gate here. Recorded: every suite against the Test suite row of `PRE-PLAN.md` §7, cold and cached build time against the Dev loop row, SwiftShader ms per frame on M09's scenes (input to risk 6).

## Context artifacts
`.claude/skills/run-tests/SKILL.md`: a CI section (env switches, reading a failed run with `gh`, `@gpu-local`, where per-adapter goldens live). No new skill.

## Manual device checks
None.

## Deviations
(filled in during Phase 3)
