# 0027: The zero-GC byte total excludes V8's own blocking-primitive bookkeeping

Status: Superseded by [0028](0028-zero-gc-two-measured-windows.md).

## Context

[0016](0016-zero-gc-definition.md) §1 fixes every worker isolate's strict figure at 8 B/frame. That
number was derived, and has always held, on pages whose worker always has real work pending at
every wake -- `ControlBlock.waitForWake`'s `Atomics.wait` call (`sab/control.ts`) therefore always
took the fast "value already differs" path and never actually suspended the thread. The figure
silently assumed this; no earlier page (`gc-loop`, `topology`, `echo`, `gen`, `terrain`) ever
exercised the other path.

M11's `input` page is the first to call `client.camera.tick()` (a real `CameraIntegrator` +
`SemanticRecognizer` pass) every rAF, a heavier main-thread workload than any earlier zero-GC page.
Under a *sibling* isolate's own `object`/`burst` negative control (`main` or `gen0`, allocating on
its own thread), that sibling's own per-pass work slows down enough that the client worker's wake
cadence -- tied one-to-one to `main`'s own per-frame `stepFrame` call -- stretches out. The client
worker then, unlike on any earlier page, sometimes genuinely blocks in `Atomics.wait` and is later
woken by a cross-thread `Atomics.notify`, instead of finding the wake word already changed.

**Measured** (`docs/plan/11-camera-and-input.md`, Deviations, "fix round 1/2"; a real Chromium
`HeapProfiler` sampling session at `samplingInterval: 1`, `input neg object main`):

- `client`'s own steady clean figure is 2.52 B/frame, identical to every other page's `client`/
  `gen0`/`sim` row, every measurement. Under `input neg object main` it reads 25.09 B/frame (over
  its 8 B budget), with `waitForWake@<built file>:<line>` attributed 13,544 B over the 600-frame
  window in the profiler's own `byFn` breakdown -- the whole excess (25.09 − 2.52 ≈ 22.57 B/frame ×
  600 ≈ 13,540 B).
- `gen0`, in the identical scenario and the identical wake cadence (`stepTick` every frame), never
  shows this: it always finds work pending and always takes the fast path.
- The 13,544 B figure is unchanged before and after `ControlBlock.waitForWake` was reduced to *only*
  its bare `Atomics.wait(...)` call -- no `Atomics.load`, no return value, nothing else in the
  function body. Removing every JS statement around the call left the number identical, which
  places the cost inside `Atomics.wait` itself, on the genuinely-blocks-then-is-woken path, not in
  any JS this engine or its tests own.
- Once machine load was low enough to remove confounding scheduling noise, `input neg object main`
  failed 15 of 15 runs: deterministic under real contention, not intermittent.

The bytes are V8's own internal bookkeeping for a thread that actually suspends and is resumed by a
cross-thread signal (`Atomics.notify`) -- not a JS-heap allocation any engine code, test code or
harness code performs, and not reachable or preventable from JS. [0016](0016-zero-gc-definition.md)
§1's own caveat (c) already accepts that "only the V8 heap is measured" can occasionally see V8's own
internals show through; this is the first concrete instance found.

## Decision

**1. What is excluded.** `tests/browser/gc/analyse.ts`'s `sumProfile` no longer counts `selfSize`
attributed to a call frame whose `functionName` is `waitForWake` toward `total` (hence
`bytesPerFrame`/`bytesPerMessage` verdicts, 0016 §3 step 7). Nothing else changes: no isolate is
exempted, no other function name, no broader "blocking loop" or "worker path" bucket.
`sumProfile` returns the excluded total separately (`excludedBytes`) and still reports it in `byFn`
so the exclusion cannot silently swallow a real regression under that name -- a future bug that
happens to also attribute to `waitForWake` would need to grow past whatever this baseline already
carries to be masked, and any change to that function's own shape is guarded by decision 2.

**2. Self-policing.** `ControlBlock.waitForWake`'s body is pinned to exactly the one `Atomics.wait(
...)` statement (no load, no return, nothing else) by a new source-shape assertion alongside
`sab/no-alloc-syntax.test.ts`'s own pattern. The exclusion in decision 1 is only as narrow as that
function's own body; this test is what keeps it from silently widening if someone later adds code
to that frame.

**3. The strict worker figure stays 8 B/frame** (0016 §1, unchanged). This amendment changes what
the instrument counts, not what is allowed. No existing page's committed budget number moves because
of this alone. `gc.pages.input.main` -- a brand-new row this same milestone adds, not an existing
one -- is derived from the corrected measurement, by 0016 §1's own formula, as part of the same
change.

## Alternatives rejected

- **Widen `input`'s `client`/`gen0` budget, or add "sibling-burst headroom."** Papers over a real
  measurement defect instead of fixing it; [0026](0026-zero-gc-burst-controls-in-slow-tier.md)
  already rejected reopening the strict worker figure for a different symptom (ordinary cross-isolate
  scheduling noise) in this same area, for the same reason.
- **Exclude the whole `client` isolate, or all of `worker/shell.ts`'s blocking loop, while a
  sibling control is armed.** Hides any real allocation bug at that isolate or in that file forever,
  not just this one understood, narrowly-named cost.
- **Demote `input`'s `object` negative to `@slow`.** 0026 already established that `object` stays
  fast-tier for every page (it is instrument B's only isolate-level proof); this milestone's own
  finding is about what B counts, not about which tier `object` runs in, and does not reopen that
  decision.
- **Replace `Atomics.wait(..., Infinity)` with a bounded-timeout retry loop.** Tried and measured
  (`docs/plan/11-camera-and-input.md` Deviations): the identical cost persisted (or, at very short
  timeouts, got worse and broke an unrelated test by changing wake/ack timing), for a much larger
  and riskier change to every worker's wake latency, for no benefit.

## Consequences

- Every zero-GC page benefits equally: a future page whose worker also genuinely blocks under
  contention (any production-topology page built after M11) is now correctly measured too, not just
  `input`.
- If a Chromium/V8 update ever attributes this cost to a different call frame (`Atomics.wait`
  becoming separately named in the sampled profile, say), this exclusion silently stops working;
  decision 2's test only guards `waitForWake`'s own source shape, not the profiler's attribution
  behaviour. A future Chromium pin bump for the `gc` project is the trigger to re-verify this
  mechanism specifically, alongside the existing caveats [0016](0016-zero-gc-definition.md) §3
  already carries for instrument fragility.
- Deferred: nothing new. This states precisely what one V8 version's profiler does today; if a later
  milestone measures a different mechanism it amends this ADR in turn rather than widening it.

## Sources

- `docs/plan/11-camera-and-input.md`, Deviations (steps 6-8: "fix round 1", "fix round 2") -- the
  measured before/after `waitForWake` byFn numbers, the stripped-to-bare-`Atomics.wait` experiment,
  the 15/15 deterministic failure at low machine load, the rejected bounded-timeout experiment.
- [0016](0016-zero-gc-definition.md) §1 (the strict worker figure, caveat (c) on V8-internal
  visibility), §3 steps 6-7 (the assertion this amends).
- [0026](0026-zero-gc-burst-controls-in-slow-tier.md) (the prior amendment in this same area, and its
  own reasoning for keeping `object` in the fast tier).
