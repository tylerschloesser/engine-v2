# 0039: The periodic snapshot write is a budgeted event, not inside the strict zero-GC window

Status: Accepted (2026-09-25). Amends [0016](0016-zero-gc-definition.md) Consequences (the
snapshot-write sentence) and §1 (adds `simWorker.snapshotEventBytes` to the budgets file).
Implemented in M23 (`docs/plan/23-persistence-opfs-and-lifecycle.md`), step 6. Fix round 1
(coordinator review, same day): corrected the arithmetic below -- the first draft subtracted the
isolate's own strict *allowance* (8 B/frame), not its measured snapshot-free *baseline*, understating
the snapshot's own cost by the ~2 KB gap between the two. See Context and Decision 1.

## Context

[0016](0016-zero-gc-definition.md) Consequences left this open: "Deferred to Phase 2: whether the
periodic snapshot `write` is inside the strict window or a budgeted event like a net message,
because its rename and handle reopen are promise-only OPFS calls and no persistence code or
measurement exists. Default until measured: inside (the test forces one snapshot in the window
through the injected clock)." M23's own Planning decision 1 fixed the measurement plan: force one
snapshot inside `gc-sim.html`'s real 600-frame zero-GC window (`engine/test.forceSnapshot()`, a
`CB_FORCE_SNAPSHOT_REQ` control word) and read the `sim` isolate's own sampled bytes.

Measured (`gc-sim.html?forceSnapshot=1`, 5 repeated runs, `pnpm gc -t "zero_gc_singleplayer_with_
snapshot"`): the isolate's own per-window total (the lower of the two consecutive measured windows,
[0028](0028-zero-gc-two-measured-windows.md)) reads a stable 7280-7292 B over 600 frames (12.13-12.15
B/frame) with one snapshot forced at a fixed frame, zero `MinorGC`/`MajorGC` either way. Without a
forced snapshot the same page's `sim` isolate reads a stable 4.6-4.62 B/frame (2760-2772 B over 600
frames, 5 clean runs) -- persistence's per-tick bookkeeping (`Persistence.afterTick`'s counters, one
`sim_dirty()` read) costs nothing measurable when it never actually snapshots, so the log
`append`/`sync` half of 0016's own sentence stands unchanged (inside the strict window, by
construction: `opfs.ts`'s `append`/`sync` fast paths are plain, non-`async` methods, decision 4 of
M23's own Planning decisions).

**Fix round 1 (coordinator review): attribution first.** The first derivation compared the
with-snapshot total against the isolate's own 8 B/frame strict *allowance* (4800 B), not its measured
4.6-4.62 B/frame *baseline* (2760-2772 B) -- 7292 - 4800 = 2492 B understated the snapshot's own cost
by exactly the ~2 KB of unused strict slack between the two, [0029](0029-zero-gc-software-mode-attribution.md)'s
own failure mode (a budget that stops meaning what it claims to measure), reached through arithmetic
rather than a widened number. Forcing the isolate's `bytesPerFrame` budget to a near-zero value to
dump `windowByFn` and diffing the with-snapshot run against the snapshot-free run named the real
delta -- 7292 - 2772 = 4520 B, made up of (chosen/lower window, both runs' own top entries):
`#resolveDir` 1500 (new), `#openScratch` 624 (new), `#pendingAsync` 480 (new), `#resolve` 300 (new) =
2904 B of named new OPFS-resolution functions, plus ~1600 B below the `byFn` top-8 cutoff on the
with-snapshot side alone (the snapshot-free side's own top-8 already covers all but ~16 B of its
total) -- `storage/opfs.ts`'s directory-resolution path, not the promise-only rename/reopen calls
themselves, which Planning decision 2 already accepts as unavoidable.

**Avoidable allocations fixed** (`storage/opfs.ts`, none of them the promise-only OPFS calls
Planning decision 2 accepts): `#resolveDir` re-split its `path` argument and re-walked
`getDirectoryHandle` on every call, even though this adapter's own directory set (`worlds/<id>`,
`.../log`, `.../snap`, `.../sessions`) is fixed for its whole life and a directory, once resolved,
never disappears (`delete()` only ever removes files) -- now cached by path string in a `#dirCache`
`Map`. `#openScratch` built `` `worlds/${this.#worldId}` `` fresh on every scratch reopen -- now
computed once, at construction. `getDirectoryHandle`/`getFileHandle`'s own `{ create }` options
object was a fresh literal per call (`.claude/rules/hot-paths.md`'s no-options-object convention,
previously applied only to `append`'s own tick-path calls) -- now two reused constants. Re-measured
after these fixes: the with-snapshot window drops to a stable 5684-5708 B (5 runs); the snapshot-free
baseline is unaffected (2760-2772 B, `#resolveDir`'s cache does not change steady-state `append`,
which never calls it). Corrected delta: 5708 - 2772 = 2936 B (worst observed pair), or by the
formula the runtime assertion actually uses (measured baseline rounded up to a fixed
`snapshotFreeBytesPerFrame`, not the per-run baseline sample) 5708 - (4.8 * 600) = 2828 B.

Remaining cost is `#resolveDir`/`#resolve`'s own *first-ever* resolution of `worlds/<id>/snap` (a
cache miss: this is the world's first snapshot ever, in every run of this test) plus
`#pendingAsync`'s own closure and the unavoidable `move()`/`createSyncAccessHandle()` promise chain.
A real production world's second and later periodic snapshots reuse the cached `snap` directory and
cost less than this worst-case, cold-cache measurement.

## Decision

**1. The snapshot write is a budgeted event, like the net worker's per-message budget, not inside
the sim worker's strict per-frame window -- asserted as a delta against the isolate's own *measured*
snapshot-free rate, never its separate strict *allowance*.** `packages/engine/budgets.json`'s
`counters.simWorker`: `snapshotFreeBytesPerFrame = 4.8` (the measured baseline, rounded up from
4.6-4.62) and `snapshotEventBytes = 3600` (measured delta 2828 B, + 25% margin = 3535, rounded up for
run-to-run jitter; under the 4 KB/snapshot ceiling). `zero_gc_singleplayer_with_snapshot`
(`gc-sim.spec.ts`) asserts `sim`'s own measured window total, minus `snapshotFreeBytesPerFrame * 600`,
is at most `snapshotEventBytes`, and zero `MajorGC` regardless -- the *delta*, not a combined
allowance built from the isolate's own separate (and looser) strict `bytesPerFrame` figure, so that
figure's own unused slack can never again silently absorb snapshot growth.

**2. The strict, snapshot-free test stays the sim isolate's own default measurement.**
`gc-sim.html`'s own `sim clean` test (`zeroGcSuite`) is unchanged in shape: persistence is on
unconditionally (`host.persist: true`), but no snapshot is ever forced there, so it continues to
prove 0016's own "log `append`/`sync` stay in the strict window" claim by construction.
`gc-sim.html?forceSnapshot=1` is a separate, explicit page mode (Deviations,
`docs/plan/23-persistence-opfs-and-lifecycle.md`) for the budgeted-event test alone.

**3. `forceSnapshot()` fires on every `drive()` pass, not only the perf-marked one.**
[0028](0028-zero-gc-two-measured-windows.md)'s own two-consecutive-windows scheme reports the *lower*
of two totals per isolate, to drop a one-off JIT event; a one-shot snapshot gated to fire in only one
of the two windows can itself land in the window 0028 discards, silently excluding its own cost from
the reported number (measured directly: gating on the perf-marked window alone let the reported total
fall back to the snapshot-free ~2760 B baseline half the time). Firing at the same fixed local frame
of every `run()` call instead -- both measured windows and every warm-up pass, all before
`HeapProfiler.startSampling` begins -- means the comparison is never a coin flip.

**4. Avoidable allocation on the snapshot's own promise-only path is fixed, not budgeted away.**
`storage/opfs.ts`'s `#resolveDir` now caches resolved `FileSystemDirectoryHandle`s by path;
`#openScratch`'s own directory path is computed once; `getDirectoryHandle`/`getFileHandle`'s `{
create }` options object is a reused constant. None of these are the promise-only OPFS calls
(`move()`, `createSyncAccessHandle()`) Planning decision 2 already accepts as unavoidable -- they are
ordinary JS-side allocation this repo's own hot-path convention already forbids elsewhere
(`.claude/rules/hot-paths.md`), just never previously measured on this (off-tick, promise-only) path.

## Alternatives rejected

- **Raise the sim isolate's own strict `bytesPerFrame` budget to cover the snapshot.** Contradicts
  0016 §1's fixed strict-isolate figure (8 B/frame, shared by every worker's own row) and would hide
  a real one-tick allocation spike inside a number meant to catch exactly that; a snapshot happens
  once per 60 s of sim time (0005 Cadence), not every tick, so per-frame accounting is the wrong
  shape for it regardless.
- **Amortise the snapshot's cost by dividing it across the 1,200-tick cadence instead of budgeting it
  as one event.** Would report a tiny per-frame number that hides the real, single-tick allocation
  burst a GC pause would actually see; the net worker's own per-message (not per-tick-amortised)
  budget is the closer precedent, and 0016 already treats it as a budgeted-event isolate for the same
  reason.

## Consequences

- `budgets.json`'s `counters.simWorker.snapshotEventBytes` (and its companion
  `snapshotFreeBytesPerFrame`, the tight baseline the runtime assertion subtracts) are the two
  numbers a future change to `Persistence.snapshotNow()`/`storage/opfs.ts`'s rename queue is measured
  against; raising either is a reviewed change (0016 §1's own "raising it is a reviewed change"
  convention extends here) -- proved by injecting ~1 KB of extra allocation into `snapshotNow()` and
  confirming `zero_gc_singleplayer_with_snapshot` fails (reverted after). `gc-sim.spec.ts`'s own
  formula string has the derivation to re-run.
- The strict per-frame budget for `sim`/`gen0`/`client` (8 B/frame) is unchanged; this ADR narrows
  0016's own deferred sentence, it does not reopen the fixed table.
- Server-side persistence (`fs.ts`, object-store adapters) is outside 0016 entirely (desktop Chromium
  only, 0016 Consequences) and unaffected.

## Sources

- `docs/plan/23-persistence-opfs-and-lifecycle.md`, step 6 Deviations: full measurement log,
  `gc-sim.ts`'s own Deviations comment, `budgets.json`'s `counters.simWorker` formula string.
- [0016](0016-zero-gc-definition.md) Consequences (the sentence this amends);
  [0028](0028-zero-gc-two-measured-windows.md) (the two-window minimum this ADR's §3 works around).
