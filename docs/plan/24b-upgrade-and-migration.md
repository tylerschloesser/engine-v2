# M24b: Upgrade path: `SCHEMA_VERSION`, `migrate`, `OldStore`, `SaveIncompatible`, Tick rescale

Status: not started · After: 24 (needs 22b, 23's `start-failed` carrier and 24's `onRecovered`) · Tyler-dependent: Q9, "what should a game do with a save it cannot load?" (unanswered; same question as M23; default assumed: `client.ready` rejects with `'save-incompatible'`, files untouched, `exportWorld` / `deleteWorld` still work)

Split from PLAN row 24 (see M24).

## Goal
Loading a world written by a different build takes the upgrade path of 0005: directly when schema, tick rate and worldgen stamp match, otherwise through `G::migrate` over a decided `OldStore`, otherwise a clean `SaveIncompatible` that leaves every stored byte untouched. A tick-rate change rescales stored durations with one engine helper. Every save and segment is stamped with the build identity, and the tests prove which path each mismatch takes.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0005-persistence-and-recovery.md` (Formats: *Sim identity*; Upgrades; Consequences bullets 2–3)
3. `docs/decisions/0006-time-units.md` (Types; "What a tick-rate change does"; rounding rule in Conversion rule)
4. `docs/decisions/0007-world-model.md` (§9 Worldgen stamping; canonical overlay; entities stored once with anchor + footprint)
The `migrate` signature is in code from M12 (`Game::migrate`, default `Err(SaveIncompatible)`); 0003 need not be read. Mine from spikes: none. Rules that apply: `.claude/rules/determinism.md`.

## Scope
- Rust: `OldStore`, `Migrating` (the `WorldWrite` implementor handed to `migrate`), `Rescale` + `RescaleTicks`, `SaveIncompatible`, identity comparison with a reason code, engine-side carry-over of game-type-free state.
- ABI + host: the upgrade sequence of 0005 Upgrades on top of M22b's `WorldLoadError { kind: 'identity' }`; manifest updates; the `SaveIncompatible` report on server and client.
- Chunk size recorded in the world params (0007 §3): `Persistence.create` writes the build's `CHUNK_BITS` as `ManifestV1.params.chunkBits` (the manifest is M22's); `Persistence.open` compares it with the running build before any load and a difference is `'incompatible'` with reason `ChunkSize`, no write. No migration path: overlay and occupancy keys are chunk-relative.
- Fixture games `migrate-v1`, `migrate-v2`, `migrate-v2-hz30`.

## Non-scope
A `migrate` for the reference game (not planned; M32–M34 may add one only if Tyler asks). Cross-version replay of old segments (0005: only with the old binary). Any derive macro (0005 rejected a hand-rolled derive; 0017 crate policy).

## Files, packages and crates touched
- `packages/engine/crates/engine/src/{migrate.rs,persist/identity.rs,abi/sim.rs}`
- `packages/engine/src/host/{persistence,upgrade}.ts`, `packages/engine/src/client.ts` (`'save-incompatible'` start error)
- `packages/engine/fixtures/migrate-v1/`, `migrate-v2/`, `migrate-v2-hz30/` (three tiny crates sharing source by `#[path]`)

## Seams
**Provides**
- Rust (game-facing, exported from crate `engine`):
  - `pub struct SaveIncompatible;` (unit, as the M12 signature already assumes).
  - `OldStore` (decision 1): `schema() -> u32`, `tick_rate_hz() -> u32`, `tick() -> Tick`, `rescale() -> Rescale`, `global<T: DeserializeOwned>() -> Result<T, SaveIncompatible>`, `drain_players() -> impl Iterator<Item = OldValue<PlayerId>>`, `drain_entities() -> impl Iterator<Item = OldValue<EntityId>>`, `drain_tiles() -> impl Iterator<Item = (TilePos, Tile)>`, `carry_tiles(&mut self, w: &mut dyn WorldWrite<G>)`; `OldValue<K> { pub key: K, .. }` with `decode<T: DeserializeOwned>() -> Result<T, SaveIncompatible>`. All iteration is in key order.
  - `Rescale { ticks(Ticks) -> Ticks, deadline(Tick) -> Tick, is_identity() -> bool }` and `trait RescaleTicks { fn rescale(&mut self, r: &Rescale); }` implemented for `Tick`, `Ticks`, `Option<T>`, `[T; N]` (decision 2).
- ABI (sim role): `sim_upgrade_begin(total_len: u32) -> status` / `sim_upgrade_push(len) -> status` / `sim_upgrade_end() -> status` (same block protocol as `sim_restore_*`; `end` runs the direct load or `migrate`); new statuses `STATUS_SAVE_INCOMPATIBLE` and a reason in the boot region: `IncompatReason ∈ { Schema, TickRate, Worldgen, MigrateDeclined, Container, Decode, ChunkSize }` (`ChunkSize` is raised by the TS host from the manifest, never by Rust).
- TS: `Persistence.open` rejects with `WorldLoadError { kind: 'incompatible', reason, stored: IdentityJson, running: IdentityJson }` (M27 surfaces it from `createWorldServer`); in the browser `client.ready` rejects with `EngineStartError { code: 'save-incompatible', detail: { reason, stored, running } }` (M23's `start-failed` lifecycle message), and `client.exportWorld()` / `client.deleteWorld()` stay usable on that client. `upgradeWorld(...)` is internal to `Persistence.open`.
- Manifest: sets `segments[i].tailReexecuted` and `sealed` (fields exist from M22).

**Consumes**
- M12 `Game::{SCHEMA_VERSION, TICK_RATE, migrate}`, `OldStore` shell; M12b `WorldWrite`, `Authority`; M21 entity insertion path (occupancy, footprints); M21b timer wheel and active lists; M08 `WorldgenStamp` + `worldgen_fingerprint`; M22 `Identity`, `SnapshotReader`, `ManifestV1`; M22b `Persistence.open`, `WorldLoadError`, replay ABI, segment open/seal; M24 `SimHost.onRecovered` (fired with `reason: 'upgrade'`); M23 `SimLifecycleMessage` `start-failed`, `exportWorld`, `deleteWorld`; M06b `EngineStartError`.

## Planning decisions
1. **`OldStore` shape (PRE-PLAN §10; 0003, 0005): a byte-level, drain-style view; the game keeps its own old type definitions.** New code cannot name old types, and postcard is not self-describing, so the engine hands out each old game-typed value as undecoded postcard bytes behind `OldValue::decode::<T>()`, where `T` is a `Deserialize` copy of the old struct that the game keeps in its `migrate` module. The engine decodes everything it owns itself (keys, anchors, tiles, player table, counters, timers). `&mut` + `drain_*` exists so old values are freed as they are consumed: old and new stores must coexist inside one fixed arena (0015).
2. **Tick rescale helper (PRE-PLAN §10; 0006): explicit, no derive.** `old.rescale()` returns a `Rescale` built from `(old_hz, new_hz, snapshot tick)`. `ticks(d)` applies `d * new_hz / old_hz` with the rounding and non-zero floor of 0006's conversion rule; `deadline(t)` rescales the *distance* from the snapshot tick (`now + ticks(t - now)`, mirrored for past ticks, saturating at 0) because the tick counter itself is never rescaled (0006 point 3). Games implement `RescaleTicks` by hand, one line per field. If the rates differ and `migrate` returns `Ok` without ever calling `old.rescale()`, the engine logs one `warn` ("tick rate changed but no duration was rescaled"); it is not an error, since a game may store no durations.
3. **What the engine carries without the game's help:** tick counter, `SimRng`, player table (ids, last processed `seq`), id counters, and timer-wheel / wake / active-list registrations keyed by `EntityId`, with their deadlines passed through `Rescale::deadline`; registrations for entities the game did not re-create are dropped. **What only `migrate` carries:** entities, players, global, tiles (`carry_tiles` is the one-line default; with a worldgen stamp mismatch the canonical-overlay rule of 0007 drops entries that now equal pristine).
4. **`Migrating` preserves ids.** `put_entity(id, e)` on an absent id inserts under that old id through the same insertion path as `spawn` (occupancy and footprint checks included; a footprint collision is `SaveIncompatible { Decode }`), `put_player` likewise; `spawn` allocates above the carried id counter; `rng()` works; reads see what has been migrated so far. State-budget checks do not run (0004: never for non-action writes).
5. **Which mismatch takes which path** (0005 Upgrades, 0006 point 2, 0007 §9): identity hash equal → normal load. Hash differs, and `SCHEMA_VERSION`, `tick_rate_hz`, `WORLDGEN_VERSION` and fingerprint all equal → direct load. Any of those differ → `migrate`. `container_version` differs → `SaveIncompatible { Container }` (the engine writes no container migrations during prototyping). `engine_version` / `game_version` are informational only.
6. **Tail re-execution follows 0024 §3.** The tail is re-executed only when stored and running `SCHEMA_VERSION` are equal (the direct-load path); on the `migrate` path it is dropped: the world resumes from the migrated snapshot, the old segment is sealed with `tailReexecuted: false`, and the dropped-record count is in the upgrade result and logged at `warn`. On the re-executed path a record that fails `decode_canonical` under the new build is dropped, counted and warned; it is not an error.
7. **Order of writes makes the upgrade restartable:** new snapshot `write` → `flush()` → manifest `write` (old segment `sealed` with `tailReexecuted` true or false per decision 6, new segment entry) → new segment header `append`. A crash before the manifest write leaves the old world intact and the upgrade simply runs again; a stray new snapshot is pruned later. `SaveIncompatible` performs no write at all.
8. **Build-hash stamping is asserted, not re-implemented:** M22 already stamps `Identity` into snapshots and segment headers; tests here fake a rules-only change by passing a different `WorldConfig.buildHash` to the same `.wasm`.

- **From M23's Deviations.** M23 already added `EngineStartError` code `'load-failed'`: any `Persistence.open` failure (a corrupt manifest is a plain `SyntaxError`, not a `WorldLoadError`) keeps the sim worker alive in a degraded state so `exportWorld`/`deleteWorld` still work. `'save-incompatible'` must be carved out of that path (an identity/schema mismatch reports `'save-incompatible'`; other failures stay `'load-failed'`), and both must keep export/delete working. New `postMessage` types go into `worker/protocol.ts`'s allowlists (`worker/protocol.test.ts` enforces them).

## Order of work
1. `Identity::compare -> Same | Direct | NeedsMigrate(reason) | Incompatible(reason)`; native tests.
2. `Rescale`, `RescaleTicks`; property test against 0006's rule.
3. `OldStore` + `Migrating`; native v1 → v2 migration with both game types in one test binary.
4. ABI `sim_upgrade_*`; host `upgrade.ts` sequence and manifest writes; Node tests with the three fixture `.wasm` files.
5. `'save-incompatible'` start error; browser test.

## Tests added
- Rust native: `identity_compare_matrix`, `rescale_matches_0006_rounding` (20→30, 30→20, 20→60; non-zero floor; `deadline` for past and future ticks), `rescale_identity_is_noop`, `migrate_v1_to_v2_preserves_ids_and_occupancy`, `migrate_drops_timers_of_dropped_entities`, `migrate_hz_change_rescales_engine_timers`, `migrate_default_is_save_incompatible`, `carry_tiles_canonicalises_against_new_pristine`, `migrating_footprint_collision_is_incompatible`.
- Vitest (WASM under Node): `rules_only_change_direct_load_new_segment` (same `.wasm`, different `buildHash`: tail re-executed, old segment sealed + `tailReexecuted`, new segment based on the new snapshot, `onRecovered` fired with `'upgrade'`), `schema_bump_runs_migrate` (v1 world → v2 build; a non-empty tail is dropped, `tailReexecuted: false`, dropped count reported: 0024 §3b), `tick_rate_change_without_bump_still_requires_migrate` (v2 → v2-hz30), `no_migrate_hook_save_incompatible_files_untouched` (v2 world → v1 build; storage byte-equal), `chunk_bits_mismatch_save_incompatible_files_untouched` (a created world's manifest has `params.chunkBits` equal to the fixture's `CHUNK_BITS`; with the stored value rewritten to 4, `open` rejects with reason `ChunkSize` and storage is otherwise byte-equal), `worldgen_stamp_mismatch_requires_migrate`, `undecodable_tail_action_is_dropped_and_counted`, `upgrade_crash_before_manifest_is_restartable` (`crashClone`), `import_then_upgrade` (archive from v1 imported under v2: 0005 "including the upgrade path").
- Browser: `save_incompatible_rejects_ready_and_export_still_works`.

## Exit criteria
- [ ] All tests above pass by name.
- [ ] `OldStore`, `OldValue`, `Rescale`, `RescaleTicks`, `SaveIncompatible` are public in crate `engine` with rustdoc examples that compile (doc-tests run in the Rust suite).
- [ ] Import allowlist and ABI export-list tests pass for the three new fixtures.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t migrate` · `pnpm test rust -t rescale` · `pnpm test wasm -t upgrade` · `pnpm test wasm -t save_incompatible` · `pnpm test` · `pnpm lint`

## Budgets
- Memory per instance (0015): `migrate_v1_to_v2` runs under the default sim arena with a counter asserting peak arena use ≤ old + new store sizes (drain semantics work).
- Dev loop / test suite rows: three extra fixture crates must not push the incremental build over 0020's 30 s; if they do, merge them into one crate with `cfg` features built three times.

## Context artifacts
New skill `bump-schema` only if the session actually performs the procedure on a fixture end to end (0021 §4). Either way add one step to the `add-action-type` skill (and to `bump-schema` if created) and one rustdoc sentence on `Game::SCHEMA_VERSION`: a change to `G::Action`'s layout is a `SCHEMA_VERSION` bump (0024 §3a). Add two lines to `packages/engine/crates/engine/src/persist/CLAUDE.md`: path matrix lives in `Identity::compare`; never write during `SaveIncompatible`.

## Manual device checks
none

## Deviations
(filled in during Phase 3)

ADR note: 0005 Upgrades says re-executing the tail is safe because "at worst an action is now rejected". With postcard that is not strictly true when `G::Action`'s layout changed between builds: old bytes can decode into a different *valid* action. 0024 §3 amends 0005 for this case (`SCHEMA_VERSION` also covers `G::Action`; the tail is dropped when it differs); decision 6 above implements it, it does not re-decide it.
