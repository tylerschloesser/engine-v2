---
name: gc-test
description: Run and read the engine's zero-allocation ("gc") assertion for a browser page -- clean measurement plus permanent negative controls (docs/decisions/0016). Use when asked to check a page for allocation/GC regressions, add a new zero-GC test, change a budget in packages/engine/budgets.json, or debug a failing `gc-loop`-style test.
---

# gc-test

The zero-GC assertion of `docs/decisions/0016-zero-gc-definition.md` §3: per isolate, zero
`MinorGC`/`MajorGC` trace events in a stepped window (assertion A) and exact sampled allocation
bytes within a budget (assertion B), plus unchanged WASM memory. Every page that calls
`installGcPage` (`packages/engine/src/test/gc-page.ts`) and has a `gc.pages.<id>` entry in
`packages/engine/budgets.json` gets a generated suite: one `clean` test and permanent negative
controls that must fail on the named isolate and nowhere else
(`packages/engine/tests/browser/gc/suite.ts`'s `zeroGcSuite`).

**Tiers (gate round 3, docs/decisions/0026):** `gc-loop` keeps every negative control (`object`,
`burst`, `post-message`) in the fast tier -- it is the harness's own reference page, so this is what
proves both instruments are still live on every `pnpm test`. Every other page's per-isolate `burst`
negatives are tagged `@slow` by `zeroGcSuite` itself (by page id, not a caller option); `object`
negatives stay fast for every page. What the fast tier loses -- "instrument A looks at this page's
thread X" -- the `clean` test now asserts directly: `r.presentIsolates` (from `analyseTrace`) must
contain every isolate the page's budget names, failing by name if the trace never discovered that
isolate's thread at all (not merely saw zero GC events there).

## When to run it

- A change touched anything in the hot path of a measured page: the harness (`src/test/harness.ts`,
  `harness-worker.ts`), the loader (`src/loader.ts`), or a page's own per-frame/per-tick code.
- Adding a new zero-GC page (see "Adding a page" below).
- Debugging a red `gc-loop`-style test in `pnpm test browser`.

Day to day this runs as part of `pnpm test browser` (the `gc` Playwright project runs alongside
`chromium`/`webkit`/`firefox`): `pnpm test browser -t gc-loop` runs just `gc-loop`'s clean test, its
negative controls and the flat-transport parity test (the pattern also matches the spec file name).
`pnpm gc` (below) is for local iteration and the slow/environment-varying modes `pnpm test` never
runs itself.

## Reading a failure

The failure message is JSON: `control` (which negative control, if any), `mode` (`hardware` or
`software`), `bytesPerFrame`/`attributedBytesPerFrame` per isolate, `gc` (per-isolate `MinorGC`/
`MajorGC` counts), `byFn` (top 8 allocation sites by bytes, per isolate -- this is where "who
allocated" comes from), `windowBytes` (both measured windows' own totals per isolate, `[first,
second]`; `bytesPerFrame` divides the *lower* of the two -- docs/decisions/0028), and `verdict`
(`{ pass, A, B }` per isolate) next to the expected verdict Vitest/Playwright's own diff shows. Read `byFn` for the isolate(s) the verdict named: the top
function name plus its `file:line` is almost always the fix. Artefact paths (Playwright's own trace
etc.) print under the failure block same as any other browser test; nothing gc-specific lands
outside `test-results/`.

**Usual causes**, roughly in the order they show up in `byFn`:

- A new `Uint8Array`/view created per frame or tick instead of reused from init (`.claude/rules/
  hot-paths.md`): `subarray()`, `slice()`, `new Uint8Array(...)` anywhere in the hot path.
- A closure, spread, destructure-into-object, or `Array.prototype` callback (`.filter`/`.map`/
  `.forEach`) built fresh each call instead of precomputed once. `harness.ts`'s own `byRole` was
  exactly this (`all().filter(...)` every `stepTick`/`stepFrame`) until M04 fixed it -- grep
  `byFn`'s top entry's function name in the built page bundle
  (`packages/engine/tests/browser/pages/dist/assets/*.js`, `pnpm test`'s `pages` build step) if the
  source alone doesn't make the allocation obvious.
- `engine.log` called inside the measured window (compiled out below `warn` in release, but the
  fixture crates used here are dev-profile).
- A bundler eliminating your own negative-control code, not the page under test: if a *new*
  negative control refuses to trip, check the built chunk for an empty `if`/`for` body before
  assuming the harness is broken -- Vite's production build runs real Rollup tree-shaking, and a
  write to an unread local variable is exactly the shape it removes (`src/test/controls.ts`'s own
  `sinkHolder` comment has the story; write through a `globalThis` property, not a bare `let`).
- A one-off V8 JIT code-installation burst, *not* your allocation: a fixed multi-KB lump (13-16 KB
  is typical for a worker) that does not scale with frames and is billed to whichever JS frame
  happened to be executing -- measured on `waitForWake`, `runBlockingLoop`, `body`, `call1`, `load`
  and `scope.onmessage` for one isolate of one page. Fingerprint it in the raw
  `HeapProfiler.stopSampling` payload: a contiguous run of `profile.samples` ordinals with sizes
  like 6272/3580/1556/344 (an instruction stream and its metadata), instead of ~600 small samples
  spread over the window. docs/decisions/0028 is why assertion B takes the lower of two windows;
  if one of these shows up anyway, `windowBytes` will show the two windows far apart, and no amount
  of extra warm-up will move it (six settings measured in M11 fix round 3 -- each relocates it).
- Interpreter-tier boxing in code that lives blocked in `Atomics.wait` and may never tier up: a
  property read of `Number.POSITIVE_INFINITY`, a `Float64Array` element read, or a
  `TypedArray.prototype.byteLength` getter each box a fresh `HeapNumber` on a normal pass
  (`docs/plan/06b-workers-and-spawn.md`, Deviations "fix round 2, second pass"). Fingerprint by the
  method, not just the shape: `bytesPerFrame × frames ÷ wakes ≈ 12-16 B` means one
  `HeapNumber` per pass (fix the boxing site); a fixed delta once per window (e.g. 136 B) means a
  one-off such as lazy-feedback allocation (see "Warm-up is 8 passes" below), not a per-pass box.

## Adding a page

1. A page under `packages/engine/tests/browser/pages/` that calls `installGcPage(harness, opts?)`
   after building its `Harness` (see `gc-loop.ts`; `opts.drive` is optional, default `stepFrame` +
   `stepTick`). A page over a real `createClient()` result (not the M03/M04 harness) uses
   `asHarness(client)` (`src/test/client.ts`) to get a `Harness`; see "Production-topology pages"
   below for the two things that differ.
2. A `gc.pages.<pageId>` entry in `packages/engine/budgets.json`: `isolates` (one entry per isolate
   the page's `ready.isolates` lists, always including `main`), `software` (`null` until a real
   number exists for that page, per 0016 caveat b).
3. A spec file named `gc-*.spec.ts` under `packages/engine/tests/browser/` calling
   `zeroGcSuite({ pageId, path, expectAdapter? })` -- `expectAdapter: true` once the page has a real
   WebGPU adapter (0016 §1's 110 B main floor only applies then; see budgets.json's own `formula`
   strings for how `gc-loop`'s numbers were derived without one).

That's the whole registration; `zeroGcSuite` reads the isolate list and generates clean + every
negative control from the budget entry alone.

### Production-topology pages (`asHarness`, M06b)

`gc-topology.ts`/`gc-echo.ts` are the model: a page building a real `createClient()` result instead
of the M03/M04 harness. Two differences from a harness page:

- **Park before `__pageReady`.** A production worker enters its blocking loop right after `ready`
  (the M03/M04 harness starts idle instead, only entering its loop on the first `resume()`), so it
  is unreachable by CDP the instant the page is ready unless the page itself calls `await
  parkWorkers(client)` before setting `window.__pageReady = true`. Skipping this hangs `measure()`'s
  own isolate-naming step (`Runtime.evaluate` on a blocked worker never returns) rather than failing
  fast -- if a new production-topology page's `gc-*.spec.ts` test times out at 30 s with no other
  clue, check this first.
- **No `post-message` control.** A production worker kind body cannot call `performance.mark`
  itself (`.claude/rules/hot-paths.md`) and this milestone added no new `postMessage` type to ask
  one to; `instrument.ts`'s `measure()` marks every worker isolate through a CDP `Runtime.evaluate`
  of `self.performance.mark(...)` directly instead (`main` still marks itself through
  `page.evaluate()` -- routing `main` through a second CDP session too retained `PerformanceMark`
  objects server-side and pushed `gc-loop`'s own `main` reading over budget). For the same reason
  there is no message-driven tick to test: pass `zeroGcSuite({ ..., controlKinds: ['object',
  'burst'] })` to skip the generated `post-message` negative controls.
- **Warm-up is 8 passes, not one, and that matters (M06b fix round 3).** `measure()` drives
  `WARMUP` frames as `WARMUP_PASSES = 8` separate `run()` calls. The per-frame work is warm after
  one long pass, but `run()`'s own entry and exit -- resume, the worker's loop invocation, its two
  `post()` calls, park -- runs once per pass, and with a single pass the measured window was that
  path's *second* invocation, right at V8's lazy-feedback-allocation threshold. Its feedback vector
  (28 B + 108 B) then landed inside the window on about a third of runs: exactly the 136 B
  `gc: flat transport parity` kept catching on `sim`. Fingerprint for this class: a byte total with
  two stable values a small constant apart, no per-frame scaling, and `profile.samples` (the raw
  `HeapProfiler.stopSampling` payload, one entry per allocation under
  `--sampling-heap-profiler-suppress-randomness`) differing by one or two samples in a function that
  allocates nothing. Confirm it with `--js-flags=--no-lazy-feedback-allocation`: if the spread
  disappears, it is feedback timing, not your code.
- **Warm up longer than 8000 frames if the numbers look noisy, but check for a real bug first.**
  `measure()`'s `WARMUP` constant is 8000 (raised from `gc-loop`'s original 120 for every page: the
  production `yield`-protocol shell is a deeper call chain that needs more to reach steady optimised
  code, and this did not move `gc-loop`'s own numbers). Before raising it further, or reaching for a
  bigger budget, check `byFn` for a native-builtin bucket (`next@:0`, `values@:0`, or similar) that is
  near-zero on a quiet run and tens of KB on a contended one: that shape is "one site that only
  allocates while waiting" (M06b fix round 2 found two -- `parkWorkers`/`resumeWorkers`'s poll
  predicate allocating a fresh closure and calling `Array.prototype.every` on every tick instead of
  once per call, and `ManualClock.fireDue` building a `Map` iterator every `advance()` call even with
  zero timers registered), not JIT tiering, and no warm-up count fixes it -- fix the allocation site.
  A repeatable local reproduction that does not need another Playwright project running: `pnpm exec
  playwright test --config packages/engine/playwright.config.ts --project gc --grep <page> --workers
  3 --repeat-each 4`.
- **`did not ack the frame request` / `no response from the client worker` is a lost wake, not
  contention.** A production worker that never runs after a resume leaves main spinning out its
  2e9-iteration limit. M06b fix round 3 fixed one such race in the `yield` protocol (the wake-word
  baseline was read after `W_PARKED = 0` was published, so a wake in that window was lost:
  `Shell.observeWake`, `src/worker/shell.ts`). If this comes back, suspect another publish-then-read
  ordering before blaming the machine.
- **A `parkWorkers`/`resumeWorkers`/`untilQuiescent` timeout, or a `stepFrame`/`stepSimTickSync`/
  `asHarness.stepTick` ack-spin timeout, now names the worker (M16e, docs/plan/
  16e-park-timeout-diagnosis.md).** Every one of these waits rejects/throws with the same shape:
  `<what>: timed out after <limitMs> ms (turns=<n>, elapsedMs=<n>, longestGapMs=<n>)
  workers=[{"isolate":"client","W_YIELD":0|1,"W_PARKED":0|1,"W_WAKE":<n>,"W_ACK":<n>,"dead":
  false|true}, ...]` -- one entry per spawned worker, `dead` meaning `W_READY === Ready.Dead`
  (`shell.fatal` already ran). Read `W_WAKE` vs `W_ACK` on the named worker first: `W_ACK` frozen
  below `W_WAKE` is a worker stuck inside its own `body()` or a lost wake (`worker/shell.ts`'s
  `observeWake`/`lastSeen` discipline, the M06b fix round 3 class of bug -- see the bullet above);
  `dead: true` is a trap that reached `shell.fatal`; both `W_WAKE`/`W_ACK` moving normally on every
  worker but the wait still timing out is main's own poll/spin starved (`turns`/`elapsedMs` for
  `pollUntil`, `elapsedMs` alone for a spin -- a spin has no macrotask "turns", so `longestGapMs`
  there just repeats `elapsedMs`). `pollUntil` (`parkWorkers`/`resumeWorkers`/`untilQuiescent`) keeps
  its 10 s bound; the three ack-spin sites additionally bound themselves to 20 s wall-clock (checked
  every ~1.05 M spins, so a healthy ack -- normally a handful -- never pays for the check) on top of
  the older 2e9-iteration `SPIN_LIMIT` fallback, so a `window.__gc.run` call that reaches one of them
  fails with this message well inside Playwright's 30 s test timeout instead of a bare "Test timeout
  of 30000ms exceeded" with no other clue. If a bare 30 s timeout still shows up with *none* of this
  message, the stall is outside these waits entirely -- a raw CDP round trip in `measure()`
  (`Runtime.evaluate`/`HeapProfiler.*`/`Tracing.*`, `tests/browser/gc/{instrument,sessions,
  cdp-flat}.ts`) has no bounded timeout of its own; M16e reproduced exactly this once, under an
  artificially extreme ~40-way Chromium process oversubscription (`--workers 14 --repeat-each 3` on
  a 14-core machine), and left it unaddressed (different subsystem, not this milestone's files).
- **Finding a stalled worker's real position: `Debugger.pause` over CDP, not code reading (M17c,
  docs/plan/17c-client-park-stall.md).** `W_WAKE`/`W_ACK` alone cannot always tell (a) a worker stuck
  inside its own `body()` from (b) a lost wake: for `client`, `W_ACK` stores `CB_FRAME_REQ`'s own
  *value* (idempotent, re-stored every wake whether or not the frame request changed), not a wake
  tally, so "W_ACK frozen below W_WAKE" can be entirely normal (`sim`/`gen0` genuinely do get more
  than one wake per driven frame: `asHarness.stepTick` wakes every `sim`/`gen` target once, and
  `stepSimTickSync` wakes `sim` again). To see what a worker is *actually doing* while its own
  `parkWorkers`/`resumeWorkers`/ack-spin is stuck, attach a CDP session to that worker's own target
  (`tests/browser/gc/sessions.ts`'s `TunnelSession`, extended with an `onEvent(method, cb)` for
  unsolicited events -- `Target.receivedMessageFromTarget` carries both responses, keyed by `id`, and
  events, keyed by `method`, and the tunnel only forwards the former by default) and call
  `Debugger.enable` then `Debugger.pause`: this interrupts a worker blocked in `Atomics.wait` itself
  (a plain `Runtime.evaluate` does not, per the bullet above) and fires `Debugger.paused` with a real
  `callFrames` stack, `functionName`/`location` included; `Debugger.evaluateOnCallFrame` can then read
  that frame's own locals (`waitForWake`'s `index`/`last`, `sab/control.ts`) against the live SAB
  words. Found this way, live, against a real `zero_gc_action neg object main` occurrence: the
  `client` isolate was genuinely inside `ControlBlock.waitForWake`'s own `Atomics.wait`, reached
  through `Shell.resume()` -> `runBlockingLoop` -> the worker's own `scope.onmessage` (`worker.ts`) --
  not stuck inside `body()` or any pump, not dead. Diagnostics built this way are temporary and
  reverted (a `wake()` call is a hot-path primitive, `.claude/rules/hot-paths.md`); the finding they
  produce is what's permanent.
- **A park signal can be missed by `runBlockingLoop`'s own first wait after `resume()` (M17c, fix
  round 2).** A worker that has *not yet* re-entered `Atomics.wait` when a producer's `wake()` runs
  always recovers on its own -- `Atomics.wait`'s own check-then-sleep is atomic, so if the word
  already differs from what it is told to wait for, it returns immediately instead of blocking -- so
  a plain "was the notify missed" theory does not hold up (an earlier round of this milestone
  guessed exactly that, and reverted it: see its brief's own Deviations, "fix round 1 -- superseded").
  The real gap: `runBlockingLoop` used to check `W_YIELD` only *after* a wait returned, never before
  its own first one. `Shell.resume()` builds its `seen`/`last` baseline (`observeWake()`) *before*
  calling `runBlockingLoop`; if a park request's own `W_YIELD = 1` store and wake both land in that
  gap (or symmetrically at `worker.ts`'s first entry or `Shell.runAsync`'s re-entry), the park's own
  wake is silently folded into that baseline, and nothing checks the flag until a *further* wake
  arrives -- which, for a worker nobody touches again, never happens. Fixed by checking `W_YIELD` at
  the top of every pass through the loop, before waiting, not only after
  (`docs/plan/17c-client-park-stall.md`, Step 3 fix round 2); proved with a single-thread,
  deterministic construction (`shell.checks_yield_before_its_own_first_wait`,
  `src/worker/shell.test.ts`, beside `shell.resume_does_not_lose_a_wake`) rather than a live
  reproduction, since the failure this depends on is a code-shape gap, not a timing rarity. A
  harness-level retry (re-waking a not-yet-parked worker) is *not* the fix for this class of defect
  -- it hides exactly the regression the `parkWorkers` message exists to catch; fix the loop that
  drops the signal, not the caller that sends it.

  **The M03/M04 harness had the same class of defect, one notch stricter (M17c, fix round 3).**
  `src/test/harness-worker.ts`'s `armedLoop` (`gc-loop`'s own page) had the identical shape --
  `Yield` checked only after a wait, never before the first -- behind `harness.ts`'s `parkOne`,
  which stores `Yield = 1` then calls `Atomics.notify(Req)` *without ever changing `Req`* (its own
  doc comment: "keeps `Req === Ack` true across a park"). That makes it *stricter* than
  `runBlockingLoop`'s own case: `sab/control.ts`'s `wake()` always bumps the word a worker waits on,
  so even a racing yield-check is self-healing (the next `Atomics.wait` sees a mismatch and returns
  without blocking); `parkOne`'s notify never changes `Req`, so a worker that reaches its wait *after*
  that one notify already fired sees the value unchanged and blocks for real, with nothing left to
  wake it. Fixed the same way, checked before every wait including the first, with the *existing*
  post-wait check kept too (unlike `runBlockingLoop`'s own fix): `runOp` always calls `sim_tick()`
  unconditionally, so a coincidental wake-plus-park landing on an already-waiting worker still needs
  catching *before* it re-runs an unchanged step as if it were a new one. Proved by a real worker
  calling the (exported) `armedLoop` directly against a caller-built step block
  (`tests/browser/pages/src/armed-loop-race{,-worker}.ts`, `armed-loop-race.spec.ts`) -- the "smallest
  browser test" fallback, needed because a plain Node `unit` test cannot drive `armedLoop` at all
  (`self`/`postMessage` do not exist under Vitest's `node` environment) and a still-broken,
  timeout-less `Atomics.wait` can only be bounded from *outside* the thread it blocks.

  **To find every `Atomics.wait` call site of this shape in one search:** `grep -rn
  "Atomics\.wait\("` over `src/`/`tests/`, excluding comments and `dist/`. `src/sab/no-alloc-
  syntax.test.ts`'s own `sab.atomics_wait_confined` already asserts, automatically, that `src/`
  itself has exactly two -- `sab/control.ts`'s `waitForWake` and `harness-worker.ts`'s `armedLoop` --
  so a third one appearing there fails that test outright; anything found only under `tests/` (a
  one-shot smoke probe, say) is very likely not this shape at all -- check whether it sits in a loop
  with a yield/stop flag before assuming it needs the same fix.
- **`--no-opt --no-sparkplug` can manufacture its own false regression.** M16e's own new branches in
  a spin-wait ack loop (`spins++`, one bitwise mask check per iteration -- see the timeout-message
  bullet above) cost nothing measurable under normal V8, but under forced-interpreter flags every
  extra bytecode is real per-iteration cost; at heavy contention (`--workers 8 --repeat-each 8`) this
  alone flipped the pre-existing `zero_gc_action neg burst sim` cross-isolate flake (next bullet) from
  16/16 passing to 8/8 failing, reproducibly, purely from the added overhead -- confirmed by the same
  runs passing normally (15/16, comparable to base's own rate) once the forced-interpreter flag was
  removed. A `--no-opt --no-sparkplug` reproduction that only fails with a new, small, per-iteration
  change and passes without it is not proof the change is wrong; re-check under normal V8 before
  concluding anything.
- **A target isolate's own negative control can still nudge a sibling isolate's own reading.** Even
  with the two bugs above fixed, a `burst`/`object` control on one isolate's own worker can measurably
  raise a *different* isolate's own `bytesPerFrame` (reproduces at `--workers 1`, one test, no
  external contention) -- the workers are separate OS threads sharing one renderer process, so this
  is not a per-frame allocation site in this milestone's own code; as of M06b it is an open,
  unresolved finding (docs/plan/06b-workers-and-spawn.md, Deviations "fix round 2"), not something to
  paper over with a wider budget without saying so.

## Changing a budget

Raising a number in `budgets.json` is a reviewed change (0020 §9): never do it to make a test pass
without first re-deriving the `formula` string next to it. Measure with `pnpm gc reliability` (many
runs; below), take the observed max, add whatever margin `gc-loop`'s own entries used as precedent
(clean overhead ceiling + 8 B), and write the new formula in place of the old one so a reviewer can
re-derive it. A control that doesn't separate from clean by that margin on both sides means the page
needs fixing, not the budget (0016 §1 discussion).

## `pnpm gc [software|flat|reliability] [-t pattern]`

Local-only invocations of the `gc` project (`scripts/gc.mjs`), never run by `pnpm test`:

- No mode: the `gc` project once, same hardware/tunnel measurement `pnpm test browser` uses --
  `pnpm gc -t "gc-loop clean"` for fast iteration without the rest of the browser suite.
- `software`: `GC_MODE=software`, the software-adapter arithmetic (0016 caveat b) -- compares bytes
  attributed to a page's `attributionRoots` functions instead of total/N. Fails naming the page if
  its `budgets.json` entry has `software: null`.
- `flat`: `GC_CDP=flat`, the flattened-CDP-session transport (`cdp-flat.ts`) instead of the default
  tunnel (`Target.sendMessageToTarget`, deprecated). `gc: flat transport parity` (always run, any
  mode) is the one test that runs *both* transports and compares the worker's exact byte total.
- `reliability`: `--repeat-each` -- clean x 50, every negative control x 15, 4 workers. Minutes, not
  seconds; run it after any change to the harness, the loader, or a page's hot path, and whenever
  raising a budget.

## The `Tracing.start` stall warning

`gc-tracing-start-stall <ms>` (0016 caveat a): `Tracing.start` occasionally stalls waiting on
Chrome's spare renderer. It prints as a `warn` line under the suite (same mechanism as any other
adapter warning) and never fails the test by itself -- only a real budget/GC-event miss does.
