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

**Both tiers are load-bearing, not belt-and-braces (M09 Deviations "Gate round 3", ADR 0026).** Since M09's gate, `pnpm test browser` selects only the `chromium` and `gc` Playwright projects (`--project chromium --project gc`); three-browser determinism moved to a new `engines` leg (`--project webkit --project firefox`, tag `@engines`/`@webkit-gpu`, its own `vite preview` on port 4518 via `ENGINE_TEST_PORT`) that `onlyTier: 'slow'` restricts to `pnpm test:slow`, and every production-topology page's `burst` negative control is tagged `@slow` and demoted the same way (`gc-loop` excepted; ADR 0026). Concretely: `pnpm test` alone no longer runs WebKit/Firefox determinism or any `burst` control but `gc-loop`'s — this milestone's own exit criteria ("all determinism tests passing", "clean + negative controls pass … in `GC_MODE=software`") are unreachable from `pnpm test` alone and depend on the workflow's existing `pnpm test:slow` step (Planning decisions "Workflow shape" above). Do not read this milestone as done from a `pnpm test`-only green run. `ABI_VERSION` is 5 and `uploadRing.slotBytes` is 4120 as of M09; a software-adapter golden mismatch traced to either number is a real regression, not a tolerance question.

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

### Spike B: answered (2026-09-21)

**Headline result.** Run [35611003598](https://github.com/tylerschloesser/engine-v2/actions/runs/35611003598)
(commit `edb93b5`): every non-`[gc]` `browser` test passed on `ubuntu-latest` under SwiftShader,
including every M09 readback scene, semantic pixel probe and `device.html` check, **with no golden
mismatch at all** against the goldens generated on Apple silicon (0020 §6's tolerance was never
even approached). **No per-adapter-class golden is needed.** `rust` 145, `unit` 139, `wasm` 35
(including the Bun leg) also green on the runner — real x86-64 evidence for the "determinism on
real x86-64" deferred-ledger item (not yet marked closed there: that's this milestone's own
exit-criterion checkbox, not touched here). Cold job wall time: 4 m 3 s (env bring-up through
`pnpm lint`, before `pnpm test` even starts driving the browser suite).

**The negative finding, kept beside it.** `channel: 'chromium'` (Playwright's "new headless mode")
plus the 0020 §6 SwiftShader flags returned a **null** adapter on this runner
(run [35609763337](https://github.com/tylerschloesser/engine-v2/actions/runs/35609763337)):
`navigator.gpu.requestAdapter()` resolved `null`, surfaced as an uncaught page error from
`device.html`'s `checkSupport()` (`canvas: presents`, `frame-loop: production runs phases in
order`). Fix (fallback rung 1, applied and verified working in the very next run): `channel:
'chromium-headless-shell'` under `ENGINE_GPU=swiftshader` only (`packages/engine/
playwright.config.ts`'s `chromiumChannel`, `chromium` and `gc` projects; unset locally). Verified
against the pinned `playwright-core@1.63.0` itself, not recalled: its `LaunchOptions.channel` doc
comment says `"chromium"` opts into new headless mode; `chromium-headless-shell` is a *separate*,
non-aliased executable (`lib/coreBundle.js`'s `chromiumAliases = ['chrome-for-testing']` does not
include it, so `registry.getExecutableName` passes it straight through as its own binary name), and
a bare `playwright install chromium` already installs both (`registry.resolveBrowsers`'s `chromium`
branch installs `chromium` and `chromium-headless-shell` unless `--only-shell`/`--no-shell` is
passed — `ci.yml` passes neither, so no workflow change was needed for this fix). Matches
`spikes/zero-gc-webgpu/playwright.config.mjs`'s own local finding (`RESULT.md`): the headless-shell
binary has no real-GPU path at all and falls back to SwiftShader (`vendor: google, architecture:
swiftshader, isFallbackAdapter: true`, that spike's own local Mac reading) regardless of platform.
**Side finding, not acted on:** in the first (failing) run, the `[gc]` project's `terrain`/`input`
"clean" tests got *past* device init (`initDevice()` at module top level did not throw — their only
failure was the later "no software budget" guard) using plain `channel: 'chromium'` plus
`--disable-features=SpareRendererForSitePerProcess`, which the bare `chromium` project's launch args
lacked. So the null may have been that one missing flag rather than the channel itself on this
runner; recorded because it changes the diagnosis, but the shipped fix (channel swap) is what
carries the local-shell-adapter precedent with it and needed no further guessing.

**Adapter class recorded by every GPU test (Scope).** `expectAdapter` (`tests/browser/support/
gpu.ts`) already recorded `adapter.info` as a Playwright test annotation, but nothing in the
runner's own quiet-by-default log (0020 §2) ever surfaced it — `scripts/lib/report.mjs`'s
`parsePlaywrightJson` only extracted `warnings` annotations. Added `adapters: string[]` (deduped,
first-seen order) alongside `warnings`, threaded through `scripts/lib/adapters.mjs`'s `playwright`
adapter (no change needed there: it already returns whatever `parsePlaywrightJson` returns) and
`scripts/test.mjs` (`formatAdapter`, printed the same way `formatWarning` already is, deduped again
across a suite's legs). Verified locally: `pnpm test` now prints `  adapter
{"vendor":"apple","architecture":"metal-3",...}` under the `browser` line. Two existing unit tests'
`toEqual` expectations updated for the new `adapters: []` field (`report.test.mjs`'s "passing
report", `adapters.test.mjs`'s empty-report case) plus two new tests (`adapter.info` dedup order,
`formatAdapter`'s own shape) — not a weakening, the shape gained a field. **Gap, not closed here:**
`gc/suite.ts`'s `assertEnvironment` (the `zeroGcSuite`-generated tests, as opposed to
`terrain-readback.spec.ts`'s hand-written ones) asserts `r.adapter` is non-null under
`expectAdapter: true` but never pushes an `adapter.info` annotation the way `tests/browser/support/
gpu.ts`'s `expectAdapter` does — so once `terrain`/`input`'s `gc` clean/negative tests run for real
(blocked on the finding below), their own adapter won't show up in this log without also wiring
that annotation into `gc/suite.ts`. Flagged, not fixed, since it touches the same file the finding
below is about and I was told to stop there.

### (a) `gc-loop`'s software-mode negative controls: an instrument finding, not a budget one

Reproduced locally (hardware Chromium; the mechanism does not depend on the GPU or the platform —
same V8, same pinned Chromium build) and fully quantified, per the request to test "no samples" vs
"wrong root name" and report the numbers rather than guess:

- **`GC_MODE=software pnpm gc software -t "gc-loop neg burst sim"`**: `bytesPerFrame.sim` 40,000.75
  (24,000,448 B / 600, the lower of the two 0028 windows), `attributedBytesPerFrame.sim` **0**.
  A temporary debug dump of the raw `HeapProfiler.stopSampling` payload (added, used once, fully
  reverted — `git diff --exit-code` confirmed clean afterward) shows **300,018 real samples** in
  that window, total sampled bytes 24,000,564, **79.997 B/sample** on average — conclusively *not*
  "the profiler collected no samples for that isolate": the guess in the delegation prompt is
  refuted by the data. `neg object sim` the same way: 618 samples, 10,160 B total, 16.44 B/sample
  average (matches the control's own 16 B object).
- **The honest answer is "wrong root", and it is exact, not approximate.** The dumped call tree's
  `allocateBurst` node has ancestor chain `(root) -> scope.onmessage -> armedLoop -> runOp ->
  allocateBurst`, `selfSize` 24,000,020 — essentially the whole total. `coreTick` (`gc-loop`'s own
  `attributionRoots` value for every worker isolate) **does not appear anywhere in this profile's
  tree**: `src/test/harness-worker.ts`'s `runOp` calls `coreTick()` and, as a **separate, sibling**
  statement, `applyStepControl(...)` (where `allocateObject`/`allocateBurst` live) --
  `coreTick`'s own return ends its subtree before the control ever runs, and `coreTick` itself
  allocates so little (2.5-3.85 B/frame, 0016 §1's own strict-worker reading) that no sample landed
  on its own frame in this window at all, so `attributedBytes(profile, ['coreTick'])` -- "inclusive
  bytes under a node named in `roots`" -- correctly computes exactly 0 by its own definition. This
  is not a bug in `attributedBytes`; it is `runOp`'s control hook sitting structurally outside the
  named root's subtree.
- **This does not generalise to "attribution cannot work in software mode."** Checked directly
  (temporary local edit to `budgets.json`'s `topology` entry, reverted, `git diff --exit-code`
  clean): production-topology pages' worker isolates use `attributionRoots: ["body"]`, and
  `src/worker/{client,gen,sim}.ts`'s `body()` calls `applyGcHook(shell.control, shell.index)` (the
  production negative-control hook, `src/worker/gc-hook.ts`) as **its own first statement** --
  nested *inside* the root, not a sibling of it. `topology neg object client` measured
  `attributedBytesPerFrame.client` **non-zero** with `applyGcHook`'s own samples present in `byFn`,
  proving the mechanism correctly discovers the control there. So the narrow mechanical cause is
  specific to `gc-loop`'s own test-only `harness-worker.ts` (`coreTick`/`applyStepControl` as
  siblings inside `runOp`), which no other page's worker isolates share.
- **But a second, more troubling instance turned up while checking that**, on `main` this time, not
  a worker, and on every page checked (not just `gc-loop`): with real `software.frames: 600` clean
  baselines measured and `ceil(measured) + 8` software budgets set (locally only, `topology`/`echo`/
  `gen`/`terrain`/`input`; **not committed** -- reverted, `git diff --exit-code` clean), **`neg
  object main` failed to trip on every one of the five production-topology pages**, reading
  identical to its own clean baseline (12, 0, 12, 80.02, 160.17333... respectively, unchanged with
  or without the control). Cause: `src/test/gc-page.ts`'s `run()` applies `main`'s own control
  (`allocateObject(f)`/`allocateBurst(f)`) as a call **sibling to `drive(f)`** inside `run`'s own
  loop body, not nested inside `drive`; every one of these five pages' `attributionRoots` for `main`
  names `drive` (or, for `topology`, the still-narrower `["stepFrame", "stepTick"]`), never `run`
  itself. `gc-loop`'s own `main` control trips correctly in software mode *only* because `gc-loop`'s
  own `attributionRoots` for `main` happens to be `["run"]` -- the one root wide enough to contain
  everything, main control included -- not because its mechanism differs.
- **A third instance, on the very `topology client` case just used as the reassuring counter-example
  above, at closer inspection (`--repeat-each 5`, worker budget the established fixed-8
  convention, not the earlier 1,000,000 placeholder that made anything "pass" trivially):** the
  control's own contribution measured **0.027 B/frame attributed** (16 B/frame expected, `applyGcHook`'s
  own `byFn` self-size total in that run: 9,616 B) -- non-zero, so the control *is* discovered some
  of the time, but at roughly 1/600th the expected size: almost all of `applyGcHook`'s own samples
  landed on a call-tree node **not** named `body`, most plausibly V8 inlining `body()` into its own
  caller for most, but not all, of its ~600 real invocations across the window -- the same "which
  frame happens to be executing" arbitrariness 0028 already documented for the JIT-tier
  code-installation burst, here affecting whether the *root function itself* survives as a
  distinguishable tree node at all, not just where a one-off burst gets billed.
- **Conclusion, stated plainly, per the instruction to stop rather than paper over an ADR-sized
  finding:** the honest answer is not "attribution cannot work in software mode" as a blanket
  claim -- clean-run baselines measure real, stable, repeatable numbers (topology/gen: 12.000 B/frame
  main, exactly, across 5 repeats; terrain: 80.02; input: 160.17333...; echo: 0 -- every one bit-
  identical across 5 repeats), and A (the GC-event assertion) is untouched by any of this. But
  **assertion B's software-mode negative controls cannot currently be trusted to trip reliably**,
  for two independent, now-quantified reasons: (1) the control hook's call site does not always sit
  inside the isolate's own named attribution root (`gc-loop`'s worker isolates, and `main` on every
  page whose root is narrower than `run`), and (2) even where it does, V8's own inlining behaviour
  can drop the root function's own call-tree node most of the time, at a rate this session did not
  fully characterise (one page, one control, one measurement). Neither is a "no samples" problem
  (refuted with exact numbers above), and neither is fixed by choosing different `software.frames`
  or a trivial scene. **This is the orchestrator's decision, not mine** -- candidate fixes exist and
  are cheap to describe (widen every page's `attributionRoots` to the function that actually
  encloses both the real per-frame/tick work *and* the control hook, e.g. `runOp` for `gc-loop`'s
  workers, `run` for every page's `main`; or restructure hook placement to nest under the existing
  root) but changing them is exactly "asserting the controls on B only" territory if done without
  understanding the inlining risk on top, so none were applied.

### (b) The 22 `no software budget` pages: blocked on (a), not attempted further

**Not written to `budgets.json`.** Real `software.frames: 600` clean baselines *were* measured
locally for `topology`/`echo`/`gen`/`terrain`/`input` (see numbers above) and are stable, but
writing final `software` blocks now would commit the same undiscovered defect (a) found on `main`
into five more pages' negative controls, silently, since a `clean` test alone cannot tell the
difference between "no control ever fires here" and "the control fires but isn't attributed" --
exactly the trap (a) exists to name. Reverted; `packages/engine/budgets.json` is byte-identical to
`edb93b5`'s (`git diff --exit-code` confirmed after every local experiment in this round).

**`software.frames` arithmetic, since it was asked for even though the numbers above aren't
committed.** `tests/browser/gc/instrument.ts`'s `WARMUP` (8,000 frames, `WARMUP_PASSES = 8`) is a
**fixed global constant, not mode-dependent** -- every `clean`/`neg` test, hardware or software,
drives 8,000 real per-frame `drive()` calls (a real WebGPU draw + upload drain, for `terrain`/
`input`) before any measured window starts, and 0028's two-window rule then drives `2 x
software.frames` more. So `software.frames`'s own value is the *second* term, not the dominant one
-- shrinking it from the brief's suggested starting point of 100 barely moves total wall time.
**Real evidence this is affordable, not the spike's 58 ms/frame:** run 35611003598's own
`terrain: upload budget while panning` (`terrain-readback.spec.ts`, 600 real stepped, panning,
drawing frames via `panAndDrive`, the closest real proxy this run has to `gc-terrain`'s own
`drive()`) took **917 ms total on this runner -- about 1.53 ms/frame**, not the spike's 58 ms/frame
(that figure was a deliberately worst-case 4096-quad 256x256 stress scene, never representative of
`terrain`'s actual one-triangle-into-64x64 page). At that rate, 8,000 warm-up + 1,200 (2 x 600)
measured frames is roughly (8,000 + 1,200) x 1.53 ms ~= 14 s, comfortably inside Playwright's 30 s
per-test timeout with headroom for CDP/HeapProfiler overhead. **Not directly measured: `gc-terrain.
html`/`gc-input.html`'s own real wall time under the full instrument** (CDP attach, `HeapProfiler.
collectGarbage`, `Tracing.start`, two full sampling windows) -- the `terrain clean` test itself has
never run to completion in CI, since it fails at the software-budget guard before any of that
starts. Given the 1.53 ms/frame evidence, this session's recommendation (not applied) is
`software.frames: 600` uniformly (same as hardware `FRAMES`, no shrinking, no trivial-scene
workaround) for every page, GPU or not -- 0016 caveat b's trivial-scene escape hatch does not look
needed, but this is a recommendation from a proxy measurement, not the pages' own confirmed number.

**Decisions needed (all four, all mine per the delegation, none decided here):**
1. Whether (a)'s attribution-root gap is fixed by widening `attributionRoots` (which function(s), per
   page), by restructuring where a control hook fires, or some other way -- and whether it needs a
   new ADR (it amends how 0016 caveat b's software-mode mechanism is read) or just a Deviations-level
   correction once decided.
2. Whether V8 inlining's effect on root-node survival (the `topology client` 0.027-vs-16 finding)
   needs its own investigation before any software-mode negative control can be trusted, or whether
   one data point is enough to accept the mechanism with a wider margin.
3. Whether to proceed with `software.frames: 600` uniformly once (a)/(b) unblock, given the
   1.53 ms/frame evidence above.
4. Whether `gc/suite.ts`'s `assertEnvironment` should also push an `adapter.info` annotation (the
   gap noted above), once `terrain`/`input`'s `gc` tests can run to completion.

No code outside `packages/engine/playwright.config.ts` (fallback rung 1, committed), `scripts/lib/
report.mjs`/`scripts/lib/adapters.test.mjs`/`scripts/lib/report.test.mjs`/`scripts/test.mjs`
(adapter.info logging, committed) changed in this round. `packages/engine/budgets.json` and
`packages/engine/tests/browser/gc/instrument.ts` are byte-identical to `edb93b5`'s versions --
every experiment above was local-only and reverted.
