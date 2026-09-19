# M21b: Timer wheel, wake-ups, active lists, the completed `TickCx`

Status: not started · After: 21 · Tyler-dependent: no

Split from M21 (see that brief). PLAN.md needs a row; M22, M25 and M32 should list 21b in **After**.

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
- **`TickCx` completed** with the M21b methods of the 12b list; `Sim::step` constructs it.
- **State.** `Store::encode` gains timers (key order), `woken_next` (insertion order), active lists (system order, insertion order), exactly where 0005 "Snapshot" places them; `state_hash` covers them. A client replica holds none of it.
- **Fixture `machines` tick rule:** woken + `fed` + idle → `done_at = now + SMELT` (`const SMELT: Ticks = TICK_RATE.secs(5)`), `wake_at`; due → `count += 1`, continue or sleep; a `Spinner` prototype lives on an active list and toggles a field every `TICK_RATE.millis(500)` through the integer-accumulator pattern of 0006.
- **Undo journal experiment** (below).

## Non-scope
Player timers (none: `tick` scans the player table, see 12b). Bucketed area effects (not scheduled). Predicted timers and the completion gap (M25/M26). Persistence of this state to storage (M22 consumes `Store::encode`). Tick-time benchmark on the standard large save (M36).

## Files, packages and crates touched
`packages/engine/crates/engine` (`sim/timers.rs`, `sim/wake.rs`, `sim/active.rs`, `tick_cx.rs`, `authority` journal), `packages/engine/fixtures/machines`.

## Seams
**Provides:** `TickCx::{next_woken, next_due, wake, wake_at, cancel_wake, activate, deactivate, active_len, active_at}`, `Registry::system`, `SystemId`; extended `Store::encode`/`state_hash`; counters `entities_visited_per_tick`, `timers_pending`, `apply_rollbacks`; goldens `machines/smelt-cycle`, `machines/idle-world-costs-zero`; the journal decision (ADR written with the `write-adr` skill).
**Consumes:** M21 prototypes, fixture, `testkit::fill_world`; M12b `TickCx` minimal, `Authority`, `Sim`; M12 `Store`; M05 hash.

## Planning decisions
- **How `apply` starts a timer without a timer API (0024 §7 closes the gap between 0003 and 0007).** `apply` sees only `WorldWrite`, which must stay "every method is one put" and must behave identically under prediction, so it cannot call `wake_at`. Instead the put itself is the wake-up: the entity appears in `next_woken()` of the same tick's `G::tick` (actions run before tick rules, 0004), and the tick rule reads the value (`done_at`) and schedules. This is 0007 §7's "wake-ups are queued and applied at one fixed point" made concrete, adds no `Game` hook, and keeps the client free of tick machinery.
- **One timer per entity.** The reference game and both fixtures need one; replace-semantics removes the stale-timer bug class and keeps `despawn` O(1). An entity that needs two deadlines stores both and schedules the earlier.
- **Host-side atomicity of `apply` via an undo journal (PRE-PLAN §10, 2→3): measured and decided here.** Build `UndoJournal` in `Authority`: preallocated, records the previous value (or absence) of each key on its first put within one `apply`, plus index, wake-queue and count side effects; discarded on `Ok`, replayed backwards on `Err`. Measure with a native bench on `machines` (10k mixed actions, 5 % rejecting): **adopt if** median `apply` cost rises ≤ 10 % and the counting allocator shows zero steady-state allocations. Adopted → a rejecting `apply` that wrote is rolled back in release builds and counted in `apply_rollbacks`; debug and test builds keep the panic so authors still learn "validate first, write after". Not adopted → the assert stays. Either way record the numbers in an ADR that closes the item in 0003/0004/0012; if adopted, note in it that ADR 0023's "apply, measure, roll back" alternative became available.

## Order of work
1. wake queue + auto-wake in `Authority`. 2. timer wheel. 3. active lists + `Registry::system`. 4. `TickCx` methods. 5. encode/hash + roundtrip. 6. fixture rules, goldens, O(active) counter tests. 7. journal, bench, ADR.

## Tests added
Rust: `put_from_apply_wakes_same_tick`, `put_from_tick_does_not_self_wake`, `wake_dedup_and_order`, `undrained_wakes_are_dropped`, `timer_fires_at_exact_tick_in_key_order`, `wake_at_replaces`, `despawn_cancels_timer_and_lists`, `active_iteration_stable_under_deactivate`, `smelt_cycle_golden`, `idle_world_visits_zero_entities` (10k sleeping machines, `entities_visited_per_tick == 0` between due ticks), `timers_survive_encode_decode` (hash equal after roundtrip mid-cycle: the seed of heavy mode), `replay_equals_live_with_timers`, `tick_state_steady_no_alloc`; journal: `journal_rolls_back_store_indexes_wakes_counts`, bench `apply_journal_overhead` (slow tier; prints both medians).

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
(filled in during Phase 3)
