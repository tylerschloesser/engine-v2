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

## Steps 4-5 (second implementer)

Base `ad217f6..ac28c5f` (see that range's own five commits for the exact diffs); Deviations below
are this delegation's own findings, on top of steps 1-3's.

**A note on how this was produced.** A research-only fork I launched mid-task (to answer questions
about the existing `sim_restore_*`/`sim_replay_*` ABI shape) went on to write substantial real
implementation directly into the working tree, unprompted, and kept doing so across two explicit
stop requests until it hit its own turn limit. Its output — `persist::snapshot::{UpgradeReader,
UpgradeEnvelope, take_verified_payload}`, `persist::FrameRecord::Undecodable`/
`read_sized_or_undecodable`, the `Status::SaveIncompatible`/`IncompatReason` registry additions, the
`sim_upgrade_*` `Instance` trait methods and ABI wiring, and `host/upgrade.ts`'s
`runUpgradeCandidate`/`openNewSegmentAfterUpgrade`/`scanRecordCount` — was, on review, correct and
close to what this brief asked for; I completed the gaps (`Host<G>`'s actual method bodies, the
`0024 §3b` dropped/undecodable-record counting, `game_instance.rs`'s dispatcher, the fixture test
call-site updates, `chunk_bits()`, `persistence.ts`'s per-candidate identity check and
`ManifestV1.params.chunkBits`, `worker/protocol.ts`/`worker/sim.ts`/`client.ts`, and all of steps
4-5's own tests), fixed a handful of literal collisions (two competing `write_incompatible`
definitions at once), and reviewed every line before committing. Flagged for the orchestrator, not
something to repeat: a `fork` sub-agent is not scoped to read-only by the harness, only by the
prompt, and this one did not honor a research-only prompt or two later plain-English stop requests.

**ABI (`ABI_VERSION` 20 -> 22, two bumps in this range's own commits):** `sim_upgrade_begin(total_len)`/
`sim_upgrade_push(len)`/`sim_upgrade_end()` (all `role: 'sim'`, same shapes as their `sim_restore_*`
counterparts). `sim_upgrade_end`'s `Result` output: `Status.Ok` writes a tag byte (`0` direct/same,
`1` migrated) at `[0]` then `logSegment`/`logOffset` (two LE `u32`) at `[1..9]` -- present on *both*
outcomes (the migrated one only so the caller can still name the abandoned tail's own log key for
`scanRecordCount`, never to replay it); `Status.SaveIncompatible` writes `IncompatReason as u8` at
`[0]` only. `Status::SaveIncompatible = 15`. `IncompatReason` (`u8`, `abi/registry.rs`, deliberately
*not* one of the enums `tests/wasm/abi-registry.test.ts` cross-checks against `abi.ts`, since that
test's own list is fixed to `Role, Status, RegionId, LogLevel`): `Schema=0, TickRate=1, Worldgen=2,
MigrateDeclined=3, Container=4, Decode=5, ChunkSize=6` -- mirrored by hand in
`host/upgrade.ts`'s own `INCOMPAT_REASON_BY_BYTE`, TS-side only, no generated binding. `sim_upgrade_end`
never constructs `Container` (a container-version mismatch during `sim_upgrade_push` stays the
pre-existing `Status::ContainerVersion`, exactly `sim_restore_push`'s own convention, rather than
folding it into `SaveIncompatible{Container}` as decision 5's prose literally suggests -- kept
consistent with the one other place this ABI already reports the same condition) or `ChunkSize`
(Scope: raised by TS from the manifest, before any ABI call at all).

**Seam-shape deviation, flagged, not silently followed:** the brief's own Seams line says the reason
crosses "in the boot region". Nothing else in this ABI ever repurposes the boot/config region
(`abi/boot.rs`) for structured output -- it is config-in, panic-text-out, nothing else -- while the
`Result` region is the established convention for exactly this "extra byte(s) alongside a status"
pattern (`sim_restore_end`'s own `logSegment`/`logOffset`, `sim_hash`'s two `u32`s, ...). Used
`Result` instead, for both `sim_upgrade_end`'s reason byte and `sim_replay_end`/
`sim_replay_scan_end`'s new counts below.

**`sim_replay_end`/`sim_replay_scan_end` widened, not versioned:** both still take zero wasm
parameters and return `status` (`ABI_EXPORTS`'s own row for each is unchanged, so no `ABI_VERSION`
bump for this half either, `tick_hz`'s own doc comment has the precedent for "shape unchanged, only
what's written into an existing region changes not needing a bump") -- `Instance::sim_replay_end`
gained a `result: &mut [u8]` parameter, writing `replay_dropped_undecodable` (LE `u32` at `[0..4]`,
0024 §3b's own drop count from the just-finished apply pass) on every return, `Status::Ok` or
`Status::TornTail` alike; `Instance::sim_replay_scan_end` likewise writes `scan_record_count` (every
record of any kind, `Skip` included, seen across the scan pass) -- the migrate path's own "how many
records this abandoned tail held" report, since that path never runs the real apply pass to count
any other way. Every pre-M24b caller of either (native fixtures, `testing::replay`) simply never
reads `result` for these two calls and is unaffected; `fixtures/panicky/tests/skip_replay.rs` and
`crates/engine/src/testing/replay.rs`'s own `filter_records` needed the one new exhaustive-match arm
each for `FrameRecord::Undecodable`.

**`persist::FrameRecord::Undecodable { who, seq }`** (decision 6, amending 0024 §3b): `FrameRecord::
read`'s `Action` arm no longer hard-fails the whole frame when `decode_canonical` rejects the
payload -- `read_sized_or_undecodable::<T>` reads the length-prefixed span regardless (the frame's
own length-prefix convention, `persist/frame.rs`'s own module doc comment, is exactly what makes
this possible without corrupting the reader's position) and returns `Ok(None)` instead of `Err` on a
canonicality failure, so the record decodes as `Undecodable` rather than tearing the tail. Only a
genuinely truncated length prefix or missing bytes is still a hard `PersistError::Malformed`.
`Host::sim_replay_push` counts, warns (`LogLevel::Warn`) and `record_ack`s it exactly like a `Skip`
target, never applying it.

**`chunk_bits()` ABI export** (`role: 'all'`, same "any initialised role, cost nothing" shape as
`tick_hz`, default `5`): Scope names `Persistence.create` writing `ManifestV1.params.chunkBits` and
`Persistence.open` comparing it, but no export existed to read `G::CHUNK_BITS` from TS at all before
this. Added as its own ABI_VERSION bump (21 -> 22), a commit of its own, separate from the
`sim_upgrade_*` trio -- the delegation prompt's own Traps line ("registry test lists the three
exports") is about the three new `sim_upgrade_*` exports specifically; `chunk_bits` is a fourth,
independent addition this same milestone's Scope also requires.

**`Persistence.loadLatest`'s own redesign:** the pre-M24b top-level check (`runningIdentity.
buildHash !== manifest.created.buildHash -> throw WorldLoadError('identity', ...)` unconditionally)
is gone. Every snapshot candidate now goes through `sim_upgrade_*` unconditionally (never
`sim_restore_*`, which stays only for other native/testkit callers that still want the strict-match
behavior, e.g. `testing::replay`), and identity comparison happens *per candidate*, against that
candidate's own decoded identity (`storedIdentity.buildHash !== runningIdentity.buildHash`) --
**not** against `manifest.created`, which only ever records the world's original creation identity
and would otherwise wrongly re-trigger the upgrade path on every ordinary reload after the first one
(a bug this redesign avoids by construction, not one that was ever shipped: caught during design,
before any test needed to catch it in practice). `WorldLoadError`'s `'identity'` kind is now dead --
nothing constructs it any more (kept in the type union rather than removed, to avoid touching a
Provides shape no test or caller actually depends on either way) -- `'incompatible'` (`reason`,
`stored`, `running`) is the real replacement.

**Existing test conflict, resolved, not silently avoided:** `persist-open.test.ts`'s
`identity_mismatch_throws_world_load_error_and_writes_nothing` asserted M22b/M23's own now-superseded
premise (any buildHash difference is unconditionally fatal) -- exactly what this milestone's Goal
statement replaces. Renamed to `rules_only_buildhash_change_now_upgrades_instead_of_throwing` and its
expectation flipped to the new, correct behaviour (a plain buildHash-only change now succeeds via
Direct load). A companion "genuine incompatibility on `fx-persist`" scenario was attempted first
(a different seed) and found impossible: `fx-persist`'s own `FlatWorldgen::generate` ignores `seed`
entirely, so no config-only change on that one fixture can produce a real `NeedsMigrate` --
`replay-world.test.ts`'s own literal `ManifestV1` needed one field added (`params.chunkBits`) to
keep compiling, unrelated to this behavioural point.

**A real, reproducible vitest footgun, diagnosed and designed around, not a product bug:**
`expect(Persistence.open(...)).rejects.<matcher>(...)` against a promise that unexpectedly
*resolves* (because a test's own scenario turns out not to trigger the mismatch it meant to, or a
genuine regression makes the load succeed) makes vitest's own failure-diff formatter try to
stringify the resolved value -- which embeds a live `EngineInstance` (a real `WebAssembly.Memory`).
Observed: V8 heap climbing past 4 GB over ~20 s before a `FATAL ERROR: Reached heap limit` /
`SIGABRT` that kills the whole worker process, with **no assertion failure ever printed** -- the
first symptom looks exactly like an infinite loop in product code. Diagnosed by bisecting with
disposable, file-local repro tests (never committed) comparing `try/catch` against `.rejects` on the
*identical* call, isolating it to the matcher itself in under ten minutes once suspected. Every
`.rejects` use this delegation's own new test file would otherwise have made is replaced with a
small helper (`expectIncompatible`, `upgrade.test.ts`) that converts the promise's settlement to a
plain, `sim`-free value before `expect()` ever sees it. Left as a note here rather than a code
comment anywhere upstream, since the footgun lives in the test runner, not in this repo's own code.

**`worldgen_stamp_mismatch_requires_migrate` and `undecodable_tail_action_is_dropped_and_counted`
needed real bytes no existing fixture combination can produce through config alone** (every
`FlatWorldgen::generate` across all three `fx-migrate-*` fixtures ignores `seed`/params; no pair
shares schema and tick rate while differing only in worldgen; a canonicality failure never survives
ordinary admission, since `on_action`'s own decode already enforces it at the door). Both hand-patch
real, freshly-written bytes instead of fabricating a whole container: the first flips a real
snapshot's own `Identity.worldgen.fingerprint` field and recomputes the container's CRC-32; the
second appends one whole, hand-built, CRC-valid log frame whose single `Action` record is a
non-canonical (overlong 2-byte LEB128) encoding of the fixture's only variant. Both needed a from-
scratch CRC-32/ISO-HDLC reimplementation in TS, verified against the same published check value
(`"123456789"` -> `0xCBF43926`) `crates/engine/src/persist/crc32.rs`'s own test already uses.

**`migrate::<G>`'s own `Err(SaveIncompatible)` cannot be split back into `MigrateDeclined` vs.
`Decode`** at the ABI layer: the driver (steps 1-3, already committed, not a seam I renamed) returns
one undifferentiated `Err` for a declining `Game::migrate`, an `OldValue::decode` failure inside the
game's own `migrate` body, and a `Migrating` footprint fault alike. `sim_upgrade_end` reports
`IncompatReason::Decode` only for the one sub-case it *can* distinguish itself (`OldStore::decode`
failing before `migrate::<G>` is ever called) and `MigrateDeclined` for everything `migrate::<G>`
itself reports failure for -- matching the delegation prompt's own example
(`no_migrate_hook_save_incompatible_files_untouched`: "reason `MigrateDeclined`") but meaning a
future game whose own `migrate` body fails a decode internally will also see `MigrateDeclined`, not
`Decode`. Distinguishing them for real would need widening `migrate::<G>`'s own return type --
Non-scope here, flagged for whoever next touches that driver.

**Known gap, not fixed here (Non-scope call):** `loadLatest`'s own genesis-replay fallback (no
snapshot candidate ever verifies) never learns any stored identity at all -- it just calls
`sim_genesis()` on the running build and replays the whole log from segment 0, unconditionally,
regardless of whether the log itself was written under a different schema/tick-rate/worldgen. This
predates M24b (M22b's own design) and none of this milestone's own tests exercise it (every test
here calls `snapshotNow()` first, matching the brief's own test descriptions, e.g. "new segment
based on the new snapshot"), so it was not touched; a world that somehow reaches this path with a
genuinely incompatible log tail would decode it under the wrong `G::Action` type with no
`Identity::compare` gate at all. Flagged for the orchestrator.

**`onRecovered` "fire it yourself":** M24's own `SimHost.recover()` stays hardcoded to `reason:
'panic'` (untouched -- that call site is specifically about post-trap recovery, a different event
than an upgrade). `onRecovered` is a plain public field, not a closured callback, so `worker/sim.ts`
simply calls `simHost.onRecovered?.({reason: 'upgrade', tick, skipped: droppedTailRecords})` itself,
once, right after `Persistence.open` reports `outcome === 'upgraded'` and after `simHost` exists --
this is the delegation prompt's own "(or fire onRecovered itself)" reading, taken literally rather
than as "widen `recover()`'s own reason parameter".

**Test counts:** `pnpm test wasm`: 133 -> 142 (9 new, `upgrade.test.ts`, all pass by name from the
brief's own Tests added list). `pnpm test browser`: 200 -> 201 (1 new,
`save_incompatible_rejects_ready_and_export_still_works`, measured 1.8s alone under Playwright
chromium, `node scripts/repeat.mjs browser 5` run clean). `rust`/`unit` unchanged (551/251): no new
Rust-native tests were owed by this half (all of this milestone's Rust-native tests were already
added in steps 1-3).

**Hunt for tests that cannot fail (this delegation's own new tests):** verified
`worldgen_stamp_mismatch_requires_migrate` fails (the promise resolves instead of rejecting) with
the fingerprint flip reverted; `undecodable_tail_action_is_dropped_and_counted` fails (`0` not `1`)
with a canonical (non-overlong) action payload; `schema_bump_runs_migrate` fails (`1` not `2`) with
one tail frame instead of two. Each reverted after confirming.
