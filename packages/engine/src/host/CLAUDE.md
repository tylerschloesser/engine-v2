# packages/engine/src/host

`persistence.ts` (docs/plan/22-persistence-log-and-snapshots.md steps 4-6): `Persistence`, the
write side of 0005 Persistence. One instance per world.

- `Persistence.create(storage, cfg, sim)` creates a brand-new world: writes `ManifestV1` (Planning
  decisions 3) and opens segment 0 with a real `SegmentHeader` (`sim_segment_header(0,
  GENESIS_BASE_TICK)`) as its first bytes. Loading a stored world is M22b's (Non-scope here) --
  this never checks for an existing manifest.
- `appendFrame` (`SimHost.logSink`'s own target, a fixed method value, never a per-call closure)
  and `afterTick(tick)` (called once per completed tick, right after `sim_tick()`) are the tick
  path's own two entry points. `sync` fires at most once per second when something has been
  appended since the last one; `snapshotNow` (every 1,200 ticks, only if `sim_dirty()`) streams a
  full snapshot through `sim_snapshot_begin`/`sim_snapshot_next` into one `SnapshotBuffer` (doubles
  when too small; its own `highWaterBytes` is exposed alongside the Rust-side `SnapshotWriter`'s
  `total_len()`, both measured together for Budgets "Memory per instance").
- `sim: EngineInstance` (raw, not `server.ts`'s `SimInstance`): this class calls the
  persistence-specific ABI exports directly (`sim_dirty`/`sim_segment_header`/
  `sim_snapshot_begin`/`sim_snapshot_next`), alongside `tick_hz` (read once, at construction).
- `Storage.onError` is set here: once fired, `appendFrame`/`afterTick` throw on their very next
  call (0005: "a failed or lost write is fatal to the world") -- no `onFatal` UI event exists yet
  to raise instead.
- `createSimHost(cfg, services)` (`../server.ts`) builds one `Persistence` per world and wires it
  in; `createSimHostFromInstance`'s `persistence` parameter is optional, so existing two-argument
  callers (`worker/sim.ts`) are unaffected -- real storage there is a later milestone's.
