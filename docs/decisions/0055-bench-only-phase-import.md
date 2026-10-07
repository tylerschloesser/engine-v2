# 0055: A bench-only wasm import for per-phase tick timing

Status: Accepted (2026-10-07). Amends [0014](0014-js-wasm-boundary.md) §3 (the import allowlist). Implemented by M39y.

## Context

[0014](0014-js-wasm-boundary.md) §3 allows a module two imports, `engine.panic` and `engine.log`, and says adding one is an amendment. M39y splits `sim_tick` into phases (timer drain, the game's `advance`, `put_entity`, change log, subscriptions) in the bench build, in Node and in the browser worker. A `.wasm` has no clock, and a phase boundary is reached in the middle of one export call, so the host cannot time it from outside.

## Decision

**1. A third import, `engine.bench_mark(phase: u32)`, output-only and bench-only.** It exists only when the engine's `bench-phases` cargo feature is on (the reference game's `bench` feature forwards it). Nothing shipped enables it: the release allowlist `{engine.panic, engine.log}` is unchanged for every shipped module. The loader always supplies the function, a no-op unless `setBenchMarkHook` installed a hook; the hook reads the host clock and attributes the time since its previous call to `phase`.

**2. Why an import, not a memory region.** A region is data the host reads after the call; the time of a boundary has to be read at the call site, and a time cannot be passed in as an argument mid-tick. The module signals "a boundary was reached" and the host owns the clock, which keeps clock reads out of the module (0002).

**3. It never feeds state.** The phase id goes out; nothing comes back. No sim code branches on, hashes or stores a counter; goldens and determinism hashes are unchanged with the feature on and off.

**4. The check.** `tick-phases @slow` (`packages/engine/tests/wasm/tick-phases.test.ts`) asserts the bench module imports `engine.bench_mark` and that a release module does not; the import-allowlist test keeps covering every shipped module.

## Alternatives rejected

- **A memory region the module writes ticks into:** there is no clock to write.
- **Timing only whole `sim_tick` from JS:** it cannot split the 3x gap into phases, which was the point of M39y.
- **Per-phase exports run separately:** it changes what is measured (the tick is one call).

## Consequences

- A bench module cannot be instantiated by a loader that does not supply `bench_mark`; every loader in the repo goes through `loader.ts`, which does.
- Revisit if a shipped build ever wants phase timing: that would need its own decision.

## Sources

- `docs/plan/39y-wasm-tick-cost.md` Deviations (the measurements this serves).
