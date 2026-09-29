# M30: Interpolation

Status: not started · After: 29, 19, 26 · Tyler-dependent: no

## Goal
Remote players move smoothly: presence samples go through an interpolation buffer rendered at `host time − delay`, with Hermite interpolation, bounded extrapolation, hold, and fade, and the delay adapts to measured jitter without ever stepping. Verified by native unit tests on synthetic arrival times and by netcode-harness scenarios under the seeded conditioner, reproducible from `(seed, scenario)`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0012-prediction-and-reconciliation.md` ("Remote motion: interpolation, not prediction"; "Correction without snapping", last bullet)
3. `docs/decisions/0010-rates-and-subscriptions.md` (Rates table row "Interpolation delay"; Context network budget; the worked presence number)
4. `docs/decisions/0020-testing-strategy.md` (section 7: netcode harness, conditioner, virtual clock)
Mine from spikes: none (the prediction spike built no interpolation). Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
- `InterpBuffer`: per-key ring of samples `{ t: f64 host ticks, pos, vel }`, Hermite evaluation, extrapolation cap, hold, fade (limits by citation: 0012).
- `JitterStats` and `InterpDelay`: the adaptive delay of 0010 (formula, initial value, floor, cap, dilation limit all by citation).
- Wiring: `RemotePresences` (M19) feeds the buffer using `sample_tick = frame.tick − age_ticks`; `FrameView::presences` yields interpolated `pos`, `vel` and `alpha`.
- **Thread a real arrival time into `RemotePresenceEntry::arrived_ms`.** Per M19 Deviations (steps 4-6), the field M19 landed is not wall-clock arrival: it is `sample_tick` converted through `G::TICK_RATE`, a deterministic proxy that would make the jitter formula below degenerate (arrival delta would always equal the tick-derived delta). M19 left this for this milestone and flagged that it may require widening `ClientCore::on_frame`'s fixed `(&mut self, bytes: &[u8])` signature (no `t_ms` today) to get a real client clock reading at the point a Presence section is decoded.
- `rebase` on tab return (0018 section 8): main sets a control-block flag; the client worker calls `HostClock::rebase()` and clears buffers. The same clear runs on M28b's resync (`Welcome` while online).
- Netcode-harness scenarios, including the conditioner-driven tests of M26's `HostClock` and `LeadEstimator` that M26 could not run.

## Non-scope
- Feeding replicated entities into the buffer. 0012 says moving entities share this path, but no v1 game has a sim-owned moving entity (0001 Consequences) and 0003 gives the engine no way to read an entity's position or velocity. The buffer is keyed by `InterpKey::{Player(PlayerId), Entity(EntityId)}` so the feed is additive; the question a later milestone must answer is "which `Game` hook exposes an entity's `pos()`/`vel()`?".
- Own avatar (never interpolated; `FrameView::own_presence`, M19). Prediction of any kind. Reference-game dots (M34).

## Files, packages and crates touched
- `packages/engine/crates/engine/`: new module `interp` (`buffer.rs`, `delay.rs`, `jitter.rs`); edits to `presence::RemotePresences` read side and `frame(t_ms)`.
- `packages/engine/src/`: the `rebase` control flag on visibility change; `engine/test` hook below.
- Netcode suite directory (M27's layout): new scenario file; `packages/engine/fixtures/presence/` gains a scripted path producer.

## Seams
**Provides:**
- `InterpBuffer<K>`: `push(key, t, pos, vel)`, `sample(key, render_t) -> Option<Interpolated { pos: WorldPos, vel: [i32; 2], alpha: f32, mode: Interp | Extrap | Hold }>`, `remove(key)`, `clear()`.
- `InterpDelay`: `on_arrival(tick, arrived_ms)`, `advance(dt_ms)`, `render_time(host_now) -> f64`, `delay_ms() -> f32`.
- `FrameView::presences` now interpolated (signature unchanged from M19); `RemotePresence.alpha` becomes meaningful.
- `engine/test`: `samplePresences(client) -> { who, x, y, alpha, mode }[]` and counters `interpExtrapolatedFrames`, `interpRenderedFrames`, `interpDelayMs`.

**Consumes:** `RemotePresences`, Presence section entries with `age_ticks`, `Gone`, fixture `presence`, `Loopback::set_presence` (M19). `HostClock`, `LeadEstimator`, `Clocks` (M26). `createNetHarness`, `HeadlessClient` (`stepFrame`, `setView`, `dispatch`), `conditionLink` (`set`, `stall`, `disconnect`), `VirtualClock`, `netCounters` (M27). The resync path that drops client state (M28b). Net worker and loopback `ws` path for one scenario (M29). Control block (M06). Visibility handling on main (M09/M11, wherever the rAF stop on `hidden` landed).

## Planning decisions
- **Timebase is host ticks as `f64`**, from `HostClock::now`. A sample's time is its host receive tick (`frame.tick − age_ticks`), so it is quantised to one tick and carries uplink jitter; Hermite with velocity absorbs that. Client-stamped sample times were rejected: client clocks are not host time, and the stamp would cost bytes on every sample.
- **Jitter sample** = `|(arrival_i − arrival_{i−1}) − (tick_i − tick_{i−1}) × tick_ms|` over every arriving frame, heartbeats included. p95 from a fixed 32-bin histogram over the last 128 samples: no allocation, no sort.
- **Never stepped.** `render_time` advances by `dt × rate` with `rate` inside the dilation limit of 0010 until the target delay is met; only `rebase()` snaps.
- **Buffer depth 8 samples per key** (0.8 s at the presence rate; the delay cap of 0010 needs 4). Out-of-order or duplicate times are dropped. A re-relayed held sample (same `sample_tick`) refreshes the silence timer without adding a sample: that is what keeps a resting player solid (0001).
- **`alpha`** is 1 while samples are fresh, ramps to 0 across the silence limit of 0012, and is 0 at once on `Gone`. The game multiplies it into its colour; the engine draws nothing itself.
- **Floats are fine here** (client side, never hashed; 0003). Reproducibility is asserted within one runtime only.
- **Measured, may become an ADR change (0024 §15 sets the rule).** Presence arrives at the sample rate of 0010, which is half the frame rate that 0010's delay formula is written in. With the floor delay the newest bracketing sample is often missing and the buffer extrapolates. The scenario `extrapolation_ratio` measures `interpExtrapolatedFrames / interpRenderedFrames` at the median network profile. If it exceeds 0.2, record a Deviation proposing that the formula's interval term be the presence sample interval, and supersede the 0010 row by ADR; do not tune silently.

## Order of work
1. `InterpBuffer` with Hermite, extrapolation cap, hold, fade; native unit tests on synthetic samples.
2. `JitterStats`, `InterpDelay`; native tests with scripted arrival times.
3. Wire into `RemotePresences` and `FrameView::presences`; `samplePresences` hook.
4. Scripted path producer (the fixture's `frame` copies the camera centre and velocity into its presence; scenarios drive `HeadlessClient.setView` along a curve); netcode scenarios.
5. `rebase` flag end to end.
6. One loopback-`ws` repeat of `constant_latency_tracks_path`.

## Tests added
Rust suite (`interp_*`): `hermite_hits_samples_and_is_c1`, `extrapolates_then_holds` (limit by citation), `fades_after_silence_and_recovers`, `rerelay_refreshes_without_new_sample`, `drops_out_of_order`, `delay_initial_floor_cap`, `delay_follows_p95_formula`, `delay_never_steps` (per-frame change of `render_time` stays inside the dilation limit), `rebase_snaps_and_clears`, `interp_entity_key_same_path` (the same samples pushed under `InterpKey::Entity` and `InterpKey::Player` sample identically: one buffer, one code path, 0012 "Remote motion"; the entity feed stays Non-scope), `interp_alloc` (0 allocations over 600 frames with 7 remote keys).
Netcode suite (`interpolation.*`, seeded conditioner, virtual clock, two to eight headless clients):
- `constant_latency_tracks_path`: a producer follows a known curve; the observer's sampled position stays within a stated tile error of the curve evaluated at `render_time`.
- `jitter_profile_adapts`: jitter drawn at 0010's assumed figures; `interpDelayMs` converges into the formula's value; no step.
- `stall_then_recover`: scripted 1 s head-of-line stall; mode sequence `Interp → Extrap → Hold`, no position jump above a stated bound on recovery.
- `resting_player_stays_solid`: no uplink presence bytes at rest beyond the keepalive batch; `alpha` stays 1 for 5 s.
- `disconnect_removes_at_once`: `Gone` gives `alpha` 0 in the next frame.
- `extrapolation_ratio`: the measurement above.
- `seed_reproducible`: the same `(seed, scenario)` twice gives identical `samplePresences` traces.
- `presence_bytes_budget`: seven moving remotes cost no more than the budgets-file ceiling derived from 0010's worked number.
- `host_clock_under_jitter` (monotone, bounded error against the host's true tick) and `lead_tracks_rtt_under_jitter` (lead within one tick of `ceil(rtt / tick) + 1` after 8 acks; own-timer corrections bounded by the jitter range): the conditioner tests owed to M26.
Browser suite: `rebase-on-visible`: hide, advance the injected clock 5 s, show; no fast-forward, first frame after return is `Interp` or `Hold`, never a sweep.

## Exit criteria
- [ ] Every test above passes; `extrapolation_ratio` and its verdict are written under Deviations.
- [ ] `interp_alloc` reports 0 and the browser zero-GC test passes in the multiplayer topology with one moving remote.
- [ ] Netcode suite stays inside its 0020 time budget; the `ws` repeat is tagged slow if it does not.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t interp` · `pnpm test netcode -t interpolation` · `pnpm test browser -t rebase-on-visible` · `pnpm test browser -t zero-gc` · `pnpm test && pnpm lint`

## Budgets
- Latency row, interpolation delay (0010): `delay_initial_floor_cap`, `jitter_profile_adapts`.
- Bandwidth per client, steady, down (0010): `presence_bytes_budget`, new `budgets.json` key `presence_down_bytes_per_s_7_remotes`.
- Allocation per isolate, client worker (0016): `interp_alloc`, zero-GC test.
- Frame time, client-worker share (0018 section 9): interpolation is O(remote keys); no new counter.

## Context artifacts
Engine crate `CLAUDE.md`: one line that `interp` and `clock` are float, client-only and must never be reachable from `apply`/`tick`. No new skill.

## Manual device checks
Owns item M34-remote-motion, run in [M34's section of device-checks.md](device-checks.md#m34-reference-multiplayer-on-real-devices) and again on cellular in M38's; nothing to check before M34 draws remote players.

## Deviations
### Steps 1-2 (InterpBuffer, JitterStats, InterpDelay; `crates/engine/src/interp/`)

Limits cited (each a `pub const`):
- Extrapolation cap 250 ms, then hold: 0012 "Remote motion" (`buffer::EXTRAPOLATION_CAP_MS`).
- Silence limit 2 s before fade: 0012 "Remote motion" (`buffer::SILENCE_LIMIT_MS`).
- Delay initial 150 ms, floor 100 ms, cap 400 ms; formula `max(2 x fi, fi + p95)`, `fi` = tick interval; dilation limit 10%: 0010 Rates table, row "Interpolation delay" (`delay::{INITIAL_MS, FLOOR_MS, CAP_MS, DILATION_LIMIT}`).
- Ring depth 8, histogram 32 bins over the last 128 samples: this brief's Planning decisions.

This milestone's own choices (no ADR text fixes them):
- `buffer::FADE_MS` = 500: alpha is 1 until 2 s of silence, then a linear ramp to 0 over 500 ms; `sample` returns `None` once alpha reaches 0 (a later push revives the key). The brief's "ramps to 0 across the silence limit" is ambiguous; 0012 says "fade after 2 s".
- `delay::MIN_SAMPLES` = 8: target stays at the initial 150 ms until 8 jitter samples exist.
- `jitter::BIN_MS` = 16: histogram covers 0..512 ms, last bin saturates; `p95_ms` reports the bin's upper edge (over-reads by under 16 ms).

Seams as landed (all `engine::interp`):
- `InterpKey::{Player(PlayerId), Entity(EntityId)}` (`Ord`, `Copy`); `InterpMode::{Interp, Extrap, Hold}`; `Interp { pos: WorldPos, vel: [i32; 2], alpha: f32, mode }`; `PushResult::{Added, Duplicate, OutOfOrder}`.
- `InterpBuffer<K: Ord + Copy>::new(tick_hz: u32)`; `push(key, t: f64, pos: WorldPos, vel: [i32; 2]) -> PushResult` (returns a result, unlike the brief's unit); **added** `refresh(key, now: f64)` (the caller invokes it on `Duplicate`, and for any re-relay, with the arrival host tick: silence is measured from `max(newest t, refresh)`); `sample(&self, key, render_t: f64) -> Option<Interp>`; `remove(key)`; `clear()`; also `reserve_keys(n)`, `len()`, `is_empty()`, `key_at(i)`. `vel` is Q24.8 tiles per second (0001), `t` host ticks, so the buffer takes the tick rate. Hold reports `vel = [0, 0]`. Before the oldest sample the buffer clamps to it (mode `Interp`). A first push of a new key may allocate the key table (sorted `Vec`); steady-state push/sample do not.
- `JitterStats::{new, record(ms: f32), p95_ms() -> f32, len, is_empty, clear}`.
- `InterpDelay::new(rate: TickRate)`, `on_arrival(tick: Tick, arrived_ms: f64)`, `advance(dt_ms: f64)`, `render_time(host_now: f64) -> f64` (host ticks), `delay_ms() -> f32`; **added** `target_ms() -> f32`, `rebase()` (the only snap: delay back to 150 ms, history cleared). A repeated tick is ignored; a tick that goes back only reseats the reference.
- `interp_alloc` landed now, as `tests/no_alloc_interp.rs` (own binary for its `#[global_allocator]`); 0 bytes over 600 frames, 7 keys, buffer plus delay.
- Test names: unit tests `interp_*` in `interp/{buffer,delay}.rs` (18 with `jitter` and `interp_alloc` under `-t interp`); the brief's `delay_*` tests are `interp_delay_*`, `rebase_snaps_and_clears` is `interp_rebase_snaps_and_clears`.
- Engine crate `CLAUDE.md` line for `interp`/`clock` written.
- Commit slip: the step 1 commit (`3cc3223`) carries the full `interp/mod.rs`, which names `delay`/`jitter` that step 2 (`f1d7c5e`) adds; only the two-commit range compiles.
