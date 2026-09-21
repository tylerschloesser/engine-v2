# 0028: The zero-GC byte total is the lower of two measured windows

Status: Accepted (2026-09-20). Supersedes [0027](0027-zero-gc-excludes-blocking-primitive-bookkeeping.md)
entirely; amends [0016](0016-zero-gc-definition.md) §3 step 7 (assertion B) and §3 step 8 (the
`object` control's size). [0026](0026-zero-gc-burst-controls-in-slow-tier.md) is the prior amendment
in this area. Implemented in milestone M11 (fix round 3).

## Context

[0027](0027-zero-gc-excludes-blocking-primitive-bookkeeping.md) read a fixed ~13.5 KB excess on the
`input` page's `client` isolate as V8's own bookkeeping for a thread that genuinely blocks in
`Atomics.wait`, and excluded bytes billed to a call frame named `waitForWake`. That diagnosis was
wrong, and the exclusion does not work: the orchestrator's own re-verification caught the identical
lump billed to `runBlockingLoop` instead, where the exclusion caught nothing.

**Measured** (M11 fix round 3; `docs/plan/11-camera-and-input.md`, Deviations, has the full tables.
Raw `HeapProfiler.stopSampling` payloads at `samplingInterval: 1`, `--sampling-heap-profiler-
suppress-randomness`, so `profile.samples` is one entry per allocation):

- The excess is **one contiguous burst**, not a per-frame cost. On `input neg object gen0`,
  `client`'s 13,544 B is 25 samples at consecutive ordinals 29-53 (of 58 in the whole profile),
  sized 6272, 3580, 1556, 344, 324, 268, 152, 8, 8 and then runs of 72 and 48. That is the shape of
  an instruction stream, its relocation info, its deoptimization data and its metadata -- a **JIT
  code-installation event**. A real 22 B/frame allocation would be ~600 samples spread across the
  window.
- **Attribution is arbitrary.** Across five instrument configurations (80 runs each) the same lump
  was billed on `client` to `waitForWake`, `runBlockingLoop`, `body`, `call1`, `load`,
  `get detached` and `scope.onmessage` -- whichever JS frame happened to be executing when the
  install landed. 0027's exclusion only ever caught the runs where that frame was `waitForWake`.
  **No set of function names can catch this**, which also explains 0027's own null results: reducing
  `waitForWake` to a bare `Atomics.wait(...)` left the number unchanged because the bytes were never
  that function's to begin with.
- This is the same mechanism [0016](0016-zero-gc-definition.md)'s instrument already met on
  `terrain` (M09 gate fix round 2, `docs/plan/09-renderer-terrain.md`), confirmed there by
  `--no-concurrent-recompilation` turning the flake into a constant.
- **`input clean`'s own ~1/15 is the same cause**, not a second one: at the committed warm-up,
  `client`'s burst rate over 20 runs each is 1/20 on `input clean`, 1/20 on `neg object main`, 6/20
  on `neg object gen0`, 0/20 on `neg object client`.
- **No warm-up setting removes it.** `client` burst rate over the same 80-run batch: 8/80 at the
  committed `WARMUP_PASSES = 8`; 55/80 at 40; 1/79 at 120 (but `main` rises 119.7 KB -> 129.4 KB,
  over `input.main`'s committed 206 B/frame); 60/80 with 150 extra zero-frame warm-up passes; 72/80
  with `terrain`'s own `extraSettleFrames: 500`; 80/80 under `--no-concurrent-recompilation`. Every
  knob *relocates* the event; none removes it. `terrain`'s `extraSettleFrames` fix worked by landing
  on a lucky phase, not by settling anything.

A strict worker isolate cannot absorb this: its whole budget is 8 B/frame x 600 = 4,800 B, and one
code object is three times that. A page's `main` budget always could, which is why this went
unnoticed for five pages -- every `main` reading ever measured carries such a burst, and each
`ceil(measured) + 8 B` budget was derived with it included.

## Decision

**1. Two measured windows; the byte total is the lower.** `measure()`
(`tests/browser/gc/instrument.ts`) arms the negative control, then runs two consecutive 600-frame
windows with a separate sampling session each, identical in every respect but the
`window-start`/`window-end` marks, which only the second carries. Assertion B (0016 §3 step 7) uses,
per isolate, the **lower** of the two totals, and reads `byFn` and the software-mode
`attributedBytes` from that same window so a failure's printed sites always belong to the total it
failed on. A JIT code-installation event is one-off by construction -- a function is compiled once
-- so it lands in at most one window; allocation that recurs every frame lands in both and passes
through the minimum untouched. The discriminator is the one property the budget actually asserts,
"does this recur?", not a name, a size or an isolate.

**2. Nothing is excluded by name.** `sumProfile` counts every sampled byte again; 0027's
`waitForWake` exemption and its `excludedBytes` field are gone. `GcResult.windowBytes` reports both
windows' own totals per isolate, printed next to every failure, so the discarded window is always
visible and the minimum is never a silent subtraction. `gc/analyse.test.ts`'s own
`no call frame is exempt` test is what keeps a name-based exemption from coming back.

**3. Assertion A is unchanged.** Only the second window is marked, so the GC-event assertion
(0016 §3 step 6) still looks at exactly one 600-frame window, as before.

**4. The `object` negative control is four small objects per frame, not one** (64 B/frame;
`src/test/controls.ts`, mirrored in `src/worker/gc-hook.ts`). Decision 1 removes 10-18 B/frame of
one-off noise that every page's `main` reading used to carry and that its `ceil(clean) + 8 B` budget
was derived around, which left a 16 B/frame control unable to clear the budget it exists to trip:
`gc-loop`, `echo` and `input`'s own `neg object main` all stopped failing. Four objects restores
40-47 B/frame of separation, keeps the control's shape and keeps assertion A true for it (measured:
every `object` control still fails B on its own isolate and nowhere else, with no GC event).

**5. The strict worker figure stays 8 B/frame and no page's budget number moves** (0016 §1,
unchanged). This amendment changes what is counted, not what is allowed; every committed
`budgets.json` number is untouched, and every clean reading is now at or below what it was.

## Alternatives rejected

- **Keep 0027's name-based exclusion, widened to more names.** Measured impossible: the same lump
  is billed to at least seven different frames, including `runBlockingLoop`, `body` and `call1` --
  real engine code whose exclusion would be a permanent blind spot, which 0027 §1 itself ruled out.
- **Exclude by call-site identity (url + line of the `Atomics.wait` site).** The sampled profile's
  `callFrame` carries the *function's own declaration* line, not the call site (verified against the
  built bundle: `runBlockingLoop@worker-auto-*.js:846` is its `function` line), so there is nothing
  to key on; and the event is not tied to the wait site anyway.
- **Prevent the inlining so attribution pins to one frame.** The premise is false: the bytes are not
  allocated by either function, and the frame is simply whoever is running.
- **More warm-up, in any form.** Six settings measured (above); each moves the event, none removes
  it, and the one that came closest (`WARMUP_PASSES = 120`) pushes `input`'s `main` over its
  committed budget.
- **`--js-flags=--no-concurrent-recompilation` on the `gc` project.** Makes the reading constant
  rather than flaky, but constantly *over* budget (80/80): it moves the compile onto the JS thread
  at a deterministic point inside the window.
- **Stop asserting sibling isolates under a negative control.** Would not have explained
  `input clean`'s own failures, which decision 1 does; and it would give up real coverage.
- **Widen `input`'s `client`/`gen0` budget.** Papers over a measurement defect, and 0026 already
  refused to reopen the strict worker figure for a symptom in this area.

## Consequences

- Every zero-GC page gets a more accurate reading, and every page built after M11 is protected from
  a defect that was always present and only became fatal when a strict worker isolate met it.
- A measurement costs 600 more frames (about 30% more wall clock in the `gc` project; the whole
  project, 48 tests including the `@slow` burst controls, runs in about 22 s).
- Readings drop by however much one-off noise a page's `main` used to carry, so every
  `budgets.json` `formula` string derived as `ceil(measured) + 8 B` now has more headroom than it
  says. Re-deriving those numbers downward is deliberately **not** part of this change (it would
  move committed budgets); the trigger to do it is the next milestone that touches a page's budget
  for its own reasons.
- `sab/no-alloc-syntax.test.ts`'s `sab.wait_for_wake_shape` is kept, now on its own merits alone
  (`worker/shell.ts` blocks only through that one method, so its body staying one statement is
  ordinary hot-path discipline) rather than as 0027 §2's guard.
- Deferred: nothing new. If a future page is found where a *single* window is genuinely needed, or
  where an event lands in both windows, this ADR is amended rather than widened.

## Sources

- `docs/plan/11-camera-and-input.md`, Deviations, "Fix round 3" (2026-09-20): the sample-level
  ordinal/size dumps, the five-configuration attribution table, the six warm-up settings and their
  burst rates, and the verification runs.
- [0016](0016-zero-gc-definition.md) §1 (the strict worker figure), §3 steps 6-8 (the assertions and
  the negative controls this amends).
- `docs/plan/09-renderer-terrain.md`, Deviations, "Gate fix round 2": the same mechanism measured on
  `terrain`, with the `--no-concurrent-recompilation` / `--no-lazy-feedback-allocation` diagnostic
  legs that first located it as JIT-tier finalization.
- [0026](0026-zero-gc-burst-controls-in-slow-tier.md), [0027](0027-zero-gc-excludes-blocking-primitive-bookkeeping.md).
