# 0052: Zero-GC warm-up is 4000 frames in 8 passes

Status: Accepted (2026-10-02). Amends [0016](0016-zero-gc-definition.md) §3 step 3 (the "120 warm-up frames") and its "One-time setup" bullet. Implemented in `packages/engine/tests/browser/gc/instrument.ts` (`WARMUP`, `WARMUP_PASSES`) by M06b and M16c.

## Context

[0016](0016-zero-gc-definition.md) §3 step 3 steps 120 warm-up frames before `HeapProfiler.enable`, and its "One-time setup" bullet counts those 120 frames as setup. The harness has not used 120 since M06b. The production `yield`-protocol call chain on `topology` and `echo` had not reached steady optimised code at 120 or even 3000 frames, so `WARMUP` became 8000 (`docs/plan/06b-workers-and-spawn.md`, "`measure()`/`zeroGcSuite` take an optional `warmupFrames`"). M06b also split it into `WARMUP_PASSES = 8` calls of `WARMUP / 8` frames, so one-time lazy-feedback allocation falls outside the steady-state window. The orchestrator accepted the split there. M16c then re-measured and halved 8000 to 4000, because warm-up was the dominant fixed cost in every generated gc test (`docs/plan/16c-browser-suite-time.md`, Step 3). Its sweep put `input`'s `main` at 196 B/frame over the 190 budget at 2000, 186-187 at 3000, and 181.6-181.7 at 4000, which matches the pre-[0028](0028-zero-gc-two-measured-windows.md) baseline. Readings at 6000 and 8000 were no better than 4000. No `budgets.json` number changed. The fast tier fell from 17.4 s to 12.3 s.

Both briefs call the number a deviation from 0016. This ADR makes it the decision.

## Decision

**1. Warm-up is 4000 frames, in 8 passes.** `WARMUP = 4000` and `WARMUP_PASSES = 8` (500 frames per pass) in `instrument.ts` replace the 120 frames of 0016 §3 step 3 and the "One-time setup" bullet. The 4000 frames are one-time setup, outside both measured windows of [0028](0028-zero-gc-two-measured-windows.md). A page may pass `warmupFrames` to override the default. 4000 is the lowest value measured with margin, chosen over 3000 for that margin.

**2. Warm-up length is not a lever for the burst red.** [0028](0028-zero-gc-two-measured-windows.md) measured six warm-up settings. Each relocates the `client` burst event and none removes it, and the closest (`WARMUP_PASSES = 120`) pushes `input`'s `main` over its budget. Nobody should lengthen warm-up to fix a burst failure. 0028's two windows are the fix, and this value is not a tuning knob for that failure.

**3. The rest of 0016 §3 stands.** Every other step is unchanged: isolates, `HeapProfiler` use, window shape (as amended by 0028), and the budgets.

## Alternatives rejected

- **Keep 120 (0016 as written).** Too short for the production call chains, and `topology` and `echo` did not separate clean from control readings.
- **Keep 8000.** It measured no better than 4000 on any page and cost about 5 s on the fast tier.
- **3000 or 2000.** 3000 leaves 3-4 B of margin under the `input.main` budget. 2000 is over budget.
- **More warm-up passes, or extra settle frames, to cure bursts.** See §2.

## Consequences

- 0016's text is not rewritten. Its status line points here and a reader takes 4000 from this ADR.
- If a new page's `clean` reading fails only at 4000, pass `warmupFrames` for that page and note the measurement in its brief. Revisit the global value if most pages need it.
- Any change to `WARMUP` needs a per-page re-measurement against `budgets.json`, as M16c did.

## Sources

- `docs/plan/06b-workers-and-spawn.md`, `warmupFrames` paragraph and orchestrator acceptance (read 2026-10-02).
- `docs/plan/16c-browser-suite-time.md`, Step 3 and its Deviations (read 2026-10-02).
- `docs/plan/11-camera-and-input.md`, warm-up settings table (read 2026-10-02).
- [0028](0028-zero-gc-two-measured-windows.md), "No warm-up setting removes it" (read 2026-10-02).
