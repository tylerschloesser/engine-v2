# M21b: Timer wheel, wake-ups, active lists, the completed `TickCx`

Status: not started · After: 21 · Tyler-dependent: no

Split from M21 (see that brief). M22, M25 and M32 list 21b in **After**.

## Goal
Tick cost is O(active entities): a machine computes its finish tick, sleeps on the timer wheel and costs nothing until it is due; an action that touches a sleeping entity wakes it at one fixed point of the next tick. `TickCx` has its final shape. Timers, wake queue and active lists are sim state: encoded in canonical order, hashed, replayed. The milestone also measures the host undo journal and decides it.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0007-world-model.md` (§7 "What ticks")
3. `docs/decisions/0006-time-units.md` ("Where it happens", "Rates and continuous quantities")
4. `docs/decisions/0003-game-facing-api.md` ("Contexts"; Consequences items 4 and 7)

The `TickCx` method list is in `docs/plan/12b-world-access-and-sim-driver.md` (Planning decisions); it is normative. Mine from spikes: `spikes/prediction-api` timer tests (`done_at` pattern), `alloc.rs`. Rules: `determinism.md`, `hot-paths.md`.

## Scope
- **Timer wheel** keyed `(Tick, EntityId)` (0007 §7): at most **one** timer per entity; `wake_at` replaces, `cancel_wake` removes, `despawn` removes. `next_due()` pops entries with `tick <= now` in key order. Implementation free (hierarchical wheel or ordered map) as long as iteration order is the key order and steady state does not allocate.
- **Wake queue.** Two lists: `woken_now` (served by `next_woken()`) and `woken_next`. Every `EntityPut` made through `Authority` **outside** `G::tick` (`apply`, `on_player`, `genesis`, `migrate`) pushes the id to `woken_next`, deduplicated, insertion order; `TickCx::wake(id)` does the same. Puts made through `TickCx` do not. Fixed point: at the start of `G::tick` the engine swaps the lists; whatever the game leaves undrained is dropped at the end of the tick.
- **Active lists.** `Registry::system(name) -> SystemId` (≤ 16); `activate`/`deactivate` are idempotent; iteration by `active_len`/`active_at` in insertion order; removals during iteration take effect at the next fixed point (tombstone then compact), so indices are stable within a tick; `despawn` deactivates everywhere.
- **`TickCx` completed** with the M21b methods of the 12b list; `Sim::step` constructs it. `TickCx` lives in `src/authority.rs` alongside `Authority`, `Scope`, `Scopes` and `ChangeLog` (M12b Deviations' module split, not a separate `tick_cx.rs`), so these methods extend the struct already there.
- **State.** `Store::encode` gains timers (key order), `woken_next` (insertion order), active lists (system order, insertion order), exactly where 0005 "Snapshot" places them; `state_hash` covers them. A client replica holds none of it.
- **Tick rules and the state budget.** A put or spawn through `TickCx` is never refused by the state-budget check (0007 §8 "soft by the margin", 0023 "The check", opening line); a `TickCx` spawn with no entity id left is an engine fault (0022 §2).
- **Fixture `machines` tick rule:** woken + `fed` + idle → `done_at = now + SMELT` (`const SMELT: Ticks = TICK_RATE.secs(5)`), `wake_at`; due → `count += 1`, continue or sleep; a `Spinner` prototype lives on an active list and toggles a field every `TICK_RATE.millis(500)` through the integer-accumulator pattern of 0006.
- **Undo journal experiment** (below).

## Non-scope
Player timers (none: `tick` scans the player table, see 12b). Bucketed area effects (not scheduled). Predicted timers and the completion gap (M25/M26). Persistence of this state to storage (M22 consumes `Store::encode`). Tick-time benchmark on the standard large save (M36).

## Files, packages and crates touched
`packages/engine/crates/engine` (`sim/timers.rs`, `sim/wake.rs`, `sim/active.rs`, `tick_cx.rs`, `authority` journal), `packages/engine/fixtures/machines`.

## Seams
**Provides:** `TickCx::{next_woken, next_due, wake, wake_at, cancel_wake, activate, deactivate, active_len, active_at}`, `Registry::system`, `SystemId`; extended `Store::encode`/`state_hash`; counters `entities_visited_per_tick`, `timers_pending`, `apply_rollbacks`; goldens `machines/smelt-cycle`, `machines/idle-world-costs-zero`; the journal decision (ADR written with the `write-adr` skill).
**Consumes:** M21 prototypes, fixture, `testkit::fill_world`, `testkit::set_next_entity_id`, the state-budget check; M12b `TickCx` minimal, `Authority`, `Sim`; M12 `Store`; M05 hash.

## Planning decisions
- **How `apply` starts a timer without a timer API (0024 §7 closes the gap between 0003 and 0007).** `apply` sees only `WorldWrite`, which must stay "every method is one put" and must behave identically under prediction, so it cannot call `wake_at`. Instead the put itself is the wake-up: the entity appears in `next_woken()` of the same tick's `G::tick` (actions run before tick rules, 0004), and the tick rule reads the value (`done_at`) and schedules. This is 0007 §7's "wake-ups are queued and applied at one fixed point" made concrete, adds no `Game` hook, and keeps the client free of tick machinery.
- **One timer per entity.** The reference game and both fixtures need one; replace-semantics removes the stale-timer bug class and keeps `despawn` O(1). An entity that needs two deadlines stores both and schedules the earlier.
- **Host-side atomicity of `apply` via an undo journal (PRE-PLAN §10, 2→3): measured and decided here.** Build `UndoJournal` in `Authority`: preallocated, records the previous value (or absence) of each key on its first put within one `apply`, plus index, wake-queue and count side effects; discarded on `Ok`, replayed backwards on `Err`. Measure with a native bench on `machines` (10k mixed actions, 5 % rejecting): **adopt if** median `apply` cost rises ≤ 10 % and the counting allocator shows zero steady-state allocations. Adopted → a rejecting `apply` that wrote is rolled back in release builds and counted in `apply_rollbacks`; debug and test builds keep the panic so authors still learn "validate first, write after". Not adopted → the assert stays. Either way record the numbers in an ADR that closes the item in 0003/0004/0012; if adopted, note in it that ADR 0023's "apply, measure, roll back" alternative became available.

## Order of work
1. wake queue + auto-wake in `Authority`. 2. timer wheel. 3. active lists + `Registry::system`. 4. `TickCx` methods. 5. encode/hash + roundtrip. 6. fixture rules, goldens, O(active) counter tests. 7. journal, bench, ADR.

## Tests added
Rust: `put_from_apply_wakes_same_tick`, `put_from_tick_does_not_self_wake`, `wake_dedup_and_order`, `undrained_wakes_are_dropped`, `timer_fires_at_exact_tick_in_key_order`, `wake_at_replaces`, `despawn_cancels_timer_and_lists`, `active_iteration_stable_under_deactivate`, `smelt_cycle_golden`, `idle_world_visits_zero_entities` (10k sleeping machines, `entities_visited_per_tick == 0` between due ticks), `timers_survive_encode_decode` (hash equal after roundtrip mid-cycle: the seed of heavy mode), `replay_equals_live_with_timers`, `tick_state_steady_no_alloc`; budget (both on a test-local `Game` whose tick rule spawns one entity per tick, so the `machines` goldens stay fixed): `tick_rule_put_past_limit_is_applied` (with `max_entities` reached a `TickCx` spawn succeeds and the count exceeds the limit; the next growing action is rejected, a `Growth::NONE` action passes; replay identical), `tick_spawn_without_ids_is_engine_fault` (`testkit::set_next_entity_id` at the limit; `#[should_panic]`); journal: `journal_rolls_back_store_indexes_wakes_counts`, bench `apply_journal_overhead` (slow tier; prints both medians).

## Exit criteria
- [ ] All fast tests above pass; the bench ran once and its numbers are in the new ADR.
- [ ] The journal ADR exists (numbered by the `write-adr` skill) and PLAN.md "Plan-level decisions" lists it.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t timer` · `pnpm test rust -t wake` · `pnpm test rust -t smelt_cycle` · `pnpm test:slow rust -t apply_journal_overhead` · `pnpm lint`.

## Budgets
Tick time row: `idle_world_visits_zero_entities` and `entities_visited_per_tick` ceiling in `budgets.json` (the wall-clock proxy is M36's). Allocation: `tick_state_steady_no_alloc`.

## Context artifacts
Crate `CLAUDE.md`: the tick order (records → swap wake lists → `G::tick` → advance) and "puts through `TickCx` never auto-wake". Fixture `CLAUDE.md` line for `machines`.

## Manual device checks
none

## Deviations

**Seam shapes as landed** (`packages/engine/crates/engine/src/`):
- `sim/` is now a directory (was `sim.rs`): `sim/mod.rs` (`Sim<G>`, unchanged Provides) plus three new
  `pub(crate)`-only siblings `sim/timers.rs` (`TimerWheel`), `sim/wake.rs` (`WakeQueue`),
  `sim/active.rs` (`ActiveLists`) -- none of the three is exported at `engine::`; only `Authority`/
  `TickCx`/`Store` reach them. `world/traits.rs` gained `SystemId` (re-exported at `engine::world`,
  alongside `PrototypeId`) and `Registry::system(name: &str) -> SystemId` (sequential, no dedup by
  name, ≤ 16, same convention as `add_prototype`).
- `TickCx<'_, G>`'s M21b methods, exactly the 12b list: `next_woken`/`next_due` (pop, `None` when
  empty/not-yet-due), `wake(id)`/`wake_at(id, Tick)`/`cancel_wake(id)`, `activate`/`deactivate(sys,
  id)`, `active_len(sys) -> usize`, `active_at(sys, i) -> Option<EntityId>`.
- `Authority<G>` new public surface: `entities_visited_per_tick() -> u64` (reset every tick,
  bumped once per id a `next_woken`/`next_due`/`active_at` call actually yields), `apply_rollbacks()
  -> u64`. New `pub(crate)`: `begin_tick`/`end_tick` (the fixed point, called by `Sim::step` around
  `G::tick`), `begin_apply_journal`/`commit_apply_journal`/`handle_rejected_apply_write` (the undo
  journal, below). `Authority::spawn`/`put_entity`/`despawn` (the `WorldWrite` impl) are now thin
  wrappers over new `do_spawn`/`do_put_entity(_, _, wake: bool)`/`do_despawn`; `TickCx`'s own
  `WorldWrite` impl calls the same `do_*` methods with `wake: false`, which is the entire mechanism
  behind "puts made through `TickCx` do not auto-wake" (Planning decisions) -- both paths funnel
  through one `Authority::write`, so the auto-wake push (`Authority::auto_wake`) is the *only*
  thing that differs between them.
- `Store<G>` gained `pub(crate)`-only wake/timer/active accessors (`wake_push_next`, `wake_pop_now`,
  `wake_swap`, `wake_clear_now`, `wake_remove_next`, `timer_wake_at`, `timer_cancel`,
  `timer_next_due`, `active_activate`, `active_deactivate`, `active_compact_all`) plus public
  `timers_pending() -> usize`, `active_len(sys)`, `active_at(sys, i)`, and a testing-gated
  `wake_next_len()`. `Delta::EntityGone`'s `Store::apply` arm now also calls `timers.cancel(id)` and
  `active.deactivate_everywhere(id)` unconditionally (0007 §7 "despawn removes"/"despawn deactivates
  everywhere") -- idempotent, harmless on a replica whose `timers`/`active` are always empty.

**The fixed point is two calls, not one, at two different points in `Sim::step`** (not explicit in
the brief's own Scope wording, which describes it as a single "engine swaps the lists" moment):
`Authority::begin_tick` (wake-queue swap **and** active-list compaction of the *previous* tick's
tombstones, run immediately before `G::tick`) and `Authority::end_tick` (drops the wake queue's
leftover `now`, run immediately after `G::tick`). Active-list compaction specifically had to move
from "end of this tick" to "start of the next" during development: compacting at the end of the
*same* tick that requested a removal made the tombstone-then-compact behavior unobservable from
outside a `Sim::step` call (nothing between `Sim::step` calls could ever see the tombstoned, pre-
compaction shape), which is what `active_iteration_stable_under_deactivate`
(`crates/engine/tests/timers_wakeups.rs`) is actually testing. Landed at "start of next tick"
instead, so a caller inspecting `active_len`/`active_at` right after one `Sim::step` returns still
sees last tick's tombstones, and only the *following* `Sim::step` (whose `begin_tick` runs first)
compacts them.

**A real bug found and fixed, not merely a test-tuning issue: `Store::apply`'s `EntityPut` arm
unconditionally churned `ChunkIndex` on every put.** Building `tick_state_steady_no_alloc` (a
population of entities continuously rescheduling their own timer, comparing allocator growth over a
short vs. a 5x longer window) kept failing with real, if small, net growth. Cause: `Store::apply`
removed-then-re-added every entity's occupancy entry on *every* `EntityPut`, even when neither the
anchor nor the footprint changed -- for an entity alone in its own chunk (the common case for a
lone timer/wake/active-list put, since none of those move an entity) this destroys and rebuilds
that chunk's entire `ChunkIndex` (three fresh heap allocations: `occupancy: Vec<u64>`, `entries:
Vec`, `overlapping: Vec`) on every single call. Fixed by skipping the remove/add pair when
`(old_anchor, old_footprint) == (new_anchor, new_footprint)`. `ChunkIndex` is derived and never
encoded (0007 §5), so this changes no golden or hash; `index_ops_per_put_is_bounded_by_footprint_
area_plus_four` (fx-machines, M21) and every other pre-existing index test still passes unmodified.

**`TimerWheel` is bucketed (`BTreeMap<Tick, Vec<EntityId>>`), not the flat `BTreeMap<(Tick,
EntityId), ()>` the brief's own prose reads most naturally** ("Implementation free ... as long as
... steady state does not allocate" -- the actual requirement, which the flat form fails). Measured
directly, outside this crate (a throwaway `std::collections::BTreeMap<(u32,u32),()>` harness under a
counting global allocator, 200 keys cycling with an ever-increasing first component): net live bytes
kept growing indefinitely at a constant live-key count, because every reschedule inserts a brand new,
always-larger key while removing an older, scattered one. The same workload against a bucketed
`BTreeMap<Tick, Vec<u32>>` converged to exactly zero growth after enough warm-up. Same public API,
same `(Tick, EntityId)` iteration order (bucket order, then each bucket's own sorted `Vec`); every
pre-existing `sim::timers` unit test (`fires_at_exact_tick_in_key_order`, `wake_at_replaces`,
`cancel_removes`, `roundtrip`) passes unmodified against the new internals.

**Wake queue's encoded placement:** 0005 "Snapshot" lists "... entities, active lists and timers in
canonical order" but predates the wake queue and names no place for it. Landed last of all (after
active lists, then timers), next to the timer wheel it drives -- `Store::write_canonical`'s own
comment records this as a placement choice, not a fact owned elsewhere.

**Goldens moved** (0005 Snapshot's own field order gains three new sections, present even when
empty -- any added bytes change every existing FNV hash; checked whether this could be avoided and
it cannot, since a hash function has no "no-op" byte sequence). Per this brief's own ruling, none of
these is re-blessed; each old value is left exactly as committed, for the orchestrator to bless:

| Golden | Old | New (native, confirmed `.wasm`-identical where wasm-authoritative) |
|---|---|---|
| `machines/place-border` (`golden.json`) | `2f62009b92068963` | `58cf4dd2cba3ea96` |
| `machines/full-world` (`golden-full-world.json`) | `a1e1b02f2725e3c0` | `a813319e1e3ca417` |
| `puts_idle_100` (`fixtures/puts/golden/golden.json`) | `195e71ef0defbf7a` | `4e60d654ed1d2cba` |
| `puts_script_a` (`golden-script-a.json`) | `d5fd55ce8f13a67e` | `0a7cc2623a83a03e` |
| `puts-connected` (`golden-connected.json`) | `df47fa55da493c78` | `3a392e50dba8f378` |
| `store_golden_bytes` (native-only byte golden, `crates/engine/tests/golden/store_golden_bytes.hex`) | 61 bytes | longer (18 new all-zero `u32` section-count fields: 16 active-list systems + timers + wake queue) |

Confirmed unaffected (checked, not merely assumed): every `reference-sim`/`fx-worldgen` golden (none
hashes a full `Store`, only worldgen/extract-specific state), every M14/M15 wire-format byte golden
(a separate encoding from `Store::encode`), `fx-drawables`' own golden, and every `no_alloc_*` test's
asserted number. Full accounting: a workspace-wide `cargo nextest run --workspace --features
engine/testing,testing` shows exactly the six rows above and nothing else red, both before and after
the undo-journal adopt flip (§ below).

**Anti-vacuity, per the four named tests, inject/fail/revert (lines pasted from the actual run):**
- `idle_world_visits_zero_entities` (`fixtures/machines/tests/idle_cost.rs`): the 10k-sleeping-
  machines assertions alone would pass even if `entities_visited_per_tick` were a stub that always
  read 0, since nothing in that scenario ever calls `Authority::bump_visited` either way -- added a
  positive check (one `Place`d machine must show `entities_visited_per_tick() >= 1` the very tick it
  is placed) to close the gap, then injected the stub (`bump_visited` body emptied) ->
  `"a freshly placed machine must be visited (woken) the same tick it was placed"` panicked.
  Reverted -> green.
- `tick_state_steady_no_alloc`: re-injecting the original `ChunkIndex`-churn bug (above) did *not*
  reliably fail this test -- a matched alloc-then-immediately-freed pair of the same size is
  invisible to a net-live-bytes measurement, so this specific defect happened to be a bad anti-
  vacuity case for this specific test (recorded here as a real limitation of the "compare two
  windows' live-byte growth" tool itself, not fixed). A clearer, deliberate injection (one forgotten
  `Vec::<u8>::with_capacity(8)` per `Store::apply` `EntityPut`) did fail unambiguously ->
  `"steady-state growth must not scale with the number of ticks run (short: 159800 B over 500 ticks,
  long: 800000 B over 2500 ticks)"`. Reverted -> green (`short: 0 B ... long: 0 B` in the version
  committed).
- `journal_rolls_back_store_indexes_wakes_counts` (`crates/engine/tests/undo_journal.rs`), three
  passes, one per side effect (store/index/counts share one code path here, since restoring the
  entity value is what restores all three at once; wake is independent):
  - Tile capture emptied -> `left: Tile(9) right: Tile(2)`.
  - Entity capture emptied -> `"the moved-then-despawned entity is restored" left: Ok(None) right:
    Ok(Some(JEntity { x: 14, y: 14 }))`.
  - `record_woke` emptied -> `left: 2 right: 1` (the wake-queue length assertion).
  All three reverted -> green.
- `put_from_tick_does_not_self_wake` (`crates/engine/tests/timers_wakeups.rs`): forced `TickCx`'s
  `put_entity` to auto-wake (`wake: true` instead of `false`) -> `"a put made through TickCx must
  not auto-wake (Planning decisions)" left: 2 right: 1`. Reverted -> green.

**The undo journal is adopted:** [0037](../decisions/0037-undo-journal-adopted.md). Measured
(`fixtures/machines/tests/journal_bench.rs`, `slow_apply_journal_overhead`, `pnpm test:slow rust -t
apply_journal_overhead`): baseline median 1.990167 ms, journal median 2.040458 ms over 10,000 mixed
actions (7 trials each) -- **2.5% overhead**; **0 B** arena growth over a further full script pass
with the journal on. Both clear 0023's bar (≤ 10% / zero steady-state allocations) with room to
spare. `UNDO_JOURNAL_ADOPTED = true`; debug and test builds keep the unconditional panic regardless
(`cfg!(debug_assertions)`), so this flip changed no existing test (verified: identical six-row
failure set before and after, above).

**Bookkeeping the write-adr skill names but this milestone did not do:** the ADR index in
`PRE-PLAN.md` §1 and the `docs/decisions/` row's ADR range in the root `CLAUDE.md` (already stale at
0028 vs. the real 0036 before this milestone -- 0029-0036 were never backfilled by the milestones
that added them either) are outside a milestone-implementer's own edit list; left for the
orchestrator, along with `PLAN.md` "Plan-level decisions" (this brief's own Exit criteria names it,
but `PLAN.md` is on the never-edit list).

**`packages/engine/budgets.json` not touched.** The Budgets section's "Tick time row:
`entities_visited_per_tick` ceiling in `budgets.json`" has no natural home there: that file holds
only per-page, per-isolate browser zero-GC byte budgets (0016), nothing Rust-side or tick-cost-
shaped, and the brief's own parenthetical ("the wall-clock proxy is M36's") confirms no numeric
ceiling exists yet to record. Satisfied instead by the tests themselves (`entities_visited_per_tick
== 0`/`>= 1` in `idle_world_visits_zero_entities`, allocation growth in `tick_state_steady_no_alloc`).

**Fixture design notes.** `Machine` gained three new fields (`is_spinner`, `lit`, `spin_acc`) and
`Action` gained one new, appended variant (`PlaceSpinner { origin }`) rather than reusing `genesis`
to spawn the Spinner: a genesis-spawned entity would have consumed one real `max_entities` slot
before any action runs, which breaks `full_world_rejects_place_accepts_remove_then_place`'s and
`machines_full_world_golden`'s own assumption that the first `Place` succeeds against a
`max_entities: 1` world. `PlaceSpinner` is appended after the M21 variants (not inserted among
them), so no pre-existing `Action` encoding shifts.

**Measured.** `cargo nextest run --workspace --features engine/testing,testing`: 474 tests, 468
passed, 6 failed (the golden table above), 1 skipped (`slow_apply_journal_overhead`, correctly
filtered by the fast-tier profile). `pnpm test wasm`: 60 tests, same three fx-puts goldens red
(`wasm_idle_100_matches_native`, `wasm_connected_100_matches_its_own_golden`,
`wasm_script_a_matches_native`, plus their Bun-leg mirror), native and `.wasm` agreeing on the new
value in every case (checked). `pnpm test unit`: 232 passed, unaffected. `cargo clippy --workspace
--all-targets -- -D warnings` and `cargo fmt --check`: both clean.
