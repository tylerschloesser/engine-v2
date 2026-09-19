# M04: Zero-allocation assertion with permanent negative controls

Status: not started · After: 03 · Tyler-dependent: no (Q2 answered: the zero-GC Requirement in `docs/spec/testing.md` is amended to 0016's reading; what is built does not change)

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
- `unit`: `gc analyse: sums selfSize exactly`, `gc analyse: inclusive attribution under roots`, `gc analyse: GC events outside the marks are ignored`, `gc analyse: events are attributed to named isolates`, `gc verdict: software mode uses attributed bytes`, `budgets: every gc page lists main`.

## Exit criteria
- [ ] `pnpm test browser -t gc-loop` passes: clean within budget on `main` and `sim` with zero GC events; every negative control's verdict matches 0016 §3.8 on the named isolate only.
- [ ] Temporarily allocating `{}` per call inside `call0` in `src/loader.ts` makes `gc-loop clean` fail on `sim` with `call0` among the printed top allocation sites (check, then revert). This is the proof that the instrument sees engine code.
- [ ] `gc: flat transport parity` passes, or the gap is recorded under Deviations with risk 11 left open.
- [ ] `pnpm gc software -t "gc-loop clean"` passes.
- [ ] `pnpm gc reliability`: clean 50/50, each control 15/15; numbers recorded.
- [ ] Added `browser` suite time recorded; the slowest `gc` test is under the browser p95 rule of 0020 §4.
- [ ] `.claude/skills/gc-test/SKILL.md` exists; its commands were each run once in this session.
- [ ] `pnpm test` and `pnpm lint` are green.

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
(filled in during Phase 3)
