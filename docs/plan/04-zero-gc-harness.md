# M04: Zero-allocation assertion with permanent negative controls

Status: done · After: 03 · Tyler-dependent: no (Q2 answered: the zero-GC Requirement in `docs/spec/testing.md` is amended to 0016's reading; what is built does not change)

## Goal
The assertion of 0016 §3 runs in the `browser` suite against the page that exists today: a main-thread frame loop plus one worker ticking the fixture `.wasm` in lockstep, with bytes crossing SAB ↔ WASM memory in both directions. Per isolate it asserts A (no GC trace events in the window) and B (exact sampled bytes per frame within budget), plus unchanged WASM memory size. Five permanent negative controls each fail on the named isolate and nowhere else. Budgets live in `packages/engine/budgets.json`. Later milestones add a zero-GC test for a new page with a budgets entry and a five-line spec.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0016-zero-gc-definition.md` (all)
3. `docs/decisions/0020-testing-strategy.md` (§4, §8, §9)
4. `docs/decisions/0014-js-wasm-boundary.md` (§4: views, copy in / copy out, growth)

Mine from spikes: `spikes/zero-gc-webgpu/tests/harness.mjs` (port whole: `TunnelSession`, `sumProfile`, `analyseTrace`, the `measure` sequence and its timing fields), `tests/zero-gc.spec.mjs` (the expected-verdict table), `public/worker.js` and `public/main.js` (where each control allocates, the `sink` that defeats escape analysis, the postMessage-driven variant, "await armed"), `playwright.config.mjs`, `RESULT.md` sections "Launch flags and CDP calls that worked" and "Caveats". `spikes/cross-origin-sab/src/bench.ts` (preallocated per-slot views, `wasmU8.set(slotView, off)`).
Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
- Node-side instrument `tests/browser/gc/`: CDP sessions per isolate, the measurement sequence of 0016 §3 steps 1–7, trace and profile analysis, verdict, failure output (top allocation sites; artefacts under `test-results/browser/gc/`).
- Page `gc-loop.html`: harness with one sim-role worker named `sim` on fixture `hash`; per frame main runs `stepFrame` + `stepTick`; per tick the worker copies a fixed block SAB → `Rx`, calls `sim_admit`, `sim_tick`, `sim_build_frame`, copies the fixed frame block `Tx` → SAB through view pairs created at init; main reads that block.
- Test-only allocation controls in `engine/test`.
- `packages/engine/budgets.json` + the Node helper that reads it.
- The `Tracing.start` stall warning; the software-adapter arithmetic (numbers left to M10); a second CDP transport proven by a parity test.
- `gc-test` skill; `hot-paths.md` updated with how to verify.

## Non-scope
WebGPU on the measured page (decision below; M09 adds it). The multiplayer topology and the net-worker class (M29). Overlay-anchoring line (M18). Snapshot-write-in-window question (M23). SwiftShader numbers and CI (M10). Hand runs in Safari/Firefox (device checklist, from M09).

## Files, packages and crates touched
`packages/engine` only.
```
packages/engine/budgets.json
packages/engine/src/test/{controls.ts, gc-page.ts}          (+ edits to harness.ts, harness-worker.ts, step-block.ts)
packages/engine/tests/browser/pages/{gc-loop.html, src/gc-loop.ts}
packages/engine/tests/browser/gc/{instrument.ts, sessions.ts, cdp-flat.ts, analyse.ts, suite.ts, fixtures.ts}
packages/engine/tests/browser/gc-loop.spec.ts
packages/engine/tests/browser/gc/analyse.test.ts (+ gc/data/{trace,profile}-sample.json; add this glob to the `unit` Vitest project)
scripts/gc.mjs, package.json (root: `gc`)
packages/engine/tests/support/budgets.ts
packages/engine/playwright.config.ts                        (project `gc`)
.claude/skills/gc-test/SKILL.md, .claude/rules/hot-paths.md
```

## Seams
**Provides:**
- `packages/engine/budgets.json` (0020 §9: the one budgets file; not in `files`). Shape:
  ```jsonc
  { "version": 1,
    "gc": { "pages": { "<pageId>": {
      "isolates": { "<isolateName>": {
        "class": "strict" | "budgeted",          // 0016 §1: strict = zero MinorGC and MajorGC; budgeted = zero MajorGC
        "bytesPerFrame": 8,                        // strict; "bytesPerMessage" for budgeted (M29)
        "formula": "how this number is derived",  // prose, so a reviewer can re-derive it
        "attributionRoots": ["harnessWorkerStep"]  // function names whose inclusive bytes are "the engine's frame/tick functions" (0016 caveat b)
      } },
      "software": null | { "frames": 100, "isolates": { "<isolateName>": { "attributedBytesPerFrame": 0 } } }
    } } },
    "counters": { }                                // "<area>.<name>": ceiling; later milestones add (net bytes, draw calls, upload bytes, memory high-water)
  }
  ```
  Raising any number is a reviewed change (0020 §9). Initial content: page `gc-loop`, isolates `main` and `sim`.
- `tests/support/budgets.ts`: `budget(path: string): number`, `gcPage(pageId)`, `expectWithinBudget(key: string, actual: number)`.
- `engine/test`: `installGcPage(harness, opts?: { drive?(frame: number): void }): void`, which assigns `window.__gc: GcPageApi = { ready: Promise<{ isolates: string[], crossOriginIsolated: boolean, adapter: object | null, gcExposed: Record<string, boolean> }>, run(frames: number, marked: boolean): Promise<{ frames, acks: Record<string, number>, errors: string[] }>, markIsolates(): Promise<void>, setControl(c: NegativeControl): Promise<void>, memoryBytes(): Promise<Record<string, number>> }`. `run` steps all frames in one task between `performance.mark('window-start')` / `('window-end')` when `marked`. `opts.drive` is the page's per-frame work; the default is `stepFrame(1000/60)` then `stepTick()`.
- `NegativeControl = { isolate: string, kind: 'object' | 'burst' | 'post-message' } | null` (`object` = one small retained object per frame or tick, `burst` = 2,000; `post-message` switches stepping to a message round trip per frame, as the spike's `?comm=postmessage`). The hook sits in `harnessStepFrame` (main) and `harnessWorkerStep` (workers); **M06b must carry the same hook into the production worker shell behind a test-only flag in the setup message, so every real isolate can be named by a control.**
- `tests/browser/gc/suite.ts`: **`zeroGcSuite({ pageId, path, expectAdapter?: boolean })`** generates, from the page's budgets entry: one `clean` test and, for every isolate listed, `neg object`, `neg burst`, and one `neg post-message` per main↔worker pair; each negative test passes only if the verdict differs from clean exactly on the named isolate(s) and assertion(s) (table in 0016 §3.8). **Registering a zero-GC test later = a page that calls `installGcPage`, a `gc.pages.<pageId>` entry, and a spec file calling `zeroGcSuite`.** Expected users: M09 (`terrain`, first WebGPU main budget from the formula in 0016 §1), M13, M16 (single-player topology), M18 (anchors line), M29 (multiplayer).
- `tests/browser/gc/instrument.ts`: `measure(page, browser, { pageId, control }) -> GcResult` (`bytesPerFrame`, `attributedBytesPerFrame`, `gc` counts and `byFn` per isolate name, `memoryBytes` before/after, `ms` timings, `warnings`).
- Playwright project `gc` (Chromium, the launch args of 0016 §3, runs `*.spec.ts` that import `suite.ts`); env `GC_MODE=software` and `GC_CDP=tunnel|flat`, set for local use by `pnpm gc <software|flat|reliability> [-t pattern]` (`scripts/gc.mjs`: a wrapper, so the call matches the `Bash(pnpm *)` allow rule instead of an env prefix).

**Consumes:** M03: `createHarness`, `Harness` (`resume`, `park`, `untilQuiescent`, `stepFrame`, `stepTick`, `memoryBytes`, `memGrows`), `harness-worker.ts`, `step-block.ts` (`CONTROL` word), `openPage`, the adapter's `warnings`, isolate names, `self.__engineIsolateName`. M02: `call0/1/2`, `region()`, `RegionId.Rx/Tx`, `sim_admit`, `sim_build_frame`, fixture `hash`. M02b: fixture app, `minify: false`.

## Planning decisions
**No WebGPU on this page.** The engine has no renderer until M09; a throwaway GPU scene would measure Chrome, not the engine, and PLAN.md already places the first GPU test (and therefore CI, M10) at M09. The instrument is adapter-agnostic: `ready.adapter` is recorded when a page has one, and `zeroGcSuite({ expectAdapter: true })` makes a null adapter a failure (0020 §6). Consequence: the 110 B main budget of 0016 §1 does not apply to `gc-loop`; with no WebGPU wrappers it would let the one-object control pass. `gc-loop`'s `main` number is **measured harness overhead (spike: about 36 B/frame at N = 600) + the 8 B margin**, set from 50 clean runs in this session and written with its formula. The worker number is the strict figure of 0016 §1. M09 adds the WebGPU row.

**CDP transport: both, behind one interface (0024 §12, which also owns per-page GC budgets).** 0016 §3 step 2 decides the non-flattened tunnel (`Target.sendMessageToTarget`), proven over about 970 spike runs; 0016 Consequences and `PRE-PLAN.md` risk 11 name the replacement: the harness's own CDP WebSocket with flattened sessions. `sessions.ts` defines `IsolateSession { name, send(method, params) }` with two implementations. `tunnel` is the default. `flat` (`cdp-flat.ts`) uses Node's global `WebSocket` against `--remote-debugging-port` (worker-scoped Playwright fixture launches Chromium with port `ENGINE_CDP_PORT + parallelIndex`, default base 9333; find the page target by a unique query token; `Target.attachToTarget` and `Target.setAutoAttach` with `flatten: true`; route by `sessionId`). One test, `gc: flat transport parity`, runs the clean measurement through `flat` and requires the worker's byte total to equal the tunnel's exactly. So the day a Chromium bump removes the deprecated call, the fix is flipping the default, not writing a transport under a red suite. Time-box `flat` to about an hour; if it overruns, keep the interface, record the gap under Deviations, and leave risk 11 open.

**Naming isolates.** CDP side: after auto-attach, `Runtime.evaluate('self.__engineIsolateName')` on each worker session. Trace side: before the window, with tracing on and workers parked, `__gc.markIsolates()` makes every isolate emit `performance.mark('gc-isolate:<name>')`; `analyse.ts` maps that event's `tid` to the name (main is the thread of `window-start`). With one worker this is trivial; it is built now because "fails on the named isolate only" must hold when M06b–M13 add workers.

**Sequence** (0016 §3; the extra steps are in italics): open page, await `ready` → attach sessions, *name them* → `run(warmup, false)` → `park` → `HeapProfiler.enable` + `collectGarbage` on every isolate → `Tracing.start` (*timed*) → *`markIsolates`* → `startSampling` on every isolate → `setControl` → `resume` → `run(N, true)` → `park` → `stopSampling`, `Tracing.end` → analyse. N and warm-up come from 0016 §3 (constants in `instrument.ts` citing it), except in software mode.

**`Tracing.start` stall (0016 caveat a, risk 8).** The flag is in the project's launch args. `measure` times the call; above 2 s it adds a `warning` annotation `gc-tracing-start-stall <ms>`, which M03's `playwright` adapter returns in `warnings` and the runner prints as one `warn` line. It never fails a test.

**Software-adapter form of B (0016 caveat b and deferred item).** Built here, numbered by M10. `GC_MODE=software` changes only arithmetic: N becomes `software.frames`, and B compares `attributedBytesPerFrame` (inclusive bytes under the isolate's `attributionRoots`, divided by N) with `software.isolates.<name>.attributedBytesPerFrame`; A is unchanged. A page whose `software` is `null` fails in that mode with "no software budget for <pageId>". A unit test exercises the arithmetic on canned profiles; `pnpm gc software -t gc-loop` must pass locally once this session fills `gc-loop`'s `software` block (the real adapter is irrelevant to a page without WebGPU). M10 owns the scene choice, N and numbers for pages with WebGPU (first: M09's `terrain`).

**WASM memory.** Every clean test also asserts `memoryBytes()` equal before and after the window and `memGrows()` = 0 per instance (0016 §1 last row).

**Hand-offs recorded here.** Final main-thread number: M09 (formula in 0016 §1). Overlay string constant: M18. Snapshot `write` inside or outside the strict window: M23. Net-worker `budgeted` class and `bytesPerMessage`: M29. Each adds a `gc.pages` entry, not a new instrument.

## Order of work
1. Port `analyse.ts` (`sumProfile` with inclusive attribution, `analyseTrace` with isolate names) and its unit tests on two small captured JSON samples (capture them from step 3, trim, commit).
2. `controls.ts`; extend `harness-worker.ts` with the fixed-block copy in/out and the control hook; `gc-page.ts`; `gc-loop` page.
3. `sessions.ts` (tunnel), `instrument.ts`, project `gc`; get `clean` measuring. Run it 50 times (`pnpm gc reliability`), set `budgets.json` from the numbers.
4. `suite.ts`; all negatives; confirm each fails only where named. If a control does not separate from clean by at least the margin on both sides (0016 §1 discussion), stop and fix the page, not the budget.
5. Stall warning; software mode; `cdp-flat.ts` + parity test.
6. `pnpm gc reliability` (Playwright `--repeat-each`: clean × 50, each control × 15, 4 workers; never part of `pnpm test`); record pass counts and the spread of main and worker bytes under Deviations.
7. `gc-test` skill; `hot-paths.md`.

## Tests added
- `browser` (project `gc`): `gc-loop clean`, `gc-loop neg object main`, `gc-loop neg object sim`, `gc-loop neg burst main`, `gc-loop neg burst sim`, `gc-loop neg post-message main<->sim`, `gc: flat transport parity`.
- `unit`: `gc analyse: sums selfSize exactly`, `gc analyse: inclusive attribution under roots`, `gc analyse: GC events outside the marks are ignored`, `gc analyse: events are attributed to named isolates`, `gc verdict: software mode uses attributed bytes`, `gc verdict: tracing stall is a warning` (0016 caveat a: a canned measure result whose `Tracing.start` took longer than the threshold yields a `gc-tracing-start-stall <ms>` warning and a passing verdict; one under it yields none), `budgets: every gc page lists main`.

## Exit criteria
- [x] `pnpm test browser -t gc-loop` passes: clean within budget on `main` and `sim` with zero GC events; every negative control's verdict matches 0016 §3.8 on the named isolate only.
- [x] Temporarily allocating `{}` per call inside `call0` in `src/loader.ts` makes `gc-loop clean` fail on `sim` with `call0` among the printed top allocation sites (check, then revert). This is the proof that the instrument sees engine code.
- [x] `gc: flat transport parity` passes, or the gap is recorded under Deviations with risk 11 left open.
- [x] `pnpm gc software -t "gc-loop clean"` passes.
- [x] `pnpm test unit -t "gc verdict"` runs both verdict tests and passes.
- [x] `pnpm gc reliability`: clean 50/50, each control 15/15; numbers recorded.
- [x] Added `browser` suite time recorded; the slowest `gc` test is under the browser p95 rule of 0020 §4.
- [x] `.claude/skills/gc-test/SKILL.md` exists; its commands were each run once in this session.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t gc-loop` · `pnpm test unit -t "gc analyse"` · `pnpm gc software -t "gc-loop clean"` · `pnpm gc flat -t "gc-loop clean"` · `pnpm gc reliability` · `pnpm test` · `pnpm lint`

## Budgets
- Allocation per isolate (`PRE-PLAN.md` §7, owner 0016): worker row measured by `gc-loop clean` on `sim`; main row not applicable until M09 (see decision). Zero `memory.grow`: `memGrows()` assertion.
- Test suite row: `browser` suite line; the spike's whole 8-test suite cost 2.4–2.7 s on 4 workers, so more than about 4 s added means something is wrong.

## Context artifacts
- `.claude/skills/gc-test/SKILL.md`: when to run it, `pnpm test browser -t <pageId>`, reading the failure output (which isolate, A or B, top call frames, artefact paths), the usual causes (view creation, rest arrays, closures, `postMessage`, `engine.log` in the window), how to add a page, how to change a budget (formula + reviewed change), `pnpm gc software|flat|reliability`, what a `gc-tracing-start-stall` warning means.
- `.claude/rules/hot-paths.md`: add "verified by the `gc-test` skill; a new hot path gets a page or joins one".

## Manual device checks
None.

## Deviations

No split: steps 1-7 fitted one session, though steps 3 and 4 had to be built and verified together
(the clean measurement, the `gc` project's launch config, `budgets.json`'s numbers and the
negative-control suite are circularly dependent: none of them is checkable in isolation). No
decision changed and no seam under **Provides** was renamed. Exact shapes, findings and corrections:

- **`step-block.ts` grows to six `Int32Array` slots**, not the "`CONTROL` word" the brief's Consumes
  line assumed against M03's actual five (`Req`, `Ack`, `State`, `Yield`, `Op`: M03's Deviations).
  Final layout: `Req 0`, `Ack 1`, `State 2`, `Yield 3`, `Op 4`, **`Control 5`** (a `StepControl` value
  -- `None 0`/`Object 1`/`Burst 2` -- read fresh every tick by the worker; `'post-message'` controls
  are not encoded here, they replace the SAB step protocol itself for that one worker instead).
- **`Harness` (`harness.ts`) grows six members**, all internal test-plumbing `gc-page.ts` needs and
  no spec calls directly: `workerNames: string[]`; `resume(opts?: { except?: string[] })` (arms every
  worker except the ones named, so a `post-message`-controlled worker is never put in its blocking
  `Atomics.wait` loop and can still receive a plain `postMessage`); `messageTick(worker)` (one tick
  by message round trip, valid only for a worker excluded from `resume()`); `markIsolates()` (every
  worker does `performance.mark('gc-isolate:<name>')`, reachable only while parked); `setWorkerControl
  (worker, control)` (a synchronous `Atomics.store` into the step block's `Control` word);
  `workerGcExposed()` (`typeof gc === 'function'` per worker, captured from its `ready` message at
  setup). `packages/engine/CLAUDE.md`'s documented Harness contract (the "Adding a browser spec"
  section) was not updated to list these: they are not part of the public surface a plain spec drives,
  only what `gc-page.ts` needs.
- **`HarnessWorkerSpec` grows `rxTx?: { rx: SharedArrayBuffer; tx: SharedArrayBuffer }`.**
  `harness-worker.ts`'s `coreTick()` (shared by the normal SAB `Tick` op and the new `pmTick`
  message) does the fixed-block protocol only when a worker was set up with `rxTx`: copy `rx` view ->
  `Rx` region, `sim_admit`, `sim_tick`, `sim_build_frame`, copy `Tx` region -> `tx` view -- whole
  blocks through views created once at setup, never `subarray()` (0014 §4). Without `rxTx` (M03's
  `stepping.html`) a Tick op is still a bare `sim_tick`, unchanged. `gc-loop.ts` sizes both SABs to
  64 B, matching fixture `hash`'s fixed `Rx`/`Tx` region sizes (`fixtures/hash/src/lib.rs`).
- **Two real allocation bugs found by the first clean measurement, not assumed from the spike** (this
  is the strongest evidence the instrument works on real engine code, alongside the exit-criterion-2
  check below):
  - `harness.ts`'s `byRole` was `all().filter((h) => h.role === role)` -- two fresh arrays every
    `stepTick`/`stepFrame` call, the hot loop of every measured window. Measured contribution: about
    250 B/frame of `gc-loop`'s `main` total (`stepAll`'s own self-size in the profiler). Fixed by
    grouping workers by role once at harness creation (`roleGroups: Map<Role, WorkerHandle[]>`) and
    switching `stepAll`'s two loops from `for...of` to indexed (a further ~130 B/frame drop, an
    iterator-protocol allocation on an otherwise-plain array). `manual-clock.ts`'s `frame()` also
    skipped its own `frames = []` churn when nothing is pending (the normal case before M06b, since
    no client-role worker exists to call `requestFrame`). Combined: measured `main` clean overhead
    went from 651 B/frame (first real run) to a stable 45.43-45.55 B/frame over 50 runs. This is
    `src/test/**` code, formally exempt from `.claude/rules/hot-paths.md`'s allocation rule -- fixed
    anyway because the real cost was ~15x the spike's own harness-overhead figure and this milestone
    exists to measure that overhead accurately.
  - `src/test/controls.ts`'s negative-control `sink` was a bare module-level `let`, exactly the
    spike's own shape ("assigned but never read, defeats escape analysis"). Vite's production build
    (real Rollup tree-shaking; the spike's pages were served unbundled, so it never hit this)
    eliminated every write to it as dead code: reading the built `gc-loop-*.js` chunk showed
    `if (control.kind === "object");` -- an empty statement where `allocateObject(f)` used to be, and
    `allocateBurst`'s whole loop body reduced to `for (let k = 0; k < BURST_COUNT; k++);`. Every
    negative control silently measured as clean until this was caught (bytes basically unchanged
    from the clean baseline, a ~15x-too-small effect, not zero, was the tell). Fixed by writing
    through a `globalThis` property instead of a lexical `let`: a bundler cannot prove a global
    object's property write is unread. `.claude/skills/gc-test/SKILL.md`'s "usual causes" section
    names this pattern for the next page that adds a control-like write.
- **`gc-page.ts`'s `run()` is fully self-managing**, not driven by external `resume()`/`park()` calls
  around it as the Sequence's prose might suggest read literally: it arms what it needs (skipping a
  `post-message`-controlled worker), steps `frames` frames, and parks everything again before
  returning. `instrument.ts` never calls `window.__harness.resume()`/`park()` directly; the
  Sequence's "resume" and "park" bullets are what happens inside the neighbouring `run()` calls.
  `GcPageApi.setControl` additionally writes the SAB `Control` word for a worker-isolate object/burst
  control (`Harness.setWorkerControl`), since only the worker's own tick op can apply it.
  `GcPageApi.memGrows()` was added beyond the Seams listing (which only names `memoryBytes`), same
  shape, for the WASM-memory assertion of the "Planning decisions" section.
- **`instrument.ts`'s `measure()` no longer navigates the page itself**, contrary to a literal reading
  of "Sequence" starting at "open page, await ready": `tests/browser/support/page.ts`'s `openPage`
  (navigate, assert `crossOriginIsolated`, fail on console/page error) is called by `suite.ts` first,
  same convention every other spec uses, so a gc spec's failure mode for a broken page matches every
  other browser spec's.
- **`gc` Playwright project runs by default, as part of `pnpm test browser`**, not excluded from
  `pnpm test` as a first reading of the Seams line ("`pnpm gc <software|flat|reliability> [-t
  pattern]` ... set for local use") suggested. Two things in the brief itself require this: exit
  criterion 1 is literally `pnpm test browser -t gc-loop`, and the Budgets section prices the whole
  `gc-loop` suite into the `browser` suite's row ("more than about 4 s added means something is
  wrong"). Reconciled as: the *default* single hardware/tunnel pass of every `gc-*.spec.ts` runs
  through `pnpm test browser` like any other project (`chromium`/`webkit`/`firefox` `testIgnore`
  `gc-*.spec.ts`, the `gc` project's own `testMatch` is only that); `pnpm gc`'s three named modes
  (`software`, `flat`, `reliability`) are the separate, local-only, environment-varying invocations
  the Seams line actually means. `playwright.config.ts`'s global `testMatch` is restricted to
  `**/*.spec.ts` (the default also matches `*.test.ts`, which collided with `gc/analyse.test.ts` once
  it existed under `tests/browser/`).
- **`cdp-flat.ts` worked on the first real run against a live browser and stayed within the roughly
  one-hour time-box**; risk 11 (PRE-PLAN.md) is closed for real, not left open. Shape: one flattened
  CDP WebSocket per attachment (`FlatConnection`, browser-level `webSocketDebuggerUrl` from `/json/
  version`), `Target.attachToTarget` on the page found in `/json/list` by matching its URL pathname,
  `Target.setAutoAttach {flatten: true}` for its workers, routed by `sessionId` with one global `id`
  counter (flattened CDP requires this). The `gc` project's launch args always include
  `--remote-debugging-port=<ENGINE_CDP_PORT base 9333 + TEST_PARALLEL_INDEX>` (Playwright sets this
  env var per worker process, read at config-load time), so `GC_CDP=flat` reaches the same browser
  the `page`/`browser` fixtures already launched -- no separate browser spawn needed. `gc: flat
  transport parity` opens `gc-loop.html` twice (fresh page each time) in one test, forcing the tunnel
  then forcing flat via `measure()`'s `attach` override, and asserts the worker's exact `totalBytes`
  (sampled bytes summed over the whole window, before dividing by frames) are bit-identical between
  the two transports -- confirmed equal on every run in this session.
- **`packages/engine/budgets.json`, `gc.pages.gc-loop`** (measured on Tyler's Mac, warm caches; `pnpm
  gc reliability` numbers below):
  - `main`: **54 B/frame**. 0016 §1's 110 B WebGPU floor does not apply (no WebGPU on this page,
    "Planning decisions"). Formula: ceil(max of 50 clean runs, spread 45.43-45.55 B/frame) = 46, + 8 B
    margin (0016 §1's own margin convention) = 54.
  - `sim`: **8 B/frame**, unchanged from 0016 §1's strict worker figure (not re-derived: the brief
    says to use it as-is). Measured clean here: constant 2.9733 B/frame (1784 B / 600), comfortably
    under it even though this worker's `coreTick` does substantially more per tick (admit + tick +
    build_frame + two region copies) than the spike's bare `sim_tick`.
  - `software.frames`: 600 (unchanged from hardware mode; this page has no WebGPU scene to shrink for
    a software adapter, so caveat b's SwiftShader-timeout reason for shrinking `frames` doesn't
    apply here). `software.isolates.main.attributedBytesPerFrame`: 28 (measured 19.43-19.6 B/frame
    over several runs, attributed under root `run`, + 8 B margin). `software.isolates.sim.
    attributedBytesPerFrame`: 8 (measured 0-1.42 B/frame across runs, noisy at this scale; reused the
    hardware worker figure rather than a tighter number, since the margin at this size is mostly
    noise headroom, not a formula).
  - `attributionRoots`: `main` = `["run"]` (`installGcPage`'s per-frame driver); `sim` = `["coreTick"]`.
- **`pnpm gc reliability`**: clean **50/50**, every negative control **15/15** (5 controls x 15 = 75/
  75), 38.4 s wall on 4 workers. Byte spread: `main` 45.43-45.55 B/frame (the dedicated 50-run clean
  sampling used to set the budget, same build/scenario as the reliability run itself), `sim` constant
  2.9733 B/frame across every run observed in this session (bit-identical, matching 0016 §3's own
  "worker total was bit-identical in 820 runs" finding).
- **`browser` suite timing**: `pnpm test` now reports `browser pass 20 tests` (13 from M03 + 7 from
  M04), typically **5.5-5.7 s** of the 25 s budget across repeated runs; one run read 7.2 s
  immediately after a `pnpm gc reliability` run left CPU contention, not reproduced on a cold
  machine. Individual `gc` project test timings (`--reporter=list`): `gc-loop clean` ~0.4 s, `neg
  object main/sim` ~0.3-0.4 s, `neg burst main/sim` ~0.9 s (the slowest; matches the spike's own
  note that the 2000-object controls cost the most), `neg post-message` ~0.3 s, `flat transport
  parity` ~0.3-0.4 s -- every one comfortably under 0020 §4's 3 s browser p95 demotion threshold.
- **Exit criterion 2, done by hand, reverted:** a temporary write in `loader.ts`'s `call0` (`;(this as
  unknown as { __tmp?: unknown }).__tmp = {}` per call -- a bare `{}` alone is eliminated by the same
  bundler tree-shaking described above, so this assigns to `this`, a real escaping object, to survive
  the build) made `gc-loop clean` fail on `sim` (`B: false`) with `call0@harness-worker-*.js:120:
  16800` as the single largest entry in `byFn.sim`. `git checkout -- packages/engine/src/loader.ts`
  confirmed clean afterward (`git diff --exit-code` empty); `pnpm --filter engine build` and the pages
  `vite build` were re-run before the next real measurement.
- **Pre-existing failure found and fixed before any M04 code, unrelated to this milestone's scope:**
  `packages/engine/CLAUDE.md` was 62 lines against `scripts/lib/context-artifacts.test.mjs`'s 60-line
  cap -- verified red in a throwaway `git worktree` at both `5cbf35e` (M03's own "done" commit) and
  `e6767d6` ("M04 start"), so `pnpm test unit` was never actually green at this milestone's base sha
  despite the delegation prompt's claim. Fixed by reflowing two sections that were already
  hard-wrapped (unlike the rest of the file's single-line-per-bullet style) into that same style,
  removing no content, plus one added sentence naming `gc-loop.html`/the `gc-test` skill; now 46
  lines. Worktrees removed after confirming.
- **`readControlSink()`** (`controls.ts`) is exported for a unit test but no unit test currently
  exercises it directly (the fix it exists to make possible -- observing the sink survive a
  production build -- can only be checked by reading the built bundle, which the exit-criterion-2
  style checks above already do implicitly): a gap, not a claim it's covered.

## Decisions needed
None: no seam under **Provides** was renamed, no accepted decision changed. The one place this
session read the brief against itself and picked a side (the `gc` project running inside `pnpm test
browser` by default) is recorded above with the reasoning; flagging it here in case the orchestrator
reads it differently.

## Notes for later briefs
- M09 (`terrain`, first WebGPU main budget): the `main` row here (54 B/frame, no adapter) is not a
  starting point for that number -- 0016 §1's formula (16 B x wrapper-call count + 24 + harness
  overhead + 8 B margin) is. `expectAdapter: true` is the only new thing `zeroGcSuite` needs from
  that page.
- M06b (carrying the negative-control hook into the production worker shell) will want
  `HarnessWorkerSpec.rxTx` and the `Control` step-block word as reference for what a "test-only flag
  in the setup message" needs to carry, per the brief's own hand-off note.
- M29 (net worker, `budgeted` class): `analyse.ts`'s `verdict()` already branches `A` on `budget.class`
  (`strict` requires zero `MinorGC`+`MajorGC`; `budgeted` only zero `MajorGC`) and reads
  `bytesPerMessage` as a fallback when `bytesPerFrame` is absent -- built for this milestone's own
  isolates but exercised only by the `strict` path so far.
- **Orchestrator gate (2026-09-19):** `pnpm gate 5cbf35e` clean (32 files, +1896/−38, no goldens or markers changed); `pnpm test` (`rust` 16, `unit` 60, `wasm` 23, `browser pass 20 tests 5.8s/25s`) and `pnpm lint` green, run by the orchestrator. Slow and check-then-revert evidence (`pnpm gc reliability` 50/50 and 75/75, the `call0` check, `pnpm gc software`) accepted from the implementer's pasted result lines above. Orchestrator fix: `src/test.ts` did not export the `engine/test` seams this brief provides; added `installGcPage`, `GcPageApi` and `NegativeControl` there (pages import them by relative path, so no test noticed). Seam wording corrected by this section: the control hook and the attribution roots are `run` (main, inside `installGcPage`) and `coreTick` (`harness-worker.ts`), not the `harnessStepFrame` / `harnessWorkerStep` names of Seams; no other brief names them. The `packages/engine/CLAUDE.md` line-cap failure the implementer found at the base sha was the orchestrator's own `__pageReady` edit, committed in `M03 done` without a re-run; `5cbf35e` and `e6767d6` are therefore red on `unit` (that one test), fixed by the reflow in this milestone.
