# 0039: The periodic snapshot write is a budgeted event, not inside the strict zero-GC window

Status: Accepted (2026-09-25). Amends [0016](0016-zero-gc-definition.md) Consequences (the
snapshot-write sentence) and §1 (adds `simWorker.snapshotEventBytes` to the budgets file).
Implemented in M23 (`docs/plan/23-persistence-opfs-and-lifecycle.md`), step 6.

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
B/frame) with one snapshot forced at a fixed frame, zero `MinorGC`/`MajorGC` either way. Against the
isolate's own 8 B/frame strict allowance (4800 B over the same window) as the base, the snapshot
event itself accounts for 7292 - 4800 = 2492 B: `Persistence.snapshotNow()`'s `sim_snapshot_begin`/
`_next` streaming plus the queued OPFS scratch close, `FileSystemFileHandle.move()` and the next
scratch's `createSyncAccessHandle()` (`storage/opfs.ts`'s own `#queueRename`/`#openScratch`, run
through `shell.runAsync` per Planning decision 2 of M23). Without a forced snapshot the same page's
`sim` isolate stays at 4.6-4.8 B/frame, comfortably inside the strict 8 B/frame budget on its own --
persistence's per-tick bookkeeping (`Persistence.afterTick`'s counters, one `sim_dirty()` read) costs
nothing measurable when it never actually snapshots, so the log `append`/`sync` half of 0016's own
sentence stands unchanged (inside the strict window, by construction: `opfs.ts`'s `append`/`sync`
fast paths are plain, non-`async` methods, decision 4 of M23's own Planning decisions).

## Decision

**1. The snapshot write is a budgeted event, like the net worker's per-message budget, not inside
the sim worker's strict per-frame window.** `packages/engine/budgets.json`'s
`counters.simWorker.snapshotEventBytes = 3200` (measured 2492 B, + 25% margin = 3115, rounded up for
run-to-run jitter; well under a 4 KB/snapshot ceiling). `zero_gc_singleplayer_with_snapshot`
(`gc-sim.spec.ts`) asserts the isolate's own measured window total is at most
`gc.pages.sim.isolates.sim.bytesPerFrame * 600 + snapshotEventBytes`, and zero `MajorGC` regardless.

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

- `budgets.json`'s `counters.simWorker.snapshotEventBytes` is the one number a future change to
  `Persistence.snapshotNow()`/`storage/opfs.ts`'s rename queue is measured against; raising it is a
  reviewed change (0016 §1's own "raising it is a reviewed change" convention extends here).
  `gc-sim.spec.ts`'s own formula string has the derivation to re-run.
- The strict per-frame budget for `sim`/`gen0`/`client` (8 B/frame) is unchanged; this ADR narrows
  0016's own deferred sentence, it does not reopen the fixed table.
- Server-side persistence (`fs.ts`, object-store adapters) is outside 0016 entirely (desktop Chromium
  only, 0016 Consequences) and unaffected.

## Sources

- `docs/plan/23-persistence-opfs-and-lifecycle.md`, step 6 Deviations: full measurement log,
  `gc-sim.ts`'s own Deviations comment, `budgets.json`'s `counters.simWorker` formula string.
- [0016](0016-zero-gc-definition.md) Consequences (the sentence this amends);
  [0028](0028-zero-gc-two-measured-windows.md) (the two-window minimum this ADR's §3 works around).
