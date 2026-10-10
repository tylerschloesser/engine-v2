# 0065: Phase 3 decisions: persistence and recovery

Status: Accepted (2026-10-10). Amends [0005](0005-persistence-and-recovery.md) (Panic recovery, Upgrades, Consequences deferral) and [0039](0039-snapshot-write-is-a-budgeted-event.md) (stall proxy). Implemented by M23, M24, M24b, M27, M36 and M38; captured at the Phase 3 to Phase 4 handoff (M39b).

## Context

Persistence was built across M22 to M24b and exercised on devices in M23 and M39. Several decisions were settled in code or on hardware that the ADRs still list as deferred or do not state. They are collected here before the plan files that recorded them are deleted.

## Decision

### Recovery

**1. Admit-phase panic answers through `sim_fault_ack(conn, seq)`.** A trap during `Admit` answers the action `Rejected(Engine(EngineFault))` through the dedicated export `sim_fault_ack(conn, seq)`, which also raises that connection's `highest_admitted_seq` to `seq`. An `Admit` trap is never logged, so replay never revisits it and the `pending_fault_acks` mechanism (which belongs to `ApplyRecord`) cannot apply. The progress cursor carries `seq` but no connection, so the server host (`SimHost` in `src/server.ts`) tracks `inFlightAdmitConn` around each `simAdmit` and reads it from the dead instance before rebinding. Why the dedup-floor bump: without it a client that resends after resync re-trips a deterministic `PanicInAdmit`, and the loop guard (3 recoveries without 1,200 good ticks) turns one bad action into a fatal stop. Clearing `inFlightAdmitConn` and the `Phase.Admit` gate each mask a failure of the other, so both stay. A test of this must check the ack's content, not a specific `seq` (a stale ack carries `seq: 0`). [0050](0050-engine-failure-surface.md) lists the `EngineFault` result but not this mechanism.

### Upgrades and load

**2. Schema differences always go to `Game::migrate`, in either direction.** `Identity::compare` has no "incompatible" outcome. An early revision returned `Incompatible` for a stored schema newer than the running build; that was overruled, because accepting a newer save is the game's call (a game whose `migrate` accepts `from_schema == 2` on a v1 build is legal). The default `migrate` yields `SaveIncompatible { MigrateDeclined }`. This amends 0005 Upgrades and [0024](0024-planning-amendments.md) §3.

**3. A world with no snapshot yet can only be loaded `Same` or `Direct`.** It can never be migrated across a schema, tick-rate or worldgen change, because there is no snapshot container to build an `OldStore` from. The genesis-only path asks Rust (`sim_identity_compare`) instead of keeping a TypeScript copy of the compatibility matrix: a TS mirror once had its `TickRate` and `Worldgen` branches swappable with all 144 wasm tests green.

**4. A non-empty but undecodable segment-0 header is `WorldLoadError('corrupt')`,** never treated as "same". The error kind `'identity'` is dead (nothing throws it); `'incompatible'` replaced it.

**5. Upgrade identity is compared per snapshot candidate** against that candidate's own decoded identity, never against `manifest.created`, which records only the original creation identity and would retrigger the upgrade path on every ordinary reload after the first.

**6. A hosted server whose build changed the save schema exits.** The reference server (`games/reference-server`) uses the default `migrate`, so it declines: the machine exits 1 with `WorldLoadError: incompatible (MigrateDeclined)` and Fly stops restarting it. The world already on the volume must be moved aside by hand to start fresh; the procedure is in `games/reference-server/README.md`. This is deliberate: a silent fresh world would destroy a save.

### Storage and durability

**7. Every storage-adapter read path awaits the write path.** Writes are fire-and-forget by design (0005), so `flush()`, `read()` and `list()` must await the temp-file, datasync and rename path behind `write()` and `delete()`, not only the log appender. Before this, a reopen right after `stop()` raced the manifest rename, read `null` and silently created a second empty world (a 2/30 flake in `server/load-or-create`, first mislabelled "unreproduced"). `fsStorage` does this now; any future adapter (OPFS is the only other shipped one, IndexedDB would be next) owes the same flush contract.

**8. OPFS latency is measured; the 1 s sync interval stays.** This closes the 0005 deferral "OPFS append/flush latency on iOS Safari". iPhone (iOS 18.7, Safari 27.0.1): `flush` p95 0.1 ms, `append` p95 0.02 ms, 8 MiB scratch write p95 8.3 ms. Pixel 5: `flush` p95 0.255 ms, 8 MiB write 39 ms. `move()` and `navigator.locks` are present on both. The retune rule was fixed in advance so a regression is not re-argued: `flush` p95 <= 10 ms keeps 1 s; 10 to 40 ms raises it to 2 s (the power-loss window then equals the object-store row); > 40 ms (longer than a tick gap) means `sync` only at snapshots and clean boundaries; `append` p95 > 2 ms is reported and changes nothing. Any change is a new ADR superseding the number in 0005.

**9. After an unclean close the persisted log lags the world by 1 to 2 s of idle ticks.** (Add to 0005's loss-window table: the 1 s `sync` window plus idle ticks that are never logged.) "Lost" must be read from the last admitted action's tick, not the world tick at kill time: a headless Chromium kill resumed at tick 92 against a recorded 111. A check or test that compares post-kill with pre-kill tick fails for no reason.

### Snapshots and replay

**10. The 83.3 ms snapshot stall proxy is a derived criterion, not a measured budget.** The catch-up rule allows five ticks per wakeup (0005), so a snapshot that fits five tick intervals on the phone loses no wall-clock time that catch-up cannot recover; one third of that (5 x 50 / 3 = 83.3 ms) is the desktop proxy. Native release measures 51.3 ms (all work in `begin`, the drain is a memcpy), margin 1.6x. The `.wasm` costs more and was not measured. It is recorded only (a `warn:` line, no baseline). This amends 0039.

**11. `SnapshotWriter` materialises the whole snapshot in the arena and wasm memory never shrinks,** so the peak is permanent (about 8 MiB slack against a roughly 15 MiB snapshot in a 64 MiB budget). 0038 notes it; the large-save arena figure in [0062](0062-budgets-as-measured-at-phase-3-exit.md) is the check.

**12. No byte golden pins a log that crosses two segments.** Removing the `sim_segment_header` reset of the tick reference changes writer and reader together and passes every test, so the reset is required but untestable by hash.

**13. Presence is not a replay track.** Replays show the world without avatars. A track would be a separate storage key fed from `PresenceTable::on_sample`; nothing is reserved in the log or snapshot formats.

### Known open defect

**14. `Persistence.open` instantiates the module twice on a restore.** It creates a probe instance for the `chunk_bits` check and `loadLatest` a second for the restore, neither released before the first GC (Node: instance count 1 on genesis, 2 on restore; at scale 1, `external` memory 99 to 221 MiB). This is the cause of the Durable Object no-go ([0051](0051-durable-objects-no-go.md) §3, its revisit condition) and a startup memory spike on a 1 GB Fly machine with a large arena. It is unfixed and owed a diagnosis; fix it (reuse one instance, or release the probe) before retrying Durable Objects or raising the arena.

## Alternatives rejected

- `Incompatible` for a stored schema newer than the build (§2): takes the call away from the game.
- A TypeScript mirror of the identity matrix for the genesis-only path (§3): drifted silently.
- Applying `pending_fault_acks` to Admit traps (§1): they are never logged, so replay cannot reach them.
- Forcing a retune of the sync interval without device numbers (§8): there was nothing to tune against.

## Consequences

- A schema bump on a hosted world needs a manual move-aside or a game-supplied `migrate`.
- Revisit §8 only if a device round shows `flush` p95 above 10 ms; revisit §14 when Durable Objects are retried or the arena grows.

## Sources

- Code checked 2026-10-10: `packages/engine/src/server.ts` (`inFlightAdmitConn`, `simFaultAck`), `packages/engine/src/host/persistence.ts` (probe instance, error kinds), `packages/engine/crates/engine/src/persist/identity.rs`, `packages/engine/src/storage/fs.ts` (`flush`), `games/reference-server/README.md`.
- Device numbers: iPhone 12 and Pixel 5 rounds, M23 (2026-10).
