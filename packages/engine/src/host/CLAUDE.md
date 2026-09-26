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

## Loading (docs/plan/22b-persistence-load-and-fs.md)

- `Persistence.open(storage, cfg, newInstance)`: create-or-load. No manifest -> `Persistence.
  create`'s own path (`outcome: 'created'`). A manifest -> `Persistence.loadLatest`, wrapped into a
  live `Persistence` continuing exactly where the load left off (its `segment`/`logOffset`/`tick`
  fields seeded from the load, not `0`); may self-heal a manifest a crash left stale
  (`healManifest`, private).
- `Persistence.loadLatest(storage, keys, manifest, newInstance)`: a `static` helper, not an instance
  method (no live `Persistence` exists yet when `open` calls it) -- "the snapshot + tail step on its
  own", reusable by M24 after a trap. Checks the running identity first (`sim_segment_header(0,
  GENESIS_BASE_TICK)`, no genesis needed) against `manifest.created`, throwing `WorldLoadError` on a
  mismatch (reported, not handled: M24b's own migrate path). Then tries every `snap/` key newest
  first through `sim_restore_begin/push/end`, each candidate on a fresh `newInstance()`: a bad CRC/
  container version, or a `logOffset` beyond its own segment's stored bytes (0005: "kept until the
  new one verifies"), falls back to the next-older one, then to a genesis replay of segment 0 if
  none verify. Either way, `sim_replay_begin/push/end` replays the chosen tail; a torn frame is
  truncated with `storage.write` (`Storage` has no `truncate`) and reported in `truncatedBytes`.
  `outcome` is `'recovered'` iff anything was skipped or truncated, else `'loaded'`.
- `WorldLoadError { kind: 'identity' | 'corrupt' | 'container', running, stored? }`: thrown, not
  returned -- storage is left untouched.
- Segment rolling (step 3, Planning decisions 2): `snapshotNow`'s own `rollSegmentIfNeeded` seals
  the open segment and opens a new one when its byte length reaches `segmentRollBytes` (`4 MiB`,
  overridable per `Persistence.create`/`open`'s own `opts` for tests). The new segment's own header
  and its base snapshot are written *before* the manifest rewrite, in that order, so a crash between
  them and the manifest leaves self-describing data behind (`loadLatest`'s own segment discovery
  never trusts the manifest anyway) rather than nothing at all.
- Pruning (step 3, Planning decisions 3, `pruneSnapshots`): keeps every segment's own base snapshot
  plus the latest two overall, off the tick path (`Storage.list`) -- called from `SimHost.pause`/
  `stop` (after `snapshotIfDirty`) and after a successful `Persistence.open` load, never from the
  periodic cadence itself ("kept until the new one verifies").
- `SimHost.pause()`/`stop()` are `async` (step 3): disarm the pacing timer synchronously, then (when
  a `Persistence` is wired in) `snapshotIfDirty()`, `pruneSnapshots()`, `flush()`, in that order.
- Panic recovery (docs/plan/24-recovery-and-migration.md): a dead instance is only ever *read*.
  `recovery.ts`'s `runPanicRecovery` is the Skip retry loop; `SimHost.recover()` owns the guard and re-attach.
