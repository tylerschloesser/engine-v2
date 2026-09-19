# 0023: Per-action growth declaration for the state-budget check

Status: Accepted (2026-09-19). Amends the "State-budget check" paragraph of [0004](0004-action-timing-and-rejection.md), adds one provided method to `Game` in [0003](0003-game-facing-api.md), and narrows the meaning of `max_action_growth` in [0007](0007-world-model.md) §8. Implemented in milestone M21.

## Context

`WorldWrite` puts are infallible ([0003](0003-game-facing-api.md)), so the deterministic state budget of [0007](0007-world-model.md) §8 is enforced per action, before `apply`: if the headroom of either count is below the world's `max_action_growth`, the host answers `Rejected(Engine(StateBudgetFull))` without calling `apply` ([0004](0004-action-timing-and-rejection.md)). The host cannot know what `apply` will write, so the check covers every game action. Consequence, recorded as deferred in 0004: a world at its budget rejects *every* action, including the ones that would free state (remove a building, take ingots, cancel a collect). A full world can then never be un-filled by its players. The fix needs a `Game` hook, which is why it was deferred to Phase 2 together with the other `apply` items.

Forces: the decision must be identical on the live host, in replay and in recovery (it is a step-4 rejection that stays in the log); it must cost nothing per action; it must not make puts fallible or require the undo journal (whose adoption is still open, [0012](0012-prediction-and-reconciliation.md)); and a wrong declaration must not be able to corrupt anything.

## Decision

**One provided, pure hook on `Game`, a function of the action value only:**

```rust
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Growth { pub entities: u16, pub modified_tiles: u16 }   // upper bounds on what this action's `apply` may ADD
impl Growth {
    pub const NONE: Growth = Growth { entities: 0, modified_tiles: 0 };
    pub const fn entities(n: u16) -> Growth;
    pub const fn tiles(n: u16) -> Growth;
}

pub trait Game {
    // ...
    /// Worst-case net growth of `apply(a)`. `None` = undeclared: the world's `max_action_growth` applies (0004).
    fn growth(_a: &Self::Action) -> Option<Growth> { None }
}
// reference game: PlaceFurnace => Some(Growth::entities(1)); every other action => Some(Growth::NONE)
```

**The check, replacing the rule in 0004** (same place: host only, immediately before `apply`; never for `on_player`, `genesis`, `migrate` or tick rules; never on a predicting client):

- Let `free_entities = max_entities.saturating_sub(entity_count)` and `free_tiles = max_modified_tiles.saturating_sub(modified_tile_count)`.
- `growth(a) == Some(g)`: reject with `StateBudgetFull` iff `g.entities > free_entities` or `g.modified_tiles > free_tiles`. `Growth::NONE` therefore always passes, even when tick rules have pushed a count past its limit.
- `growth(a) == None`: the 0004 rule unchanged (either nominal headroom below `max_action_growth` rejects).
- Id exhaustion ([0022](0022-entity-ids-and-provisional-ids.md) §2) uses the same number: a declared action needs `g.entities` ids left, an undeclared one the entity count of `max_action_growth`.

`max_action_growth` keeps its role as the slack figure of the 0007 memory split and as the bound for undeclared actions. A declaration whose nominal cost (0007 §8 figures) exceeds `max_action_growth` is a game bug: `debug_assert!`.

**Honesty is audited, not trusted.** The host samples both counts before and after `apply`. If the action added more than it declared: debug and test builds panic with the action's variant and both numbers; release builds keep the (already applied, infallible) writes, bump the counter `growth_violations`, and log at `warn`. No state is changed by the audit, so live, replay and recovery stay identical. The budget is already soft by the `max_action_growth` margin for tick-rule writes (0007 §8); an under-declared action spends the same margin.

**Determinism.** `growth` sees only the action bytes that are in the log, and the counts are sim state, so the verdict replays exactly. The action stays in the log like any other step-4 rejection.

## Alternatives rejected

- **`growth(&dyn WorldRead, &Action)`** (state-dependent declarations, e.g. "placing on an already-modified tile adds nothing"). More precise, but it is a second validation pass that can drift from `apply`, and the precision only matters in the last few slots of a full world.
- **Apply, measure, roll back if over budget.** Exact and needs no hook, but depends on the host undo journal, whose cost is unmeasured and whose adoption is decided later (M21b). If the journal is adopted this can replace the declaration without touching logs: both reject the same actions only when declarations are exact, so the switch would be a build (sim identity) change like any rules change.
- **Fallible puts** (`spawn -> Result`). Every handler would need a failure path after its validation phase, which breaks "validate first, write after" and makes prediction (which cannot count the world) disagree with the host inside `apply` rather than at the ack.
- **A per-variant constant table or attribute macro.** Needs a proc macro (outside the dependency policy of [0017](0017-packaging-and-build.md)) or a parallel enum of variant ids; a `match` in a provided method is the same information with no machinery.
- **A boolean `shrinks(&Action)`.** Does not help an action that grows by one entity when 5 slots are free but `max_action_growth` demands 32.
- **Leave it.** A full world becomes read-only for players; the only exits would be tick rules or a new world.

## Consequences

- A world at its budget still accepts every action declared `NONE`, and accepts small declared growth until the counts are truly exhausted.
- Game authors write one `match` and keep it in step with `apply`; the debug-build audit plus a fixture test (`growth_declarations_are_honest`, which replays the game's scripted logs with the audit on) is the guard. The `add-action-type` skill gains a step.
- `StateBudgetFull` remains an engine rejection that the UI learns through `onActionResult`; prediction still does not run the check ([0004](0004-action-timing-and-rejection.md)).
- The scripted "state budget when full" test of [0003](0003-game-facing-api.md) Consequences gains a second half: placing is rejected, removing is accepted, and placing then succeeds again.

## Sources

- [0004](0004-action-timing-and-rejection.md) "State-budget check" and Consequences; [0007](0007-world-model.md) §8; [0003](0003-game-facing-api.md) Consequences item 4; `PRE-PLAN.md` §10 row "Per-action growth declaration".
- No external prior art was consulted; the design follows from the constraints above.
