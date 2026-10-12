# M48: Replication robustness in the engine (restore re-declaration, chunk-version stamp, lost-frame deltas, bundles)

Status: not started · After: 47b · Tyler-dependent: no

Rewritten on 2026-10-12 after a read-only survey of the code M47 and M47b built (`docs/plan/47-forecasts-and-corrections.md` Deviations, [0078](../decisions/0078-transport-forecast-replication.md) A8-A9, [0079](../decisions/0079-transport-core-decisions.md) §17-§19): the earlier brief assumed forecasts stayed dirty on overflow, a one-second resend and a kept chunk keeping its structures; none of these is how the engine works. Split the same way as M42-M44 and M47: this milestone is the engine half (defects and hooks, Rust tests); `48b-replication-scenarios-and-join.md` is the netcode half and ends the phase (tag `belts-replicated`).

## Goal
Replication survives what production does to it: a restored host declares its spawners again, a chunk's version means the same on the host and the replica, a lost frame never leaves a held chunk desynced or panics the bundler, and a degraded connection bundles belt-sized frames without allocating.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (A8: the as-built scheme; A9) and `docs/decisions/0079-transport-core-decisions.md` (§18-§19)
3. `docs/plan/47-forecasts-and-corrections.md` Deviations ("Lost-frame `no_alloc` attribution", "Review fixes, round 3") and the survey `scratchpad/m48-research.md` handed with the sub-agent brief
4. `docs/architecture/sync-and-netcode.md` ("Rates": degrade and the chunk bucket; "Sessions": the resume hint), `docs/architecture/persistence.md` (restore)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`. Skills: `run-tests`.

## Scope
- **Spawner re-declaration after restore** (found in M47's review). A `set_spawner` schedule lives in the host's tracker only (derived, never encoded), so a restored, upgraded or migrated host has none until the game declares again (`transport/mod.rs` `set_spawner` doc), and every spawner insert routes as an `Arrival` meanwhile. Build the hook (decision below) and have `fx-belts` use it. `belts_restore_keeps_spawner_schedules` (Rust, `BenchHost` on the 1/64 `Mixed` world: save at tick 300, restore into a fresh host, run 60 ticks: `spawner_mismatches` 0, `spawner_declarations_dropped` 0, no `ROUTE_INSERT` crossing after the first restored tick, the restored host's items equal a never-restored host's every tick).
- **Chunk-version drift** (found in M46's review). `Host::tick` stamps every `Scope::Chunk` of every change, including an entity put and gone in one tick, which the replica never sees (it bumps only on an applied delta), so the region hashes differ while the chunk hashes agree and a resume hint over-sends such a chunk. Stamp by a rule both sides can derive (decision below); `region_hash_agrees_after_same_tick_spawn_despawn` (Rust, Loopback, `fx-belts` requests at the origin) and the resume hint keeps the chunk; remove the `O = 200` workaround and its comment in `tests/netcode/belts.test.ts` and the note in `tests/netcode/CLAUDE.md`.
- **A lost frame's held-chunk deltas** (found in M47's `no_alloc` attribution): `Host::seal` clears the change log after every connection's build, and a frame that overflows (`SliceSink::finish` `Err`) returns its entering chunks but never re-sends a held chunk's `ChunkDeltas` of that tick, so every lossy window raises client chunk-hash desyncs (2-16 per window). Fix by the rule the lines already follow (decision below); `lost_frame_never_desyncs_a_held_chunk` (Rust: the lossy windows of `no_alloc_connection`'s `host_and_client_lost_frames_do_not_grow` on both worlds, `DesyncLog` count 0 on every client over 1,024 ticks), and `host_and_client_lost_frames_do_not_grow` stays at 0 B host growth.
- **`Pacing::take_bundle` never panics**: the fit check exempts the first held frame, and `out[..first_len].copy_from_slice` panics when it is longer than `out`. Make it an `Err` the caller handles (the frame stays held; a counter) with a test (`pacing_bundle_first_frame_larger_than_out`), or a checked precondition at the one production call site with the same test proving the check.
- **Bundles of belt-sized frames**: `Pacing::hold` is `Vec::with_capacity(8192)` and grows when a level-4 bundle of 54 KB frames is held (hot-path allocation). Reserve it at attach from the frame buffer size (`Tx`) and the level cap, or bound the hold and emit early; prove it: `no_alloc_connection` gains a degraded window (soft cap forcing level 2 then 4 on the lined world, 512 ticks) asserting 0 B host growth. `host_degraded_bundles_carry_forecasts` (Rust, Loopback with pacing on and a soft cap that forces level 2 and 4 on a saturated-view 1/64 world): every delivered bundle applies in order, items exact on every held line at every delivered tick (the follower's catch-up steps the skipped ticks), `degradeLevel` reaches 4 and recovers.

## Non-scope
- The netcode scenarios (prediction, edits during flow, degrade through the harness, reconnect, late join, paced bytes) and the tag: `48b-replication-scenarios-and-join.md`. Drawing items (M49). Position-window culling (0078 A6 (ii)).

## Files, packages and crates touched
- `packages/engine/crates/engine/src/`: `game.rs` (the re-declaration hook), `host/mod.rs` (the hook's call sites after `Sim::from_parts`; the version stamp; the lost-frame rule), `host/pacing.rs` (`take_bundle`, `hold`), `client/replica.rs` only if the stamp rule needs the replica's side, `transport/mod.rs` (doc of `set_spawner`), `tests/main/`, `tests/no_alloc_connection.rs`.
- `packages/engine/fixtures/belts/src/lib.rs` (the hook's implementation), `fixtures/belts/tests/` (the restore test), `fixtures/belts/CLAUDE.md`.
- `packages/engine/tests/netcode/belts.test.ts` and `tests/netcode/CLAUDE.md` (the workaround removed).
- `docs/architecture/sync-and-netcode.md` ("Rates", the lost-frame rule; "Sessions" if the hint's keep rule changes), `docs/architecture/persistence.md` (the hook, one sentence).

## Seams
**Provides:** `Game::declare_spawners` (or the decided hook), the stamp rule, the lost-frame delta rule, a bundler that never panics, the Rust tests above. **Consumes:** M47's tracker and counters (`forecast_host_counters`, `forecast_crossings`), M46's `LineRoute::lost` pattern, M45's `BenchHost`, `no_alloc_connection`'s band runner.

## Planning decisions
- **Re-declaration is a `Game` callback, not a per-tick read.** `Game::declare_spawners(&dyn WorldRead<Self>, &mut dyn FnMut(LineId, Schedule))` (default: nothing), called by the host once after every `Sim::from_parts` (restore, upgrade, migrate; not genesis, where the game declares on join). The game iterates its own spawner state and declares with the accumulator as saved (the post-step convention of 0079 §19 (a) holds across a save). Rejected: a `TickCx::restored()` flag (a derived read inside `tick`, one more phase flag) and `has_spawner(line)` read every tick (1,090 reads a tick for a case that happens once). The implementer may choose the flag form only if the callback cannot see the state it needs; record why.
- **The stamp rule is connection-independent.** `chunk_versions` is host-global and frames are per connection, so "stamp only what a frame carried" has no meaning. Rule: a chunk's version moves in a tick iff the tick's net effect on the chunk is visible: a tile write; an entity that exists at tick end and was put, moved into or changed in the chunk; an entity gone from the chunk that existed in it at tick start. A put and gone of the same id in one tick is invisible and stamps nothing. The replica already bumps only on applied deltas, which is this rule as seen through frames.
- **A lost frame re-snapshots the held chunks it changed**, the way it sends `Gone` for the lines it named (0078 A8): on `SliceSink::finish` `Err`, every held chunk with a delta in that tick's frame goes to `collapsed` (a `Resnapshot` through the bucket), unless the implementer finds a replay of the lost deltas that allocates nothing and is simpler; the hash test is the judge. Record the cost (a lossy window's extra snapshot bytes) in Deviations.
- **`take_bundle` returns what fits and reports what does not**: never a panic in `host/`.
- **`hold` is sized from `Tx`**: the bench's 54 KB frames at level 4 are the sizing case; whichever bound is chosen, `no_alloc_connection` proves it.

## Order of work
1. The re-declaration hook, `fx-belts`' implementation, `belts_restore_keeps_spawner_schedules` (inject: the hook not called after restore).
2. The stamp rule and `region_hash_agrees_after_same_tick_spawn_despawn`; remove the workaround (inject: stamp as today).
3. The lost-frame delta rule and `lost_frame_never_desyncs_a_held_chunk` (inject: the rule off); `host_and_client_lost_frames_do_not_grow` still 0 B.
4. `take_bundle` and its test; `hold` sizing, the degraded `no_alloc` window, `host_degraded_bundles_carry_forecasts` (inject: a bundle applied out of order, or the catch-up skipped).
5. `slow_tick_belts_large` three runs at quiet load against the M47b baseline (1.2638 ms; the stamp rule runs per change per tick: it must not move the median by more than noise, else attribute); Deviations; docs; `pnpm test`, `pnpm lint`.

## Tests added
Rust: `belts_restore_keeps_spawner_schedules`, `region_hash_agrees_after_same_tick_spawn_despawn`, `lost_frame_never_desyncs_a_held_chunk`, `pacing_bundle_first_frame_larger_than_out`, `host_degraded_bundles_carry_forecasts`, a degraded window in `no_alloc_connection`. Netcode: none new (the `O = 200` workaround removed from `belts.test.ts`, which must still pass with lines at the origin).

## Exit criteria
- [ ] Each test above passes with an inject-fail-revert recorded in Deviations.
- [ ] `tests/netcode/belts.test.ts` runs with `O = 0` (no workaround) and `assertConverged` holds.
- [ ] `host_and_client_lost_frames_do_not_grow` asserts 0 B host growth and 0 desyncs on both worlds.
- [ ] `slow_tick_belts_large` three runs at quiet load within noise of 1.2638 ms (recorded), the gate green.
- [ ] `pnpm test` and `pnpm lint` are green; `pnpm golden belts` idempotent (no golden moves: the stamp is bookkeeping, hashed as 0).

## Verification commands
`pnpm test rust -t restore_keeps_spawner` · `pnpm test rust -t region_hash_agrees` · `pnpm test rust -t lost_frame` · `pnpm test rust -t no_alloc` · `pnpm test rust -t degraded_bundles` · `pnpm test netcode -t belts` · `pnpm test:slow rust -t slow_tick_belts_large` (three runs) · `pnpm test && pnpm lint`

## Budgets
- `belts-tick` 1.2638 ms baseline (0079 §19 (d)), limit 5 ms; `no_alloc_connection` 0 B host growth per window; the netcode suite 10 s (unchanged here).

## Context artifacts
`docs/architecture/sync-and-netcode.md` ("Rates": one sentence on what a lost frame re-sends), `docs/architecture/persistence.md` (the hook), `packages/engine/crates/engine/CLAUDE.md` if a module moves, `packages/engine/tests/netcode/CLAUDE.md` (the workaround note removed).

## Manual device checks
none (M57).

## Deviations
(filled in during execution)
