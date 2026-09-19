# M12b: `WorldRead`/`WorldWrite`, `Authority`, `Ticks` and the `Sim` driver

Status: not started · After: 12 · Tyler-dependent: no

Split from M12 (see that brief). M13 and M14 depend on this milestone, not on M12.

## Goal
`genesis`, `on_player`, `apply` and `tick` of a fixture game run natively through `Authority<G>`; every put applies to the `Store` and is recorded as one scoped `Delta`. A `Sim<G>` driver runs recorded frames in 0004 order and ends scenarios in checked-in golden hashes. `Ticks` conversions are `const fn`s.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0003-game-facing-api.md` (trait block for `WorldRead`/`WorldWrite`; "Contexts"; the author's rules)
3. `docs/decisions/0007-world-model.md` (§1 totality and `Unknown`, §2 coordinates and range, §5 anchor ownership)
4. `docs/decisions/0006-time-units.md` (Decision: types, conversion rule, where it happens)

Mine from spikes: `spikes/prediction-api/engine/src/lib.rs` (`Authority::write`, `View`, the reject-wrote-nothing assert), `game/tests/prediction.rs` (`host_replay_from_genesis_*`). Rules that apply: `.claude/rules/determinism.md`.

## Scope
- `WorldRead<G>` / `WorldWrite<G>` exactly as 0003; object-safe; upcasting test.
- `Authority<G>`: wraps `Store<G>` (whose `TerrainStore` is built over `worldgen::Pristine<G::Worldgen>`, so a read that misses generates in place) + `SimRng` + current `Tick`. A write = `Store::apply` + push `(Scopes, Delta)` to a reused `ChangeLog<G>`. Scope derivation: tile → `Chunk(chunk_of(pos))`; entity → `Chunk(chunk_of(G::anchor(e)))` (old and new anchor on a move; M21 widens to the footprint); player → `Player(who)`; global and roster → `Global`. Writes outside the coordinate range are debug-asserted and ignored (0007 §2).
- `View<'_, G>`: read-only `WorldRead` over a `Store` plus a "held chunk" predicate (always true on the host; M15 supplies the replica's).
- Minimal `TickCx<'_, G>`: implements `WorldWrite` by delegating to `Authority`; `as_write()`, `player_count()`, `player_id_at(i)`. Final shape below.
- `TickRate::{millis, secs, DT}` per 0006; compile-fail doc test for `hz()` outside the range.
- `Record<G>` = `Action { who, seq, action }` | `Player { who, ev }`; `Sim<G>::{genesis(WorldParams<G>), step(&[Record<G>], &mut Vec<Outcome<G>>), tick(), state_hash(), authority()}`. `step` runs records in order (`on_player`, or `apply` then `last_seq = seq`), then `G::tick`, then advances the tick. A rejecting `apply` that recorded a write panics (0004 Consequences). `WorldParams<G>` = seed, `Worldgen::Params`, state-budget fields of 0009 `WorldConfig.params`.
- Fixture `puts` handlers: `Paint { pos, tile }`, `Spawn { at, kind }`, `Bump { at }`, `Remove { at }`, `SetNote { n }` (writes `note_until = w.tick() + NOTE_TTL`), `SetMotd { n }`, `Roll` (uses `rng`). `tick`: every `TICK_RATE.secs(1)` bump a `Global` counter and `set_tile` the next tile of a fixed walk near the origin (M15b needs an overlay that changes without any action); clear a player's note at `note_until`.

## Non-scope
`Predicting` (M25). Footprints, occupancy, `traits_at` occupant lookup, timers, state-budget check (M21, M21b). Any ABI export (M13). Log bytes (M22).

## Files, packages and crates touched
`packages/engine/crates/engine` (modules `world_access`, `authority`, `sim`, `time`), `packages/engine/fixtures/puts`, golden files beside M05's; one row in `scripts/suites.mjs` (build step `doctests`).

## Seams
**Provides:** `WorldRead`, `WorldWrite`, `Authority<G>::{changes, clear_changes, store, tick}`, `ChangeLog<G>`, `Scope`, `Scopes` (≤ 4 chunk scopes), `View`, `TickCx` (minimal), `TickRate::{millis, secs, DT}`, `Record<G>`, `Outcome<G>` (`seq`, `Result<Applied, Rejected<G>>` per 0004), `EngineReject`, `Sim<G>`, `WorldParams<G>`; goldens `puts_idle_100`, `puts_script_a` (M05 `assert_golden_hash!`); test helper `testkit::run_script(&[(Tick, Record)]) -> u64`.
**Consumes:** M12 everything; M07 `TerrainStore`, `testing::assert_cache_invisible`; M08 `Worldgen`, `Pristine<W>`; M05 `assert_golden_hash!`, `GOLDEN_BLESS`/`pnpm golden:bytes`.

## Planning decisions
- **Exact `TickCx` shape (PRE-PLAN §10).** `TickCx<'a, G>` is a struct, not a trait, implementing `WorldRead + WorldWrite` (`rng()` is `Ok`). Inherent methods, index-based so rules can write while iterating: M12b `as_write()`, `player_count()`, `player_id_at(i)` (ascending `PlayerId`); M21b `next_woken()`, `next_due()`, `wake(id)`, `wake_at(id, Tick)`, `cancel_wake(id)`, `activate(sys, id)`, `deactivate(sys, id)`, `active_len(sys)`, `active_at(sys, i)`. No entity-wide iteration exists: that is what keeps tick cost O(active) (0007 §7). Player timers have no wheel: `tick` scans the player table, which holds tens of rows.
- **Puts made through `TickCx` do not auto-wake; puts made by `apply`/`on_player`/`genesis` do** (0024 §7; mechanism in M21b). Stated here because it is why `TickCx` and `Authority` are distinct types.
- **`Applied` carries nothing**, per `0022-entity-ids-and-provisional-ids.md` §6 (tile addressing; no id map).

## Order of work
1. traits + upcast test. 2. `Authority` writes + `ChangeLog` + scopes. 3. `View`. 4. `Ticks` conversions. 5. `TickCx` minimal, `Sim`. 6. fixture handlers. 7. scenarios, goldens, replay and cache-invisibility runs.

## Tests added
Rust native: `every_put_is_one_delta_with_scope`; `rejecting_apply_wrote_nothing` (and `#[should_panic]` twin with a deliberately bad handler in a test-only game); `host_reads_are_total`; `missing_player_is_unknown`; `joined_must_put_player`; `ticks_conversion_20_and_30_hz` (0006 Consequences); `puts_idle_100_golden`; `puts_script_a_golden` (includes rejected actions and `Roll`); `replay_equals_live`; `truncated_log_differs`; `puts_cache_invisible` (M07 harness: capacity 1 / default / unlimited); `authority_put_existing_key_no_alloc`; `dt_is_reciprocal` (`DT` equals `1.0 / hz` bit-exactly at 20, 30 and 60 Hz). Doc tests on `TickRate::hz`, named `tickrate_hz_out_of_range`: two `compile_fail` blocks, `const R: TickRate = TickRate::hz(9);` and `hz(61)`, beside a passing block for 10 and 60. They verify both the compile error of 0006 and the tick-rate range of 0010 Rates: a game's `TICK_RATE` can only be built by `hz`. nextest runs no doc tests, so this milestone adds the build step `doctests` to `scripts/suites.mjs` (`cargo test --doc -p engine`, quiet, log captured like every step; a failure fails the build phase).

## Exit criteria
- [ ] All tests above pass; goldens were generated by M05's explicit command, not by hand.
- [ ] Changing `hz(9)` to `hz(10)` in the first `compile_fail` block makes `pnpm test rust` stop in the build phase naming step `doctests` (check, then revert).
- [ ] Goldens here are native-blessed (`assert_golden_hash!`) because no sim ABI path exists yet. M13 adds `fixtures/puts/golden/scenario.json`, blesses it from the `.wasm` run with `pnpm golden puts`, and switches `puts_idle_100_golden` to M02's `assert_golden` so the `.wasm` value is authoritative (0002); M16 does the same for `puts_script_a`.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t puts` · `pnpm test rust -t ticks_conversion` · `pnpm lint`.

## Budgets
Allocation: zero in `apply`/`tick` steady state on the fixture (counting allocator). Rust native suite stays inside its 0020 §3 budget; demote nothing.

## Context artifacts
`packages/engine/fixtures/CLAUDE.md` (one line per fixture: what feature it pins). Crate `CLAUDE.md`: the two author rules and where the assert lives.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
