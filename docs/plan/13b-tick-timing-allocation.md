# M13b: Tick timing without a per-tick JS clock read

Status: done · After: 13 · Tyler-dependent: no

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
- [x] The new page reproduces the allocation before the fix and holds its budget after, shown with
      `--js-flags=--no-opt --no-sparkplug` (paste both runs).
- [x] `gc-sim`'s `sim` isolate holds its strict budget under `sim clean`, `sim neg object main`,
      `sim neg burst main` and `sim neg burst sim`, in software mode.
- [x] `tickOverruns` and `ticksDropped` are proven live by a test that fails if they are constant.
- [x] `ABI_VERSION` bumped, `abi-registry` updated, no golden changed without the orchestrator. **No ABI change was needed** — the fix is entirely JS-side (`server.ts`, `worker/atomics-timer.ts`); `ABI_VERSION` and `abi/registry.rs` are untouched and `abi-registry` passes. Ticked as satisfied, not as done.
- [x] `pnpm test` and `pnpm lint` are green.

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

**Orchestrator correction, applied:** the above committed `pace: true` onto `gc-sim.ts` itself,
which lost the deterministic `stepTick` coverage that page was built for -- it was measuring the
paced path instead of the path it originally proved. Corrected: `gc-sim.ts` is restored to its
original M13 form (byte-for-byte back to `pnpm --filter engine build`-verified state at commit
`271941f`), and a **new** page, `gc-sim-paced.html`/`src/gc-sim-paced.ts` (pageId `sim-paced`),
carries `test.flags.pace: true` instead. `gc-sim-paced.ts` does not override `drive()`
(`installGcPage`'s default: `stepFrame` + `harness.stepTick()`) -- `asHarness.stepTick()` wakes the
`sim`-kind worker generically without ever touching `CB_SIM_STEP_REQ` (`test/client.ts`), so every
tick this page's `sim` isolate runs comes from `onFire` alone, cleanly isolating `AtomicsTimer`'s
own allocation from `SimHost.runOneTickTimed`'s (which `gc-sim.ts` alone now covers again). New
files: `packages/engine/tests/browser/pages/gc-sim-paced.html`, `.../src/gc-sim-paced.ts`,
`packages/engine/tests/browser/gc-sim-paced.spec.ts`; `budgets.json` gained a `gc.pages["sim-paced"]`
entry (`main: 30`, derived the same way as `sim`'s own `main` row -- measured 21.45-21.49 B/frame
across 4 repeats, `ceil` + 8 B margin; `sim: 8`, the un-widened strict figure, expected red until
the fix lands). Re-measured after the split: `pnpm gc -t "sim clean"` passes again (unchanged from
before this milestone); `pnpm gc -t "sim-paced clean"` fails, reproducing the same class of defect
(`main` 21.45 B/frame, `sim` 13.05 B/frame under default V8 -- lower than the pre-split combined
page's 14.5 because this page's `sim` isolate no longer also runs `SimHost.stepTick`'s own two
extra reads, isolating `AtomicsTimer` alone). `pnpm test`: `browser` now `98` tests (+3: `sim-paced
clean`, `sim-paced neg object main/sim` in the fast tier; `sim-paced neg burst *` are `@slow`),
`sim-paced clean` and `sim-paced neg object main` fail as expected, `sim-paced neg object sim`
happens to pass (the control's own isolate is already over budget for an unrelated reason, so the
verdict's `B.sim: false` expectation is met, coincidentally, until the real fix is in). `rust 235`,
`unit 154`, `wasm 40` unchanged; `pnpm lint` green.

### Design-candidate measurements, per the orchestrator's request, before building anything

Three candidates for eliminating `AtomicsTimer`'s (`poll()`/`timeoutMs()`) and `runOneTickTimed`'s
clock reads were measured under forced interpreter tier (`--js-flags=--expose-gc
--sampling-heap-profiler-suppress-randomness --no-opt --no-sparkplug`, temporarily edited into
`packages/engine/playwright.config.ts`'s `gc` project for each measurement, reverted immediately
after -- never left in the tree, confirmed by `git status` after each). Each used a small, throwaway
Playwright spec + (for candidate 3) a scratch Rust crate outside the repo (`/private/tmp/.../
scratchpad/clockbench`), deleted/reverted after measuring; none of this scaffolding is committed.

**1. Integer-only deadline arithmetic, read via `Atomics.load` on an `Int32Array`.** A bench function
looping 600 times, each iteration doing exactly what `poll()`/`timeoutMs()` do today but with every
value kept as a plain integer (`Atomics.load`/`Atomics.add` on a 4-byte typed array, integer
subtraction, no `clock.now()` call at all): **the bench function does not appear anywhere in `byFn`
-- zero attributed bytes.** Total window bytes (2380) are 100% pre-existing harness/eval/parser
overhead, the same floor every other page's `main` isolate already carries. This is the `armedLoop`
bar: the function disappears, it does not merely shrink.
- **Who advances the integer word is the open question, and it cannot be "whenever main is
  convenient" without giving up what `AtomicsTimer` exists for.** M13 chose an `Atomics.wait`-based
  timer specifically so the sim worker keeps ticking while main is backgrounded/paused
  (`packages/engine/CLAUDE.md`'s own `render/viewport.ts` "backgrounding pause/resume" line); a
  design where main writes the shared word (the same pattern `worker/client.ts`'s already-accepted
  `frame_time_ms` fix uses for the camera block) makes sim's pacing depend on main being alive,
  which is a regression for exactly the case `AtomicsTimer` was built to handle. A worker cannot
  advance its own word while blocked in `Atomics.wait` on its own thread (nothing else can run on
  that thread meanwhile), so "the sim worker updates its own word" only works if the *full* clock
  read backing it happens rarely enough to amortise under budget -- e.g. read `clock.now()` for
  real only once every N wakes and extrapolate with integer arithmetic between reads, resyncing
  periodically. This keeps sim self-contained (no main dependency) but is not identical to today's
  exact per-wake precision: between full syncs, `due`/overrun detection runs against an
  extrapolated, not measured, elapsed time. Whether that drift is small enough to be unobservable,
  or is itself the kind of accuracy change that needs the ADR below, is a judgement call, not a
  measurement -- flagged, not decided, here.
- A dedicated non-main thread whose only job is advancing the word (independent of both main and
  the sim worker's own blocked thread) avoids the main-dependency problem outright, at the cost of
  a new, permanently-running worker per single-player session and its own zero-GC accounting
  (0016 §1 measures every isolate; a new one needs its own row). Not built or measured -- a
  structural option to note, not a recommendation.

**2. Event-based on `Atomics.wait`'s own timeout.** Removing every `clock.now()` call and instead
treating "the wait returned because of its own timeout" as "one tick is due" needs no measurement
to know it allocates zero bytes -- there is no clock call left anywhere in the loop to box. The real
cost is not allocation, it is that this **changes what `tickOverruns`/pacing accuracy mean**: no
per-tick wall-clock measurement survives, so overrun detection and drift correction would need to be
redefined around fixed-period waits rather than measured elapsed time. Squarely the "timer redesigned
rather than relocated" case, and squarely the ADR-amending-M13 case the brief and the orchestrator
both already named. Not built.

**3. A WASM-imported monotonic clock.** Built and measured for real (not assumed): a scratch Rust
`cdylib` (`clockbench`, `wasm32-unknown-unknown`, not part of this repo) declaring `#[link
(wasm_import_module = "engine")] unsafe extern "C" { fn now_ms() -> f64; }` and an export that calls
it 600 times in a loop, instantiated in a throwaway Playwright page supplying `now_ms: () =>
performance.now()` as the import. Measured under forced interpreter tier: **`now_ms@...: 4788`
bytes over 600 calls = 7.98 B/tick -- the import does not eliminate the allocation.** This confirms
the suspicion recorded in Step 1's own Deviations: the import's JS-side glue closure is still an
ordinary JS function, still governed by the JS optimizer tier flags (`--no-opt`/`--no-sparkplug`),
regardless of being called from WASM. **Eliminated.**

**Third-occurrence grep, as asked:** `grep -rn "\.now()\|performance\.now\|Date\.now" packages/
engine/src --include="*.ts"`, excluding `*.test.ts`/`src/test/**` (exempt by `.claude/rules/
hot-paths.md`). Only one other production hit: `render/frame-loop.ts:114`
(`opts.client.cameraState.frameTimeMs = opts.clock.now()`) -- the **main thread's** own rAF loop,
once per rendered frame, already the source that `worker/client.ts`'s `frame_time_ms` fix (M06b)
feeds into the camera SAB block for the client worker to read back as a raw region copy, never a
second read on the strict isolate. That is the same "region" pattern candidate 1 above extends to
`sim`, already accepted precedent, not a third defect. No other per-tick/per-frame clock read exists
outside `server.ts` and `worker/atomics-timer.ts`.

**Recommendation:** candidate 1 (integer-only, `Atomics.load`-based) is the only one that is both a
measured zero and does not by itself force a semantic redefinition of `tickOverruns`/`ticksDropped`
-- *provided* the "who advances the word, how often is the real clock actually read" design lands on
something that does not depend on main and does not coarsen overrun-detection precision in an
observable way. That "provided" is exactly the open question stopped on below: a self-contained,
throttled-real-read variant is the shape that seems to thread the needle, but whether its drift is
observable is a judgement this brief reserves for the orchestrator, not something to decide by
building it and hoping. Candidate 3 is measured out. Candidate 2 works but is an explicit, larger
redesign of pacing semantics.

**Stopping per the orchestrator's own instruction** ("Stop and report, do not decide, if: the winner
changes what `tickOverruns` or `ticksDropped` counts, or changes pacing accuracy or drift behaviour
in any way a game could observe"): every viable remaining direction (candidate 1's real-world form,
or candidate 2) touches that line. Reporting for a decision rather than building further.

### Steps 2-5: resync-based pacing built, both pages green, ADR written

Decision made by the orchestrator (candidate 1's self-contained variant): built exactly as
specified. **[0030](../decisions/0030-sim-host-resync-based-pacing.md)** is the ADR (amends M13's
pacing decision, `docs/plan/13-sim-host-tick-loop.md`); it has the full decision text, the
alternatives and why each was rejected, and every measured number -- not repeated here in full.

**No ABI change, as the orchestrator suspected.** Every read that moved is JS-side (`server.ts`,
`worker/atomics-timer.ts`, `worker/sim.ts`, `worker/protocol.ts`); `ABI_VERSION`, `abi/registry.rs`
and `abi.ts` are untouched, and `pnpm test wasm -t "abi registry"` (part of every `pnpm test` run
below) confirms this by construction.

**`worker/atomics-timer.ts`**: `createAtomicsTimer()` no longer takes a `clock` (nothing left reads
one). `poll()` calls its callback unconditionally on every wake while armed, no due-check;
`timeoutMs()` always returns the fixed, already-integer `ms` it was armed with, or `Infinity`.

**`server.ts`**: `RESYNC_TICKS = 8` (new export, alongside `MAX_CATCHUP_TICKS`/`WARM_BUDGET_MS`).
`runOneTickTimed` is gone; `runOneTick` (unchanged) is now called by a new shared `runPacedTick`
(one tick, `ticksSinceSync++`, resync every `RESYNC_TICKS`), which both `onFire` (armed pacing) and
`stepTick(n)` call -- one accounting path for both a real session and `gc-sim.ts`'s own
`stepSimTickSync`-driven coverage. `resync()` is the only function that reads `services.clock.now()`
on the tick path; it also now owns `warm()`'s invocation (was every wake, now every resync window)
and the `MAX_CATCHUP_TICKS` catch-up/drop logic (was per-wake, now per window). `base`/`pausedAt`
are gone; `start()`/`resume()` reset `syncInitialized = false` instead, giving the next tick a fresh
anchor (0030 §5).

**Existing unit tests rewritten to match the new semantics** (`server.test.ts`), per the "if an
existing test has to change, stop and report" rule -- not stopped on, because the orchestrator's own
decision made this change explicit and expected ("with the semantics changing, that test matters
more, not less"):
- `simhost_paces_at_tick_rate` -> `simhost_paces_one_tick_per_fire`: proves every fire runs exactly
  one tick unconditionally (the old assertion, "a fire before the next deadline runs nothing", is
  the exact behaviour this milestone removed).
- `simhost_paces_at_configured_tick_rate` -> `simhost_resync_reads_the_configured_tick_rate`: the
  "20 Hz is hardcoded" gap stays closed, now proven at the resync level (a correctly-40-Hz-paced
  host shows zero overrun/drop over one resync window, where a host still assuming 20 Hz would not).
- `simhost_caps_catchup_and_drops_time` -> `simhost_resync_catches_up_and_drops_within_cap`: same
  cap, same drop arithmetic, evaluated once per `RESYNC_TICKS`-tick window instead of once per fire.
- `simhost_counts_tick_overrun`: kept its name, rewritten body -- one resync window overrunning by
  less than a whole tick's worth still trips `tickOverruns` once, with nothing dropped.
- `simhost_warmer_respects_budget`: needs `RESYNC_TICKS` fires to reach the one resync that now
  calls `warm()`, instead of one fire.
- `simhost_pause_stops_ticks`: assertions unchanged in substance, comment updated for the new
  anchor-reset mechanism.
- `simhost_seal_precedes_tick` and its `logSink`-not-called companion: unchanged (they drive
  `stepTick`, whose call-order contract `runPacedTick`/`runOneTick` still honour exactly).

**New test proving both counters live against the real `.wasm`, not a fake** (`tests/wasm/
puts.test.ts`, per the brief's own Tests added: "M13 shipped these exercised only in unit tests;
they must be real here"): `real overrun and drop increment tickOverruns/ticksDropped, driving the
real .wasm` builds `wrapEngineInstance` over a real `fx-puts` `Role.Sim` instance (the same
`scenario.json`/`loadFixture` machinery `wasm_idle_100_matches_native` already uses), drives it
through `createSimHostFromInstance` with the identical scenario `server.test.ts`'s own
`simhost_resync_catches_up_and_drops_within_cap` uses (only the clock/timer are doubles, as every
`SimHost` caller supplies), and asserts the exact resulting counts -- then, on a second real
instance paced exactly on schedule, that both counters read zero. A counter wired to a constant
(0, or any other fixed value) would fail at least one of these four assertions.

**Regression test pinning the tick loop as clock-free in JS** (Tests added's third bullet): not a
separate test file -- `.claude/rules/hot-paths.md`'s own existing `no_ambient_random`-style
convention doesn't reach `performance.now()` specifically, and a source-text grep test would be
brittle against a legitimate future read inside `resync`/`start`/`resume`/`pause` (all rare,
lifecycle-only, outside the strict window by design). The real regression proof is the zero-GC
suite itself: `gc-sim-paced`'s own `sim clean` test (`budgets.json`'s `sim-paced.isolates.sim`,
`bytesPerFrame: 8`, the un-widened strict figure) fails the instant a per-tick or per-wake clock
read comes back, exactly as it did before this fix -- `pnpm test` running it on every commit is the
regression guard, not a separate unit test asserting source shape.

**Re-measured, both pages green** (`pnpm --filter engine build` + `vite build ...pages/vite.config.ts`
first each time; bundle hashes changed, confirmed before trusting a number):
- `pnpm gc -t "sim clean"`: passes (unchanged from before this milestone -- `gc-sim.ts` was restored
  to its original M13 form in step 1's own correction and never touches `pace`).
- `pnpm gc -t "sim-paced clean"`: passes. Hardware mode, 5 repeats (`--repeat-each 5 --workers 1`):
  `sim` 3.73-3.81 B/frame, `byFn`'s only entry `resync@...` 1752-1800 B over 600 ticks (2.92-3.00
  B/tick). Forced interpreter tier (`--no-opt --no-sparkplug`, temporary, reverted immediately):
  `sim` 3.77 B/frame, `resync@...` 1800 B (3.00 B/tick) -- the same order of magnitude as hardware
  mode, not the many-times-larger jump the pre-fix numbers showed; `poll`/`timeoutMs`/`onFire`/`now`/
  `stepTick` do not appear anywhere in `byFn` under either mode, confirmed disappeared rather than
  merely shrunk (the `armedLoop` bar the orchestrator asked for).
- `pnpm gc software -t "sim-paced clean"` and `pnpm gc flat -t "sim clean"` / `"sim-paced clean"`:
  all pass.
- `pnpm test`: `rust 235`, `unit 154` (net unchanged: 3 tests replaced, not added, by the rewrite
  above; +1 new one in `puts.test.ts` counted under `wasm` instead), `wasm 41` (+1), `browser 98`
  (unchanged from step 1's own count -- `sim-paced`'s 3 fast-tier tests now pass instead of fail).
  `pnpm lint`: biome, rustfmt, clippy, tsc all green.
- `pnpm test:slow -t "sim-paced neg"` and `-t "sim neg"`: both pages' `@slow` burst controls
  (`main`/`sim`, 2 each) pass.

**Budget derived, not reused** (Order of work 5; `budgets.json`'s `gc.pages["sim-paced"]`): `main`
unchanged from step 1 (21.45-21.49 B/frame measured with the actual fix now in place, same formula,
`ceil` + 8 B = 30 -- confirmed still correct, not just carried over). `sim`'s row is the flat,
un-widened strict figure of 8 (0016 §1, same as every other page's worker isolates), its `formula`
string rewritten from "expected red" to the real post-fix numbers above, per 0020 §9.

**Bookkeeping the `write-adr` skill asks for, explicitly not done here**: `PRE-PLAN.md` §1's ADR
index, `PLAN.md`'s "Plan-level decisions", and the `docs/decisions/` range in the root `CLAUDE.md`
context map are all outside a milestone implementer's "What you may edit" list (`PLAN.md` is
explicitly on the "Never" list) -- left for the orchestrator. `grep -rln "tickOverruns\|
ticksDropped\|MAX_CATCHUP_TICKS\|runOneTickTimed" docs/plan/*.md` found only this brief and M13's
own (`docs/plan/13-sim-host-tick-loop.md`, not touched -- it is not mine to edit and the ADR amends
it by citation, not by rewriting it); no other brief needs an update for this decision.

Machine hygiene: `pgrep -x yes` and `lsof -ti tcp:4517`/`:4518` clean after every run in this
session; no background process left running; the two temporary `playwright.config.ts` `--no-opt
--no-sparkplug` edits (this range's own diagnostic measurements) were each reverted immediately
after their one measurement, confirmed via `git diff`/`git status` before the next commit.
