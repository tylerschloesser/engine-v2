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

### Step 1: built, reproduces, and found the direction is larger than this brief

**Built** (per Order of work 1, "add a page or arm an existing one" -- armed the existing one):
- `TestFlags.pace?: boolean` (`packages/engine/src/worker/protocol.ts`): a new, additive test flag.
- `worker/sim.ts`'s gate changed from `if (!message.test) simHost.start()` to `if (!message.test ||
  message.test.pace === true) simHost.start()` -- purely additive; every existing page (`gc-sim`
  itself before this change, `topology`, `echo`, `gen`, `sim-worker`) never sets `pace`, so their
  behaviour is bit-for-bit unchanged (`!message.test` alone still gates them). This is the seam a
  follow-on brief should keep: it lets a page arm real pacing (`onFire` via `AtomicsTimer`) while
  `test` stays present, so `gcHook`/the parked test-call channel remain available too.
- `gc-sim.ts`: `test.flags` gained `pace: true`. `drive()` is unchanged (`stepSimTickSync(client,
  1)` still drives one deterministic tick per measured frame); arming `pace` on top of that is safe
  for this page specifically because it asserts allocation only, never a resulting hash -- an
  `onFire` catch-up racing a manual `stepTick` mid-run has nothing to corrupt here.

**Reproduces, confirming the defect is real and production-facing, not test-path-only:** rebuilt
(`pnpm --filter engine build` + `vite build --config packages/engine/tests/browser/pages/
vite.config.ts`; bundle hash changed, `gc-sim-DGfc5Pw3.js` -> `gc-sim-CX2A_hny.js`, confirming a
fresh bundle was measured, not a stale one).

- **Under default V8 (no forced tier), `pnpm gc -t "sim clean"`:** already fails, consistently, not
  intermittently -- 5 repeats (`--repeat-each 5 --workers 1`) read `sim` at 14.43, 14.41, 14.61,
  14.43 and (one outlier) 60.67 B/frame, all over the strict 8 B budget. `byFn` (the chosen, lower
  window) shows `runBlockingLoop@...:842: 7148`, `scope.onmessage@...:1315: 1232`,
  `poll@...:1219: 24`, `now@...:1054: 24`, `onFire@...:1142: 24` -- i.e. arming `simHost.start()`
  for real costs the `sim` isolate budget headroom **even without forcing the interpreter tier**,
  which the original (`runOneTickTimed`-only) defect never did on its own (it needed sibling-isolate
  contention or `--no-opt --no-sparkplug` to show up at all).
- **Under `--js-flags=--expose-gc --sampling-heap-profiler-suppress-randomness --no-opt
  --no-sparkplug`** (temporary edit to `packages/engine/playwright.config.ts`'s `gc` project,
  reverted immediately after this one measurement -- never left in the tree, per the brief's own
  instruction not to leave the `gc` project permanently launched with it): `sim` reads 60.45
  B/frame. `byFn.sim`: `timeoutMs@...:1227: 14280` (23.80 B/tick -- the same magnitude as the
  brief's own `runOneTickTimed` finding, but from a *different* function), `stepTick@...:1196:
  14220` (23.70 B/tick -- this is the brief's own already-known `runOneTickTimed` defect,
  reproduced again here), `now@...:1054: 6336`, `poll@...:1219: 768`.
- Full-suite run (`pnpm test`) stayed in the **fast tier's time budget** (`browser FAIL 95 tests
  20s/25s`) -- this is not a slow, real-wall-clock-paced reproduction; `drive()` still ticks
  deterministically and fast, `simHost.start()` firing `onFire` for real only incidentally (a
  handful of times, from ordinary CDP/setup latency already elapsing more than one 50 ms tick
  period before the measured window starts), which is enough to prove the `AtomicsTimer` code paths
  are live and costly without needing a real 30-second window.
- Cascading effect confirmed, not just the `clean` test: `sim neg object main` and other `sim neg
  *` tests also now fail, because `sim`'s own baseline already exceeds its budget independent of
  any control -- expected, and further evidence the defect is in `sim`'s own steady state, not
  something a control introduces.

**Why this is bigger than a "move two `clock.now()` reads into Rust" fix, and the step boundary
this stops at:** the brief's own Scope/Files-touched anticipated one source
(`SimHost.runOneTickTimed`, `server.ts`, confirmed above as `stepTick@...:1196`). Arming
`simHost.start()` for real -- exactly what Step 1 asked for, and exactly why Step 1 had to come
first -- surfaces a **second, independent, and comparably-sized** source that was never in the
brief's Files-touched list: `worker/atomics-timer.ts`'s `poll()`/`timeoutMs()`. Both read
`clock.now()` on every real wake (not every tick -- every wake of the blocking loop, `runBlockingLoop`
in `worker/shell.ts`, which calls `body()` then `timeoutMs()` before every `Atomics.wait`), and
`timeoutMs()` additionally computes a **float subtraction** (`nextFireAt - clock.now()`) and a
`Math.max`-shaped comparison on the result -- a "double-valued temporary on a per-pass path"
(`.claude/rules/hot-paths.md`'s own banned shape), not merely a raw clock read. The halving
experiment already established that even *one* raw `clock.now()` read per tick (11.92 B/tick) blows
the 8 B budget on its own; `timeoutMs()`/`poll()` together read the clock at least twice more per
wake and additionally materialise a fresh float from arithmetic on top, which is why their measured
cost (23.80 + a further 6336/600 B from `now`, plus `poll`'s own 768/600) is the same order of
magnitude as `runOneTickTimed`'s own two reads, not a rounding error next to it.

**This cannot be fixed by "relocating" the read into Rust the way `runOneTickTimed`'s two reads
plausibly can.** `Atomics.wait`'s timeout argument is a JS-side value that only JS can compute --
there is no WASM export that could compute it instead, because `Atomics.wait` is not something WASM
code can call. Two directions were considered and rejected as *this brief's* fix, both because they
are genuine redesigns, not relocations:
- **A WASM import for a monotonic clock** (the brief's own suggested fallback, "adding that import
  is in scope"). Analysis, not yet contradicted by a measurement because it would need the import
  built first to test: the import's own JS-side glue closure (`() => performance.now()`) is still
  an ordinary JS function, still subject to `--no-opt`/`--no-sparkplug`, and V8's WASM tiers
  (Liftoff/TurboFan-for-WASM) are governed by separate flags than JS's (Sparkplug/TurboFan-for-JS)
  -- forcing the JS tier down does not touch WASM code, but does still force the import's own glue
  function down. An import very plausibly does not remove the allocation under forced interpreter
  tier at all; it would only *relocate where the box is billed*, reproducing exactly the
  "guarantee that holds only when V8 wins a compilation race" problem 0016 §1 already rejects. This
  needs building and measuring to confirm either way, which is follow-on work.
- **A SharedArrayBuffer time source written by a non-strict isolate** (main thread, using the same
  "WASM reads times from its own region" pattern `worker/client.ts`'s `frame_time_ms` fix already
  established for the camera block): sound in principle, but has no natural periodic writer on a
  page with no render loop (every zero-GC page, and any backgrounded/paused-render single-player
  session), and coarsens `tickOverruns`/`ticksDropped` precision to whatever interval the writer
  runs at -- a real semantic change to what M13 built, needing the ADR the brief already flags
  ("Any change to what `tickOverruns` or `ticksDropped` counts... needs a new ADR amending M13's").
- A third option, noted for whoever writes the follow-on brief: stop deriving `due`/overrun from
  measured wall-clock deltas at all and instead treat "woken by an `Atomics.wait` timeout" itself
  (a fact `ControlBlock.waitForWake`'s own return already carries, not a fresh clock read) as "one
  tick is due" -- a naive fixed-interval scheme with no drift correction and no wall-clock-derived
  catch-up. This removes every remaining clock read but changes the pacing model itself, squarely
  the "timer redesigned rather than relocated" case the brief names as its own cut line.

**Decision: stop here, at the Step 1 boundary, per the brief's own instruction** ("If the direction
proves larger than this brief... stop at a step boundary and report: the orchestrator writes the
follow-on brief"). Steps 2-5 all depend on which of the above (or another) direction is chosen for
`AtomicsTimer`, which is a design decision, not an implementation detail this milestone's Scope
anticipated (`worker/atomics-timer.ts` is not in "Files, packages and crates touched").

**State left on `main`:** `gc-sim`'s `sim clean` test (and its `sim neg *` siblings) fail by design
-- this is Step 1's own deliverable, a reproduction that must exist and must fail before a fix can
be verified. `pnpm test`: `rust 235`, `unit 154`, `wasm 40` unchanged; `browser` now shows the
`sim`-isolate failures above (was 95 passing at the base commit). `pnpm lint`: unchanged, green
(biome, rustfmt, clippy, tsc all pass -- confirmed after this step's edits). No golden changed; no
budget in `budgets.json` changed (the existing `sim` entry's numbers are untouched -- the fix, not
the number, is what has to change here, per "Budgets": the strict worker figure is not negotiable).
