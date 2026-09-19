# 0006: Time units: seconds are authored, ticks are stored

Status: Accepted (2026-09-19)

## Context

Game durations are authored in seconds ("collecting takes 2 seconds", [`../spec/reference-game.md`](../spec/reference-game.md)) but the sim counts ticks and has no clock ([0002](0002-determinism-same-wasm-everywhere.md)). [`../spec/simulation.md`](../spec/simulation.md) asks for a conversion under which changing the tick rate does not change game feel. The tick rate is a per-game constant, 20 Hz by default, in the range 10-60 and fixed for a world's life ([0010](0010-rates-and-subscriptions.md)).

## Decision

**Types.** `Tick(u32)` is a point on the world's tick counter; `Ticks(u32)` is a duration. At 20 Hz a `u32` lasts 6.8 years of unpaused simulation, and it crosses into TypeScript as a plain `number` ([0003](0003-game-facing-api.md)). Sim state stores only `Tick` and `Ticks`, never seconds and never floats of time.

**Conversion rule.** One engine function, integer-only, round to nearest with ties up, and never zero for a non-zero duration:

```rust
impl TickRate {
    pub const HZ_20: TickRate = TickRate::hz(20);
    pub const fn hz(hz: u32) -> TickRate;                  // compile error outside 10..=60
    pub const fn millis(self, ms: u32) -> Ticks {
        let t = (ms as u64 * self.hz as u64 + 500) / 1000;
        Ticks(if t == 0 && ms > 0 { 1 } else { t as u32 })
    }
    pub const fn secs(self, s: u32) -> Ticks { self.millis(s * 1000) }
    pub const DT: f32;                                     // 1.0 / hz, for continuous dynamics only
}
const COLLECT: Ticks = G::TICK_RATE.secs(2);               // 40 ticks at 20 Hz, 60 at 30 Hz
```

Authors write milliseconds or whole seconds as integers; there is no `f32` seconds entry point, so no float rounding enters a duration. The error is at most half a tick (25 ms at 20 Hz). Whole-second durations, which is all the reference game has, are exact at every integer rate.

**Where it happens.** Before the first tick, never inside one. `millis` is a `const fn`, so a duration written as a `const` is converted at compile time, and a content table built when the instance initializes (load) is converted once there; both run the same integer code. `apply` and `tick` see only `Ticks`. A handler schedules with `done_at = w.tick() + COLLECT` and stores `done_at` ([0007](0007-world-model.md) timer wheel).

**Rates and continuous quantities.**
- Ratios stay counts ("one coal fuels 10 ingots"), not per-tick fractions.
- Where a per-second rate is unavoidable, use an integer accumulator, exact at any tick rate: `acc += units_per_sec; while acc >= hz { acc -= hz; emit(); }`.
- Continuous dynamics author constants per second and integrate with `DT`; stiff springs use a dt-independent closed form rather than explicit Euler. Nothing in the reference game's sim needs this (its spring is client-side: [0001](0001-camera-and-presence.md)).

**On the client.** The UI never counts ticks itself. Replicated state carries `done_at`; `client.clock()` exposes the authoritative tick, the predicted tick and `ticksPerSecond` ([0003](0003-game-facing-api.md), two clocks: [0012](0012-prediction-and-reconciliation.md)), from which the UI derives remaining seconds, for example to start a CSS animation of the right length once.

**What a tick-rate change does.**
1. `TICK_RATE` is compiled into the `.wasm`, so changing it changes the sim identity and starts a new log segment like any other code change ([0005](0005-persistence-and-recovery.md)). Every authored duration re-converts automatically, so new timers keep their feel in seconds.
2. `tick_rate_hz` is stamped in every snapshot and segment header. Tick counts already stored in state (`done_at`, remaining burn) were computed at the old rate, so a rate mismatch is treated exactly like a `SCHEMA_VERSION` mismatch even if the author forgot to bump it: the save loads only through `G::migrate`, which rescales stored durations (`remaining * new_hz / old_hz`, same rounding); without a hook the result is `SaveIncompatible`. During prototyping that is the expected outcome.
3. The world's tick counter itself is a count, not a time, and is never rescaled.

## Alternatives rejected

- **Sim time in integer microseconds, deadlines stored in time units.** Snapshots become rate-independent, but every comparison and every author-facing API gets more awkward, to save a migration that prototyping rarely needs and Tyler has allowed to be skipped.
- **`ceil` rounding** (reference-game research). Biases every inexact duration long by up to a full tick; nearest halves the worst-case error. The non-zero floor already prevents the only harmful case (a duration rounding to zero).
- **Float seconds accumulated per tick (`t += DT`).** Drifts, and `done_at` comparisons become float comparisons in persistent state, against the rule in [0002](0002-determinism-same-wasm-everywhere.md).
- **Tick rate as runtime world config.** `const` evaluation of durations would be lost, and the client, host and replay would need to agree on a value that is not covered by the build hash.
- **Authoring durations directly in ticks.** Game feel would change with the tick rate, which is the thing the spec asks to avoid.

## Consequences

- Durations shorter than one tick become one tick; sub-tick timing is not expressible.
- Two games with different `TICK_RATE` are different builds; a world cannot change rate without `migrate`.
- The conversion is a pure function and is unit-tested at two rates (20 and 30 Hz) against the reference game's durations ([0020](0020-testing-strategy.md)).
- Deferred to Phase 2: a helper that rescales every `Tick`/`Ticks` field during `migrate`, because it depends on the `OldStore` shape ([0003](0003-game-facing-api.md)) and no world needs it during prototyping.

## Sources

- [`../research/simulation.md`](../research/simulation.md) 3.7 (rule, accumulators, rejected microsecond clock)
- [`../research/reference-game.md`](../research/reference-game.md) 1.5 (closed-form spring), 3.2 (test at two tick rates; `ceil` variant)
- Closed-form damped spring: https://www.ryanjuckett.com/damped-springs/
- Spike: [`../../spikes/prediction-api/RESULT.md`](../../spikes/prediction-api/RESULT.md) (timers as `started_at`/`done_at`, rendered on the predicted clock)
