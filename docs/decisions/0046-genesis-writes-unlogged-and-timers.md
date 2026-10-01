# 0046: Genesis writes are not logged, and genesis may arm timers

Status: Accepted (2026-09-30). Amends [0003](0003-game-facing-api.md) (the `WorldWrite` contract and `Game::genesis`, "once, at tick 0 of a new world"); touches [0007](0007-world-model.md) §7 (one timer per entity) and §8 (memory split). Implemented by M36 step 3b.

## Context

[0020](0020-testing-strategy.md) §9's standard large save is built by `Game::genesis` (a bench-only builder in the reference game): 262,144 furnaces and 1,048,576 depleted tiles. `Authority::write` applied each write to the `Store` and also pushed it on the per-tick `ChangeLog`, which the host clears at the first `seal`. For the large save that is 1,310,721 entries of 160 B, about 210 MB, held at once. Measured on the release `.wasm` with the default 96 MiB arena and 256 MiB ceiling: a 1/8 save fits, 1/4 grows once, 1/2 grows seven times, and the full save traps in `sim_genesis` (`arena ceiling: requested 167772160 bytes with 213954608 live`). Nothing reads those entries: a connection that exists at tick 0 gets its first frame as full state from the `Store`, snapshots, `state_hash`, replay and chunk versions read the store (an unstamped chunk reads version 0, the tick genesis completes at).

Separately, genesis could not schedule a timer: `wake_at` existed only on `TickCx`. A builder that makes machines already mid-job (the large save's uniformly staggered smelts) had to ship a rule in the game's tick path to re-arm them.

## Decision

**1. Genesis writes are applied, not logged.** `Sim::genesis` brackets `Game::genesis` with a flag on `Authority`; while it is set `write` still captures nothing for the journal, applies to the store and sets `dirty`, but skips `changes.push`. After genesis the flag is cleared and the log emptied. Writes after genesis are logged as before.

**2. `WorldWrite::wake_at(id, at)`.** A defaulted method on `WorldWrite` that panics ("callable from `Game::genesis` and `Game::tick` only"). `Authority` implements it only while the genesis flag is set (otherwise the same panic) and writes `store.timer_wake_at` directly, not a `Delta`; `TickCx` delegates to its existing method. `Predicting` and `Migrating` keep the default. A silent no-op would hide a lost timer, and `apply`, `on_player` and prediction run on `Authority` or `Predicting` where the undo journal holds no timer pre-image ([prediction rules](../../.claude/rules/prediction.md)); both fail loudly instead.

## Alternatives rejected

- **Raise the arena or ceiling for the bench:** hides a 210 MB transient behind a number the phone cannot have ([0015](0015-threads-memory-and-topology.md)).
- **Fill the world over the first ticks, where the host clears the log each tick:** changes what "genesis" builds and what tick 0 is.
- **A game rule that re-arms timers on first wake:** puts bench-only code in the tick path and in native goldens (the self dev-dependency compiles it into every native reference test).
- **A genesis-only method outside `WorldWrite`:** `Game::genesis` receives `&mut dyn WorldWrite`; a second context type would change the trait ([0003](0003-game-facing-api.md)).

## Consequences

- Peak memory of a full large save at genesis falls from over 256 MiB to inside the default arena with zero grows (release scales 1, 2, 4 and 8 all `memoryBytes` 101,974,016; scale 1 genesis 264 ms, dev 494 ms).
- A game whose genesis relied on seeing its own writes in `changes()` (none does) would see an empty log.
- 0003's accepted text is unchanged; its `Status:` line and the index entries are for the orchestrator.

## Sources

- M36 Deviations, step 3 and 3b (`docs/plan/36-slow-tier-and-benchmarks.md`); `authority::tests::genesis_writes_are_applied_not_logged_and_may_arm_timers`, `wake_at_outside_genesis_panics`, `bench-build @slow`.
