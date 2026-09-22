# M15f: `stepSimTickSync` allocates 28 B/frame on `main` in the interpreter tier

Status: not started · After: 15c · Tyler-dependent: no

## Goal

`pnpm test:slow` under `GC_MODE=software` is green, on `ubuntu-latest` as well as locally, because
`stepSimTickSync` no longer allocates on the `main` isolate — including when V8 runs it in the
interpreter tier. `gc-sim`'s and `gc-connected-terrain`'s `neg burst sim @slow` controls stop
failing on `main`, and no budget is widened to achieve it.

## The defect, measured by the orchestrator before this brief was written

CI run `35761075119` on `99a86b6` failed the **slow tier** with two negative controls:

```
FAIL browser [gc] connected-terrain neg burst sim @slow   main attributed 108.5  (budget 89)
FAIL browser [gc] sim neg burst sim @slow                 main attributed 28     (budget 0)
```

In both, the control's own isolate behaved correctly — `sim` read 80,407 and 40,074 B/frame, so the
burst tripped as designed. What failed is **`main`**, which gains **exactly +28.0 B/frame** whenever
a burst runs on the `sim` isolate (`connected-terrain` clean measures 80.5; under `neg burst sim` it
measures 108.5).

It passes locally at rest and fails on CI because the mechanism is tier-dependent: a busy sibling
isolate starves `main`'s TurboFan job, so the measured window runs interpreted. **Forcing the
interpreter reproduces it exactly**, which is what turns this from an intermittent CI red into a
one-command local repro. Add `--no-opt --no-sparkplug` to the `gc` project's existing `--js-flags`
in `packages/engine/playwright.config.ts` and run
`GC_MODE=software pnpm test:slow -t "neg burst sim"`: `main` reads 108.52 and 28, against CI's 108.5
and 28.

**Attributed to one frame, remainder zero.** From the failure artefact's `byFn`:

```
"main": { "stepSimTickSync@client-D90gg8O_.js:242": 16800, ... }
```

16,800 B over 600 frames = **28.0 B/frame exactly**, and `gc-connected-terrain.ts` calls
`stepSimTickSync(client, 1)` once per frame. So the whole discrepancy is one call site.

**The likely cause, stated as a hypothesis — confirm it before fixing.** `stepSimTickSync`
(`src/test/client.ts:304`) opens with
`h.workers.some((w) => w.kind === 'sim')`, allocating a fresh closure per call; ~28 B is the right
order for a V8 closure. Note that `allResumed`, a few lines below in the same file, already carries
the in-repo precedent and the reason: "a plain indexed loop, not `Array.prototype.every` with an
inline arrow (same discipline as `allEqual`)". `Atomics.add`/`Atomics.load` on an `Int32Array`
return Smis and should not box, but check rather than assume, and check `clientTestHandle` too.

## Scope

- Make `stepSimTickSync` allocation-free in the interpreter tier. Keep its semantics exactly: the
  step-request bump, the wake, and the spin-until-ack with `SPIN_LIMIT`, including both error
  messages.
- Audit the rest of `src/test/client.ts` for the same per-call-closure shape on any function a
  zero-GC page calls per frame, and fix what you find in the same pass. Report what you audited.
- Re-derive any budget this makes measurably lower, **downward only** (M15d's precedent). If a
  budget can stay as it is, leave it and say so.

## Non-scope

- Production code. `stepSimTickSync` is `engine/test` harness code, so this changes the instrument,
  not the engine. If you find a production allocation on this path, report it — do not fix it here.
- The `parkWorkers` saturation watch item, and the `browser` fast-tier suite line.
- Committing the `--no-opt --no-sparkplug` config edit. It is a local diagnostic; revert it.

## Files touched

`packages/engine/src/test/client.ts`, and `packages/engine/budgets.json` only if a number moves down.

## Seams

**Provides:** nothing new; `stepSimTickSync`'s signature and semantics are unchanged.
**Consumes:** M13's `CB_SIM_STEP_REQ` step protocol; M04's zero-GC instrument and its `byFn`.

## Order of work

1. Reproduce with the forced-interpreter flags above and paste `main`'s `byFn` line for both pages.
2. Confirm what inside `stepSimTickSync` allocates, by measurement, not by reading alone.
3. Fix it. Re-run under forced interpreter and paste the new `byFn` for `main`.
4. Revert the config edit; re-run at rest to confirm nothing regressed.
5. Re-derive budgets if anything moved down.

## Tests added

None expected: the `neg burst sim @slow` controls on both pages are the test, and they currently
fail. If you find the defect is reachable without the interpreter flags, say so — that would justify
a fast-tier assertion and is a finding, not a licence to add one.

## Exit criteria

- [ ] `GC_MODE=software pnpm test:slow -t "neg burst sim"` passes at rest **and** under
      `--no-opt --no-sparkplug`, with `main`'s `byFn` pasted before and after.
- [ ] `stepSimTickSync@...` no longer appears in `main`'s `byFn` at all — gone, not smaller.
- [ ] No budget raised. Any budget that moves, moves down, with its formula updated.
- [ ] The audit of the rest of `src/test/client.ts` is reported, naming what was checked.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands

`GC_MODE=software pnpm test:slow -t "neg burst sim"` · `pnpm test && pnpm lint` (the orchestrator
runs the gate; you run targeted foreground runs only).

## Budgets

No new rows. `gc-sim`'s software `main: 0` and `gc-connected-terrain`'s software `main: 89` are the
two this defect currently violates; both should pass unchanged once the allocation is gone.

## Context artifacts

If the fix is the closure shape, add the same one-line reason `allResumed` already carries, so the
next person does not reintroduce it.

## Manual device checks

none

## Deviations

**Repro (step 1).** Temporarily added `--no-opt --no-sparkplug` to the `gc` project's `--js-flags`
in `packages/engine/playwright.config.ts` (reverted before finishing, never committed:
`git diff packages/engine/playwright.config.ts` is empty at the end of this milestone).
`GC_MODE=software pnpm test:slow -t "neg burst sim"` then failed exactly as CI run `35761075119`
did: `main` read 108.52 (`connected-terrain`) and 28 (`sim`), byFn's only `main` entry in both cases
`stepSimTickSync@client-D90gg8O_.js:242: 16800` (16,800 B / 600 frames = 28.0 B/frame exactly, the
whole discrepancy).

**Confirmed by measurement, not by reading (step 2).** The hypothesis in the brief --
`h.workers.some((w) => w.kind === 'sim')` allocating a fresh closure per call -- is the whole 28.0
B/frame: after replacing it with a plain indexed loop (matching `allEqual`/`allResumed`'s own
discipline immediately above it), `stepSimTickSync@...` no longer appears anywhere in `main`'s
`byFn`, in either page, under forced interpreter. Nothing else in the function (`Atomics.add`,
`h.control.wake`, the `Atomics.load` spin) shows up as an allocation site before or after; both were
already Smi-only integer ops, as the brief suspected. `clientTestHandle` was checked too: it returns
the same object every call (a property read off `Client`, no allocation).

Since a passing test's failure-JSON `byFn` is not printed, disappearance was confirmed by the
technique `connected-terrain`'s own `sim` row formula already used precedent for ("the budget forced
to 1"): temporarily set each page's `gc.pages.<id>.software.isolates.main.attributedBytesPerFrame`
to `-1` in `budgets.json` (forcing the otherwise-passing `clean` test to fail and print `byFn`),
captured the artifact, then reverted the edit (`git diff packages/engine/budgets.json` is empty at
the end of this milestone). Results, still under forced `--no-opt --no-sparkplug`:

- `gc-sim clean`: `attributedBytesPerFrame.main = 0` (`bytesPerFrame.main` 21.49, all in `(V8 API)`/
  `next`/`isTypedArray`/`entries`/`values`/`evaluate`/`run@gc-page`/`innerSerialize` -- instrument
  overhead, none of it attributed and none of it `stepSimTickSync`).
- `gc-connected-terrain clean`: `attributedBytesPerFrame.main = 80.5` -- exactly this page's existing
  clean baseline (the same 80.50-80.52 B/frame the `main` software row's own formula already
  measured before this milestone), unchanged. byFn: `draw` 28800, `drain` 12000, `stepFrame` 7200,
  plus the same instrument-overhead tail; no `stepSimTickSync` entry.

**Re-run at rest and under forced interpreter (steps 3-4).** After the fix,
`GC_MODE=software pnpm test:slow -t "neg burst sim"` passes both under forced
`--no-opt --no-sparkplug` (`browser pass 5 tests 15s`) and, after reverting the config edit, at rest
(`browser pass 5 tests 7.2s`). `git status --short` at that point showed only
`packages/engine/src/test/client.ts` modified -- the diagnostic edits left no trace.

**No budget moved (step 5).** `gc-sim`'s software `main: 0` and `gc-connected-terrain`'s software
`main: 89` both pass unchanged with the allocation gone (measured above: 0 and 80.5, both already
under their existing budgets with existing margin). `budgets.json` has no diff in this milestone.

**Audit of the rest of `src/test/client.ts` (Scope's second bullet).** Traced every function a
zero-GC page's `drive()` calls per frame, across every `gc-*.ts` page
(`gc-sim.ts`, `gc-connected-terrain.ts`, `gc-terrain.ts`, `gc-topology.ts`, `gc-gen.ts`;
`gc-echo.ts`/`gc-input.ts`/`gc-sim-paced.ts`/`gc-loop.ts` call none of this file's functions from
`drive()` itself): `stepSimTickSync` (fixed above), `stepFrame` (called through `harness.stepFrame`
-- no closures; `clockLike.advance?.()` is an optional call, not a closure; `frameClocks.get`/`.set`
on an already-created `WeakMap` entry after the first call; this path was M15d's own subject and
stayed clean), and `asHarness`'s inline `stepTick()` (two plain indexed loops over a `tickTargets`
array and a `tickWant` `Int32Array` both preallocated once at `asHarness()` call time, already
carrying this file's own "reused every call" comment). `parkWorkers`/`resumeWorkers` are called once
per page at setup, before `installGcPage`, not from any page's `drive()` -- not on this audit's own
per-frame path, though `allEqual`'s doc comment already covers their own closure fix from a prior
milestone. No other per-call-closure shape found; `stepSimTickSync`'s `.some()` was the only
instance.

**Verification commands run (targeted, no `pnpm test`/`pnpm lint` -- Tyler is the gate):**
`pnpm --filter engine typecheck` (clean), `pnpm test unit` (`pass 157 tests`), `pnpm test browser`
(`pass 110 tests`, fast tier, both default and `GC_MODE=software`), `GC_MODE=software pnpm test:slow
-t "neg burst sim"` (before/after, above).
