# M13b: Tick timing without a per-tick JS clock read

Status: not started · After: 13 · Tyler-dependent: no

## Goal
The sim worker runs a tick without reading the wall clock in JavaScript, so `tickOverruns` and
`ticksDropped` stay real while the tick loop allocates nothing whether or not V8 has optimized it.
`gc-sim`'s `sim` isolate holds its strict worker budget under every negative control, and CI stops
being intermittently red on `sim neg object main`, `sim neg burst main` and `sim neg burst sim`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0016-zero-allocation-assertion.md` (§1, §3)
3. `docs/decisions/0006-tick-rate-and-time.md` (all — `TickRate`, what a tick owes the clock)
4. `docs/plan/13-sim-host-tick-loop.md` (**Deviations** in full: `HostServices.timer`'s deadline
   shape, `runOneTickTimed`, `AtomicsTimer`, `stepSimTickSync`, which counters are live)

Rules that apply: `.claude/rules/hot-paths.md` (its "WASM reads times from its own region rather
than JS reading a `Float64Array` element and passing it" prescription is the direction here),
`.claude/rules/determinism.md` (wall-clock time must stay out of anything hashed).

## The defect (measured, not suspected)
`SimHost.runOneTickTimed` (`src/server.ts`) reads `services.clock.now()` twice per tick to count
overruns. `performance.now()` returns a fractional double, which V8 boxes into a fresh `HeapNumber`
on every read **whenever this code is running in the interpreter tier rather than optimized**.

Measured at the M14 gate, from a CI artefact's `windowByFn` plus a local repro:
- CI, `gc-sim`, `sim` isolate: `stepTick@worker-auto:1196` = 14304 B over 600 ticks = **23.84 B/tick**,
  exactly the reported `attributedBytesPerFrame.sim`. Strict worker budget is 8.
- Local repro, on demand: launch the `gc` project with `--js-flags=--no-opt --no-sparkplug` and run
  `pnpm gc -t "sim clean"` — identical 14304 B signature, so this reproduces without CI.
- Halving experiment: deleting one of the two `clock.now()` reads gives exactly 7152 B = **11.92 B/tick
  per read**. **One read alone still exceeds the budget of 8, so "read once instead of twice" is not
  a fix.**
- `Math.trunc()` on each read does not help (14304 → 14316): the box happens at the native-call
  return boundary, before any JS-side arithmetic can act on it.

Why it is intermittent rather than constant: `sim` shares one renderer process, and V8's background
compiler thread pool, with `main`/`client`/`gen0`. A busy negative control on a sibling isolate
plausibly starves `sim`'s TurboFan job during warm-up, so the measured window runs interpreted. That
trigger is a hypothesis; **the defect is not**. A zero-allocation guarantee that holds only when V8
wins a compilation race is not a guarantee (0016 §1), which is why this is fixed rather than waived.

**This is a production defect, not a test-path one — confirm that first.** `onFire`, the real pacing
path, calls the same `runOneTickTimed`. `AtomicsTimer` never arms on `gc-sim` (that page sets
`test.flags.gcHook`, so `simHost.start()` is never called), so no current zero-GC page exercises
`onFire` at all. Step 1 below closes that hole.

## Scope
- **Move per-tick wall-clock reading out of JS.** The recommended direction (see Planning decisions)
  is that the sim instance owns its own tick timing in Rust and maintains the overrun and dropped
  counters there, surfaced through the counters that `SimHost.counters()` already returns, so the JS
  tick loop reads no clock at all.
- Keep `tickOverruns` and `ticksDropped` meaning what M13 made them mean, or change the meaning
  deliberately in an ADR (below). Do not silently coarsen a counter.
- A zero-GC page that exercises the **real pacing path** (`onFire` via a started `SimHost`), not only
  the test-driven `stepTick` path, so this class of defect cannot hide behind `gcHook` again.
- Whatever ABI change the direction needs, with `ABI_VERSION` bumped and the `abi-registry` test
  updated in the same commit.

## Non-scope
The M06b **sibling-isolate nudge** (`.claude/skills/gc-test/SKILL.md`, "A target isolate's own
negative control can still nudge a sibling isolate's own reading") stays open and is not this
milestone's to close: it is a separate, documented phenomenon and the numbers here are fully
explained without it. Anything in M15's connection/replica work. Changing `budgets.json` numbers.

## Files, packages and crates touched
`packages/engine/src/server.ts`, `packages/engine/src/worker/sim.ts`, the sim host side of
`packages/engine/crates/engine` (`host/`, `abi/registry.rs`), a zero-GC page under
`packages/engine/tests/browser/` (+ its `budgets.json` entry, newly derived, not widened).

## Seams
**Provides:** whatever export the direction adds (name it in Deviations, `ABI_VERSION` bumped);
the new zero-GC page's name.
**Consumes:** M13 `SimHost`, `HostServices.timer`, `AtomicsTimer`, `runOneTickTimed`,
`stepSimTickSync`, `CB_SIM_STEP_REQ`, `host::Host<G>`, the counters export; M04 `zeroGcSuite`,
`installGcPage`, `budgets.json`; M06b `runBlockingLoop`, the worker kinds.

## Planning decisions
- **Direction: Rust owns tick timing.** `.claude/rules/hot-paths.md` already prescribes exactly this
  for exactly this reason, and M09b's `frame(t_ms)` set the precedent by moving the double out of JS
  entirely. Reading the clock in JS and passing the value across is what allocates; no amount of JS-side
  care removes the box, as the `Math.trunc()` result shows.
- **If Rust cannot reach a monotonic clock without a new host import**, adding that import is in
  scope — it is the cheapest correct answer and the ABI is being bumped anyway.
- **If the direction proves larger than this brief** (say it needs the timer redesigned rather than
  relocated), stop at a step boundary and report: the orchestrator writes the follow-on brief rather
  than letting this overrun.
- **Any change to what `tickOverruns` or `ticksDropped` counts is a changed decision** and needs a new
  ADR amending M13's (use the `write-adr` skill), because M13 wired them per-tick deliberately.

## Order of work
1. Add a zero-GC page (or arm an existing one) that runs the **real** `onFire` pacing path, and show
   it reproducing the allocation under `--js-flags=--no-opt --no-sparkplug`. **This is step 1 on
   purpose: it is the test that currently cannot fail, and until it exists a fix cannot be verified.**
2. Move tick timing into Rust; bump `ABI_VERSION`; update `abi/registry.rs` and the `abi-registry`
   test.
3. Counters stay live and correct: prove `tickOverruns` still counts a real overrun and
   `ticksDropped` a real drop, with a test that fails if the counter is wired to a constant.
4. Re-measure `gc-sim` and the new page, clean and under every negative control, in both GC modes.
5. Derive the new page's budget entry from measurement and write its `formula` string (0020 §9).

## Tests added
- The new zero-GC page's clean assertion plus its generated negative controls.
- A test that a real overrun increments `tickOverruns` and a real drop increments `ticksDropped`
  (M13 shipped these exercised only in unit tests; they must be real here).
- A regression test pinning the tick loop as clock-free in JS, in whatever form survives review —
  the point is that reintroducing a per-tick `clock.now()` fails a test rather than only CI, sometimes.

## Exit criteria
- [ ] The new page reproduces the allocation before the fix and holds its budget after, shown with
      `--js-flags=--no-opt --no-sparkplug` (paste both runs).
- [ ] `gc-sim`'s `sim` isolate holds its strict budget under `sim clean`, `sim neg object main`,
      `sim neg burst main` and `sim neg burst sim`, in software mode.
- [ ] `tickOverruns` and `ticksDropped` are proven live by a test that fails if they are constant.
- [ ] `ABI_VERSION` bumped, `abi-registry` updated, no golden changed without the orchestrator.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm gc software` · `pnpm gc flat` · `pnpm test` · `pnpm lint` · `pnpm test:slow -t "sim neg"`.

## Budgets
The strict worker figure of 8 B/frame is not negotiable here and is not to be widened (0028: the
strict worker figure has never moved). A new page's own entry is derived by measurement per 0020 §9.

## Context artifacts
A note in `.claude/skills/gc-test/SKILL.md`: a fractional-double clock read in a per-tick or
per-frame JS path boxes a `HeapNumber` in the interpreter tier, and `--js-flags=--no-opt
--no-sparkplug` reproduces that class of defect on demand. That recipe found this defect and is the
first thing to try for the next unreproducible CI-only zero-GC finding.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
