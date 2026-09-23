---
name: profile-frame
description: Profile the repo's real-rAF frame-time benchmark (bench.frame_worstcase, docs/decisions/0018-renderer.md §9) -- prints main-thread and client-worker frame durations plus the top five self-time functions per thread. Use when a frame-time benchmark fails, when a renderer or `extract`/sort change is suspected of a regression, or before updating packages/engine/baselines/frame.json.
---

# profile-frame

`bench.frame_worstcase` (`packages/engine/tests/browser/frame-bench.spec.ts`) is the repo's one
frame-time exit criterion (docs/decisions/0018-renderer.md §9, docs/decisions/
0020-testing-strategy.md §9): `frame-bench.html`, a real connected `fx-drawables` client under real
`requestAnimationFrame`, at the 65,536-drawable maximum-zoom-out worst case (0018 §6). It asserts
pass/fail against the desktop-proxy budget (main <= 1.3 ms, worker <= 2.7 ms) and against the
checked-in baseline (`packages/engine/baselines/frame.json`) within 25%. This skill is the
diagnostic twin: it runs the identical scene and measurement window but prints numbers instead of
asserting, plus a CPU self-time breakdown the pass/fail test does not compute.

## When to use it

- `bench.frame_worstcase` (or `pnpm bench:frame`) fails or is close to a budget/baseline line.
- A change touched the renderer's per-frame path (`render/drawables.ts`, `render/terrain.ts`,
  `uberquad.wgsl`), the client worker's `frame()`/publish path (`worker/client.ts`,
  `worker/client-drawlist.ts`, `client/drawlist.rs`, `client/frame_view.rs`), or `extract`/sort in a
  game (`fixtures/drawables/src/lib.rs`'s own `ClientSide::extract` is the one this scene drives).
- Before updating `baselines/frame.json` after a deliberate, reviewed performance-affecting change:
  run this once, sanity-check the numbers and the top self-time functions look like the change you
  expected (not a regression the change happened to also introduce), then write the new medians into
  the baseline file by hand with the run's own conditions (machine, load average, flags) recorded
  next to them, the same way the checked-in baseline documents its own.

## The command

```
node packages/engine/scripts/profile-frame.mjs [--fixture drawables] [--frames 300]
```

Run from the repo root. Only `--fixture drawables` (the one wired scene) exists today; `--frames`
overrides the timed-window frame count (default 300, matching `bench.frame_worstcase`'s own
`TIMED_FRAMES`). It rebuilds the engine, fixtures and browser-suite pages, serves them on
`127.0.0.1:4520`, launches Chromium with the same `--disable-frame-rate-limit --disable-gpu-vsync`
flags the `frame-bench` Playwright project uses, and drives 120 warm-up + `--frames` real rAF frames
against `frame-bench.html`. It always exits 0 (a diagnostic tool, not a gate) except on a genuine
setup failure (wrong entity count, an `uncapturederror`) -- `bench.frame_worstcase` itself is the
gate, run through `pnpm test:slow` or `pnpm bench:frame`.

It writes the raw CDP trace to `test-results/profile-frame/trace.json` (every `Tracing.dataCollected`
event inside the timed window) and prints one table:

```
bench.frame_worstcase profile: records=65536 frames main=302 worker=23 warmup=120
  main   p50=0.674ms p95=0.722ms  budget<=1.3ms  baseline.p50=0.642ms (+25%=0.802ms)
    top self-time (307.36ms sampled):
      153.712ms  writeBuffer@:0
      75.223ms  (program)@:0
      70.667ms  mark@:0
      5.871ms  (idle)@:0
      0.327ms  onCamera@frame-bench-DTHw02uc.js:90
  worker p50=2.627ms p95=2.826ms  budget<=2.7ms  baseline.p50=2.241ms (+25%=2.801ms)
    top self-time (255.10ms sampled):
      144.909ms  copyBytes@worker-auto-ZcU9N8lO.js:191
      31.670ms  publish@worker-auto-ZcU9N8lO.js:550
      22.448ms  _ZN4core5slice20copy_from_slice_impl17h...@game.wasm:1
      16.656ms  (program)@:0
      9.027ms  mark@:0
```

## Reading it

- **`main`/`worker` p50/p95**: medians and 95th percentiles of the *measured* frame durations, taken
  from trace events between marks (never `performance.now()` deltas in page JS) -- the same
  mechanism `bench.frame_worstcase` asserts against. `main` is the whole rAF callback (camera
  integration, `writeBuffer`, encode, submit); `worker` is the client-role `frame(t_ms)` export call
  alone (extract + counting sort), *not* the whole worker wake (drawlist publish, net/gen/upload
  pumps run outside it in `worker/client.ts`'s `body()` and are not separately marked).
- **`frames main=.../worker=...`**: how many mark pairs landed in the timed window. Worker is
  normally well under main's count -- at 65,536 records the worker's own per-call cost (~2-3 ms) is
  the pacing bottleneck under this benchmark's deliberately uncapped rAF, so several main frames'
  own `CB_FRAME_REQ` advances coalesce into one worker wake (0018 §1: "the newest camera is applied
  to a one-frame-old list without error" -- production tolerates this by design). A worker count in
  the single digits is a red flag (the worker may not be running at all, e.g. the park/resume
  sequence failed); low double digits at this record count is normal.
- **`budget<=`**: 0018 §9's desktop-proxy ceiling. **`baseline.p50 (+25%=...)`**: the checked-in
  figure and the 25% tolerance line `bench.frame_worstcase` gates against (0020 §9). A p50 near or
  over either line is what this skill exists to explain.
- **`top self-time`**: the top five `functionName@file:line` entries by self time, summed from a CDP
  CPU profile (`Profiler.start`/`stop`, 100 us sampling interval) over the same timed window, one per
  isolate. `mark@:0` is this tool's *own* instrumentation overhead (the `performance.mark` calls
  around each frame) -- expect a few percent of the sampled total there and discount it; it is not
  present in `bench.frame_worstcase`'s own pass/fail measurement (that test only reads back trace
  timestamps, it does not CPU-profile). `(program)`/`(idle)` are V8-internal/GC-adjacent buckets with
  no JS call frame. A real regression shows up as a *new* entry in the top five, or an existing one's
  share growing well past what the last baseline update's own numbers imply.
- **`trace.json`**: every raw trace event collected in the window (not just the `mf-*`/`wf-*` marks);
  open it in `chrome://tracing` or feed it to another CDP-trace tool for a deeper look than this
  skill's own table gives.

## Updating the baseline

`packages/engine/baselines/frame.json` is checked in from a real measured run, never estimated: the
same file `bench.frame_worstcase` reads for its own 25% tolerance check. Run this skill's command
several times (numbers vary run to run with a ~23-sample worker window; look at the spread, not one
run), pick representative main/worker p50 and p95, and write them into the JSON by hand together with
`measuredAt`, `frames`, `warmupFrames`, `recordCount` and a `conditions` string naming the machine,
CPU count, launch flags and load average at measurement time (the existing file's own `conditions`
field is the template). Only raise the baseline for a change that is expected to cost more and was
reviewed as such; a baseline that silently absorbs a regression defeats the whole point of checking
one in.
