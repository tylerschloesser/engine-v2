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

**Module split and re-exports.** `WorldRead`/`WorldWrite` (full, exactly as 0003) live in a new
`src/world_access.rs` (`View` too); `Authority<G>`, `Scope`, `Scopes`, `ChangeLog<G>` and `TickCx`
live in a new `src/authority.rs` (`TickCx` delegates every method to the `Authority` it wraps, per
Planning decisions). `game.rs`'s old shell `trait WorldRead<G> {}` / `trait WorldWrite<G> {}` /
`struct TickCx<'a, G>` are replaced with `pub use crate::world_access::{WorldRead, WorldWrite};`
and `pub use crate::authority::TickCx;`, so every pre-existing `use crate::game::{WorldRead,
WorldWrite, TickCx}` (store.rs, client/upload.rs, client/texel.rs, `tests/no_alloc_store.rs`)
keeps compiling unchanged -- no seam was renamed, only relocated with a re-export at its old path.

**`TickRate::hz` (0006) collides with M12's placeholder `hz(self) -> u32` getter.** 0006 names
`hz` as the `u32 -> TickRate` constructor (the whole point of this milestone's Read First #4), but
M12 had already built a differently-shaped `hz` (a getter) just to make `HZ_20` testable, with its
own module doc comment flagging conversions as "M12b's". The two cannot coexist under one name, so
`hz` is now the 0006 constructor and the getter is renamed `hz_value()`; M12's own
`time::tests::hz_20_is_20` (the only existing test touching it) now asserts `HZ_20.hz_value() ==
20` instead of `HZ_20.hz() == 20` -- the same assertion, reached through the renamed accessor. No
test was weakened, skipped or deleted; flagging here per "if an existing test has to change" since
the call site itself changed. `TickRate::DT` (0006's prose, an associated const in the ADR's
sketch) is a method `dt(self) -> f32` instead: `TickRate` varies per game (`Game::TICK_RATE`), so a
single associated constant cannot hold every game's value; `TickRate(u32)`'s field stays private,
so the sketch's `self.hz` field access was never literal Rust either.

**`Delta<G>` gains a 7th, engine-only variant: `Ack { who: PlayerId, seq: u32 }`.** The Scope
bullet's "step runs records ... (apply, then `last_seq = seq`)" needs `PlayerSlot::last_seq`
(M12's own field, doc-commented "is sim state") to change, and `Store::apply` is that state's only
mutator (`crate::store`'s own doc comment) -- so reaching it needs a `Delta` variant, not a private
backdoor. `Authority::record_ack` applies it directly to `Store` (`self.store.apply(&Delta::Ack
{..})`), deliberately bypassing `Authority::write`/the `ChangeLog`: 0004 delivers acks to a client
over their own `Ack<G>` channel ("acks ride on deltas", never a rebroadcast `Delta`), so an `Ack`
delta must never appear in the `ChangeLog` a client-facing frame is eventually built from. Additive
only -- `Store::apply`'s other six arms, `write_canonical`/`decode` and every existing golden are
unchanged (`store_golden_bytes` still passes byte-for-byte, since none of its fixture data uses
`Ack`).

**`Sim::genesis`'s `where G::Global: Default` bound.** `Store::new(terrain, global: G::Global)`
needs a real value before `Game::genesis`'s own first `put_global` overwrites it, and `G::Global`
carries no `Default` bound on the `Game` trait itself (M12's own doc comment on `Store::new`
already names this as the reason the parameter is explicit rather than computed internally). Rather
than add `Default` to `Game`'s associated-type bound (a Provides rename, and a burden on every
future `G::Global`), the bound lives only on `Sim::<G>::genesis`, the one place that needs it.
`fx-puts::Global` already derives `Default`. `Authority::new` itself takes no such bound -- its
caller supplies the value however it likes (`Sim::genesis` via `Default`; `puts_cache_invisible`'s
test via `Default::default()` at the call site too, since it also happens to be convenient there).

**`WorldRead::entity_at` is always `Ok(None)` this milestone (Authority, `TickCx`, `View` alike).**
Occupancy tracking is explicitly Non-scope (M21), and nothing populates an index to answer from.
This is not a stub left broken by accident: `fx-puts::Puts::apply`'s `Bump`/`Remove` handlers call
`entity_at` first and therefore always, deterministically, reject `NotFound` without writing --
which is exactly the "includes rejected actions" golden coverage the brief asks `puts_script_a` for
(a real `apply`/reject round trip through `Sim::step`, not a synthetic one), and is why
`rejecting_apply_wrote_nothing` uses `fx-puts`'s own `Bump` rather than a contrived handler.
`WorldRead::traits_at`'s default-shaped behaviour (spike: tile traits OR occupant traits) is
therefore the tile term alone everywhere, for the same reason.

**`testkit::run_script`'s `Tick` contract.** A script entry's `Tick` names the *ordinal* of the
`Sim::step` call that delivers it (the 1st call lands on `Tick(1)`, matching `sim.tick()` once that
call returns), not the tick value handlers observe *during* that call: `Sim::step` advances the
tick as its last action (Scope: "then advances the tick"), so records and `Game::tick` for a given
`step` call run while `authority.tick()` still holds the *previous* value. One visible consequence:
`Game::genesis` and the first `Sim::step` call both run with `w.tick() == Tick(0)`. Documented in
`run_script`'s own doc comment; `puts_idle_100` (a bare loop of `sim.step(&[], ..)`, no `testkit`)
and every `puts_script_a` entry were written against this contract, not the other reading.

**`fx-puts`'s replicated types, redesigned per M12's own Deviations note ("M12b may adjust").** The
M12 placeholder (`SetTile`/`Spawn`/`Despawn`/`Deposit`/`SetGlobal` over a bare `amount: u16`
entity) is replaced by the handler set this brief's Scope names verbatim: `Action::{Paint, Spawn,
Bump, Remove, SetNote, SetMotd, Roll}`; `Entity { pos: Pos, kind: u8, amount: u16 }` (carries its
own anchor, 0024 §7 -- `Game::anchor`/`prototype` take no position argument); `Player { note: u32,
note_until: Tick }`; `Global { day: u32, motd: u32, last_roll: u32, walk_i: u32 }` (`walk_i` is
`tick`'s own cursor into the fixed 8-tile walk -- it has to live in `Global` since only `Store`
persists between calls). `Reject::{Unknown, NotFound}` unchanged in spirit from M12.

**Measured.** `pnpm test`: `rust` 168 -> 188 (+20), `unit` 145 (unchanged), `wasm` 38 (unchanged),
`browser` 90 (unchanged). `pnpm lint` green (biome, rustfmt, clippy, tsc). `pnpm test rust -t puts`
-> 3 tests (nextest's `-t` matches the bare test *name*, not the crate/binary path, so only
`puts_idle_100_golden`/`puts_script_a_golden`/`puts_cache_invisible` match "puts" literally; the
rest of the new suite -- `puts_apply_contract.rs`'s three tests, `replay_equals_live`,
`truncated_log_differs` -- pass under the full `rust` run). `pnpm test rust -t ticks_conversion` ->
1 test. The `hz(9)`-to-`hz(10)` check (second exit criterion): `pnpm test rust` stopped with `build
FAIL doctests`, the doc test at `time.rs` line 66 reporting "Test compiled successfully, but it's
marked `compile_fail`" -- reverted immediately after, `pnpm test rust` green again (`188 tests`).
Goldens blessed with `node scripts/golden-bytes.mjs -p fx-puts` (the `-p` filter did not narrow
nextest's run -- it reran the whole workspace under `GOLDEN_BLESS=1` -- but every pre-existing
`.hex`/`.hash` file came back byte-identical, confirmed by `git status` showing no modified golden
files, only the two new ones): `puts_idle_100.hash` = `195e71ef0defbf7a`, `puts_script_a.hash` =
`7bdddfc9c749b1fb`. Commits `1d75914`..`1efb931` (five: four `M12b step N` plus one `M12b:`
context-artifact commit).
