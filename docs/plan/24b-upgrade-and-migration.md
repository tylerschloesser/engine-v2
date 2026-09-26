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

- **From M24's Deviations.** `SimHost.recover()` hardcodes `onRecovered`'s `reason: 'panic'`; the upgrade path must widen it to `'upgrade'` (or fire `onRecovered` itself). Recovery rebinds `Persistence.sim` to the fresh instance, and `Host::reattach`/`sim_reattach` re-attaches open connections without logging a `Connected` record. The progress cursor is `RegionId` 11 (not 9). `ABI_VERSION` is 20.

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
Steps 1-3 only (this delegation's scope); steps 4-5 go to a second implementer. Base `6b43c09`.
Commits: `3b87725` (step 1), `e47c820` (step 2+3 core), `b97ee78` (step 3 fixtures/tests).

**Step 1 -- `Identity::compare`.** `impl Identity { pub fn compare(&self, running: &Identity) ->
Comparison }` in `persist/identity.rs`, `self` = the identity stored in a save. `Comparison { Same,
Direct, NeedsMigrate(MismatchReason) }`, `MismatchReason { Schema, TickRate, Worldgen }` (both
`pub`, re-exported at `persist::{Comparison, MismatchReason}`) -- **not** the ABI's own 7-variant
`IncompatReason` (`Schema, TickRate, Worldgen, MigrateDeclined, Container, Decode, ChunkSize`)
named in this brief's own Seams section. That wire enum is a step-4 superset: map
`MismatchReason::{Schema,TickRate,Worldgen}` 1:1 into it and construct the other four downstream of
`compare` (`MigrateDeclined` when `Game::migrate` itself returns `Err`; `Decode` when
`OldStore::decode` or an `OldValue::decode` fails, or `Migrating` faults on a footprint collision;
`Container` from the pre-existing `SnapshotReader`/`PersistError::ContainerVersion` envelope check,
never from `compare`; `ChunkSize` from the TS host's manifest comparison, per Scope, never from
Rust at all). `compare` never returns `Incompatible` at all -- there is no such variant on
`Comparison` (fix round 1, below).

**Fix round 1 (orchestrator ruling).** An earlier revision of this brief's own `Identity::compare`
added `Comparison::Incompatible(MismatchReason::Schema)` for a stored `schema_version` newer than
the running build's, reasoning that `Game::migrate` only ever brings an *older* schema forward. The
orchestrator's ruling: follow decision 5 literally -- a `SCHEMA_VERSION` difference is
`NeedsMigrate` **in either direction**, and `Game::migrate` decides (its default `Err
(SaveIncompatible)` is reason `MigrateDeclined`, not a `compare`-level verdict); a game may choose
to accept an older build's save written by a newer one, which is exactly
`no_migrate_hook_save_incompatible_files_untouched`'s own mirror image (that fixture scenario has no
hook at all, so it *is* `SaveIncompatible`; a game that supplies one is not). Applied: the
`Incompatible` variant is removed from `Comparison` entirely (nothing else ever produced it, so
there was nothing left to keep it for); `identity_compare_matrix` now asserts `NeedsMigrate(Schema)`
for a stored schema in both directions; a new native test,
`migrate::tests::accepts_newer_schema::migrate_accepts_a_newer_stored_schema_when_the_game_chooses_
to` (`migrate.rs`), builds a stored `Identity` with `schema_version: 2` against a running build's
`schema_version: 1`, asserts `compare` returns `NeedsMigrate(Schema)`, then runs `migrate()` against
a small local `Game` (`SCHEMA_VERSION = 1`) whose own `migrate` explicitly accepts `from_schema ==
2` and downcasts the newer `Global` shape, and asserts it succeeds. Proved both the reverted
`compare` branch and the reverted `identity_compare_matrix` assertion actually catch the regression
(re-introduced each temporarily, watched the exact tests fail, reverted) -- see "Test-injected-
defect verifications" below.

**Step 2 -- `Rescale`/`RescaleTicks`, `crates/engine/src/migrate.rs`.** `Rescale::new(old_hz,
new_hz, snapshot_tick)`; `ticks(Ticks) -> Ticks` is 0006's own rounding rule generalised from a
fixed 1000ms denominator to an arbitrary `old_hz` one: `round_half_up(num/den) ==
floor((2*num+den)/(2*den))`, which reduces to exactly 0006's `(ms*hz+500)/1000` at `den=1000`, plus
the non-zero floor. `deadline(Tick) -> Tick` rescales the distance from `snapshot_tick`, mirrored
for a past tick, saturating at 0. `RescaleTicks` implemented for `Tick` (as a deadline), `Ticks` (as
a duration), `Option<T>`, `[T; N]`. `rescale_matches_0006_rounding`'s own expected-value function is
`f64`-based, never calls `Rescale`.

**Step 3 -- `OldStore`/`OldValue`, `Migrating`, the `migrate()` driver, all in `migrate.rs`.**
`OldStore` is **not** generic over any `Game`: every engine-owned field (player ids/`last_seq`/
`online`, tile positions, entity ids, timer deadlines, wake-queue/active-list membership) is fully
decoded; every game-typed value (`G::Entity`/`G::Player`/`G::Global`) stays raw postcard bytes
behind `OldValue<K>::decode::<T: Codec>()` -- **`T: Codec` (`Serialize + DeserializeOwned`), not the
brief's own `DeserializeOwned`-only wording**: `decode_canonical` (the determinism rule: untrusted
bytes never go through plain `decode`) re-encodes to verify canonicality, which needs `Serialize`
too. `carry_tiles<G: Game>(&mut self, w: &mut dyn WorldWrite<G>)` is the one method generic over the
*new* `G` (inferred from `w`), since it is the one "what only migrate carries" default the engine
supplies (Planning decisions 3); it drops an entry that now reads back equal to the new pristine
(`w.tile(pos)` on an untouched position *is* the new pristine value, so no separate worldgen call is
needed).

**Bytes reach `OldStore` via `OldStore::decode(reader: &mut ByteReader, schema: u32,
old_tick_rate_hz: u32, new_tick_rate_hz: u32, tick: Tick, chunk_bits: u32) -> Result<Self,
SaveIncompatible>`** -- a `&mut ByteReader` already positioned at the start of a decoded snapshot's
own *store* section (`Store::write_canonical`'s wire shape, i.e. right after a real
`SnapshotReader`/step-4 caller has already parsed `identity`/`tick`/`log_segment`/`log_offset`/
`log_ref_tick`/`rng` itself), **not** a whole `SnapshotReader`. `OldStore::decode` re-implements
`Store::write_canonical`'s reader side byte-for-byte (players, next_entity_id, global, terrain
overlay, entities, active lists, timers, wake queue's `next` list) rather than building a real
`Store<OldG>` -- deliberate duplication, flagged here per `persist/CLAUDE.md`'s own "field order is
fixed wire format" rule: **a change to that wire shape must update both `Store::write_canonical`/
`decode` and `OldStore::decode`, or old saves silently misparse.** `chunk_bits` is the *running*
build's `G::CHUNK_BITS` (a chunk-size mismatch is `SaveIncompatible { ChunkSize }` before this ever
runs, per Scope, so old and new chunk bits are already known equal). `SimRng` and `tick` are **not**
carried through `OldStore` at all -- neither is game-typed or schema-dependent, so step 4's caller
passes them straight into `migrate()`'s own `tick`/`rng` parameters, sourced from the same
`SnapshotInfo` it already has.

**The entry point: `pub fn migrate<G: Game>(old: OldStore, terrain: TerrainStore, tick: Tick, rng:
SimRng) -> Result<(Authority<G>, MigrationOutcome), SaveIncompatible> where G::Global: Default`.**
`sim_upgrade_end` (step 4) is expected to call this only on the `NeedsMigrate` path (the `Direct`
path is a plain `SnapshotReader`/tail-replay, no `migrate.rs` involvement at all). Builds a fresh
`Store<G>`/`Authority<G>` via `Authority::from_snapshot` (carrying `tick`/`rng` in directly, no new
setters needed -- that constructor already existed, M22's own), runs `Game::migrate` through a
`Migrating`, then unconditionally applies the engine-owned carry (id counter via the new
`Store::carry_next_entity_id`, raises-only; player `last_seq`/`online` via the new
`Store::carry_player_meta`, onto an existing slot only; timer wheel filtered to surviving entities
and passed through `Rescale::deadline`; wake-queue `next` and every active list filtered the same
way, unrescaled since neither carries a deadline). Returns the new `Authority<G>` plus
`MigrationOutcome { dropped_timers, dropped_wakes, dropped_active }` -- **distinct from
`sim_upgrade_end`'s own tail-replay "dropped record" count (0024 §3b)**, which is a different
concept step 4 will report separately. `rescale()` "was it called" tracking: `OldStore` has a
private `Cell<bool>` set only by the *public* `rescale()` method; `migrate()`'s own internal use of
the same numbers goes through a private `engine_rescale()` that never touches the flag, so the
decision-2 warning genuinely reflects whether **the game's own `migrate` body** called it, not
whether the engine's own mandatory carry did.

**Real bug found while wiring the fixtures (see commit `b97ee78`):** `Migrating::spawn`/
`put_entity` originally forwarded to `Authority`'s own `WorldWrite::spawn`/`put_entity`, which
unconditionally auto-wakes (`wake: true`) every put made outside `G::tick`. That put *every*
migrated entity into the new wake queue's `next` list regardless of the old snapshot's own
membership, and then a completely ordinary game `tick()` handler's "first sight of a freshly
spawned entity" `next_woken` branch (the exact pattern `fx-persist`/every migrate fixture here
uses) silently **overwrote** the timer deadline the engine had just carried over, on the very first
tick after migration -- caught by `migrate_drops_timers_of_dropped_entities` (fires stayed 0
forever) before this was fixed. Fix: two new `pub(crate)` methods, `Authority::spawn_no_wake`/
`put_entity_no_wake` (mirrors `TickCx`'s own "puts never auto-wake" convention, exactly the same
reasoning); `Migrating` uses these instead. `Authority::store_mut()` also had its
`#[cfg(any(test, feature = "testing"))]` gate removed (now plain `pub(crate)`, unconditional) so
`migrate()`'s driver can reach it in production builds, not only under the `testing` feature.

**Arena peak-use counter (Budgets).** `migrate_v1_to_v2_preserves_ids_and_occupancy`
(`fixtures/migrate-v2/tests/migrate_v1_to_v2.rs`) measures `engine::abi::arena::{live_bytes,
high_water_bytes}` around the `decode`/`migrate` calls: `old_store_live` = live-byte delta while
decoding `OldStore`; `new_store_live` = live-byte delta left over after `migrate` returns (the old
store, consumed and dropped by then); `peak_during_migrate` = high-water delta spanning the
`migrate()` call itself. Asserts `peak_during_migrate <= old_store_live + new_store_live`. No
separate `#[global_allocator]` in that test file: a native binary installs only one, and this one
already gets `engine::abi::Arena` for free from `fx_migrate_v2::export_game!` (the same reason
`fx-migrate-v1` needed its own `as_dependency` feature -- see below). Small-scale measured numbers
(2 entities, `CacheCapacity::Chunks(4)`): `peak_during_migrate=3577 old_store_live=568
new_store_live=20264` (bound 20832, comfortable margin). **Proved the assertion can fail** (Trap):
with 4,000 entities, a temporarily-injected defect in `drain_entities` (clone every entry instead
of draining it, so old bytes stay fully resident through the whole `migrate` call instead of being
freed as consumed) measured `peak_during_migrate=885476` against `bound=856728` (`old_store_live=
186593 new_store_live=670135`) -- **fails**, exactly as expected; the correct (draining)
implementation on the same 4,000-entity world measured `peak_during_migrate=813856 <= 856728`. The
defect and its one-off proof run were reverted before committing; only the small-scale assertion
is a permanent test.

**Cargo-workspace constraint, not anticipated by the brief:** a native test binary can install only
one `#[global_allocator]` (pre-existing rule, `fixtures/machines/tests/journal_bench.rs`'s own doc
comment), so the cross-fixture test crates (`fx-migrate-v2`, `fx-migrate-v2-hz30`) cannot depend on
`fx-migrate-v1` normally -- both call `engine::export_game!`, which installs one each, and Cargo
refuses to link two. Fix: `fx-migrate-v1` gained a Cargo feature `as_dependency` that skips its own
`export_game!` call; `fx-migrate-v2`/`fx-migrate-v2-hz30`'s `[dev-dependencies]` enable it. This is
why "both game types in one test binary" (Order of work 3) is satisfied by `fx-migrate-v1` +
whichever `fx-migrate-v2*` crate owns the test, never by combining `fx-migrate-v2` and
`fx-migrate-v2-hz30` together (neither ever needs to be in the same binary as the other).

**Fixture sharing (Files: "three tiny crates sharing source by `#[path]`").** `fx-migrate-v2` and
`fx-migrate-v2-hz30` share `fixtures/migrate-v2/src/game.rs` verbatim via
`#[path = "../../migrate-v2/src/game.rs"] mod game;`; the tick rate is a const generic (`pub struct
V2<const HZ: u32>`, `const TICK_RATE: TickRate = TickRate::hz(HZ)`), so the two crates differ only
in which `HZ` they instantiate (`type V2Game = game::V2<20>` / `V2<30>`), never in the shared file's
own text. `fx-migrate-v1` (a genuinely different schema, not just a different tick rate) is its own,
separate file -- "three crates" holds; "sharing source" holds for two of the three, which is the
whole reason a third, tick-rate-only variant needed no new logic at all.

**Budgets "incremental build must not exceed 0020's 30s": not triggered by these fixtures.**
Measured per-fixture `cargo` time via `node packages/engine/scripts/build-fixtures.mjs` (warm
cache): each of `migrate-v1`/`migrate-v2`/`migrate-v2-hz30` costs ~535-541ms, in line with every
other fixture here (419-1098ms) -- negligible, and no crate merge is needed. The *observed*
`pnpm test rust`/`pnpm test wasm` "fixtures" build step is ~150-175s on this machine, but that is
entirely `fx-puts`'s own pre-existing, unrelated `bindings` step (`BINDINGS_FIXTURES = {'puts'}` in
`build-fixtures.mjs`: a second native `cargo test export_bindings` compile), measured at
`bindings 149060ms` in isolation -- a cost this milestone never touches and that already existed on
`6b43c09`. 0020 itself already defers "measuring the 30s rebuild target ... because no code exists
to measure" as a known Phase 3 gap; this session's own measurement is the first real number for it,
and it shows the budget was already far exceeded before M24b for a reason outside this brief's
scope. Flagged for the orchestrator, not fixed here.

**Test-injected-defect verifications (per-test "hunt for tests that cannot fail"):**
- `identity_compare_matrix`: manually swapped an expected `NeedsMigrate(Schema)` case's expected
  value to `Direct` -- failed with a clear mismatch, reverted. Fix round 1: also re-introduced the
  reverted early `if self.schema_version > running.schema_version { return Incompatible(...) }`
  branch (plus the `Incompatible` variant) and re-ran -- failed exactly at the newer-stored-schema
  case (`left: Incompatible(Schema), right: NeedsMigrate(Schema)`); reverted both.
- `rescale_matches_0006_rounding`: temporarily changed `Rescale::ticks`'s rounding to plain
  truncation (dropped the `2*`/ties-up doubling) -- `20->30` at `d=25` (12.5 exact) then rounded
  down to 12 instead of 13, test failed; reverted.
- `migrate_v1_to_v2_preserves_ids_and_occupancy`/`migrate_drops_timers_of_dropped_entities`: the
  auto-wake bug above *was* exactly this category of finding, caught by the drop test's own
  fires-progression assertion before any fix was in place.
- `migrating_footprint_collision_is_incompatible`: temporarily removed the `check_collision` call
  from `Migrating::put_entity` -- migrate then returned `Ok` (both entities silently overlapping
  the same tile) instead of `Err(SaveIncompatible)`; test failed; reverted.
- Arena peak-use: see the `drain_entities`-clone experiment above.

No existing golden moved (`pnpm test rust`/`wasm` counts: 529->551 native, 124->133 wasm, both
exactly the new tests added here plus fix round 1's own new test, no existing test changed).

ADR note: 0005 Upgrades says re-executing the tail is safe because "at worst an action is now rejected". With postcard that is not strictly true when `G::Action`'s layout changed between builds: old bytes can decode into a different *valid* action. 0024 §3 amends 0005 for this case (`SCHEMA_VERSION` also covers `G::Action`; the tail is dropped when it differs); decision 6 above implements it, it does not re-decide it.
