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

### Steps 3-4 (wiring, hooks, netcode scenarios)

Arrival time (Scope item "thread a real arrival time"): `ClientCore::on_frame`'s signature is **unchanged**. `on_frame` pushes each applied frame's tick onto a fixed 16-slot list; the next `ClientCore::tick_fraction(local_ms)` (called once per `frame(t_ms)` with `CameraBlock::frame_time_ms`) drains it into `InterpDelay::on_arrival(tick, local_ms)` and calls `RemotePresences::stamp_arrivals(local_ms)`. So `RemotePresenceEntry::arrived_ms` is now the client clock at the first `frame()` after the frame carrying the sample was decoded (at most one client frame late) with a new `pub stamped: bool` (false until stamped, then `arrived_ms` is still the M19 tick-derived stand-in). Sample times need no clock: `push(t = sample_tick)` and `refresh(key, frame.tick)` on every Presence entry, so a re-relayed sample keeps a resting player solid.

Seams as landed:
- `RemotePresences::{sample(who, render_t) -> Option<Interp>, count_modes, nth_visible}` (pub(crate) except `sample`); `apply_sample(who, sample, sample_tick)` unchanged (an out-of-order sample no longer replaces the newest); new `pub(crate) refresh(who, frame_tick)`, `stamp_arrivals(local_ms)`; `apply_gone` also removes the buffer key. No `clear()` yet (step 5).
- `FrameView::with_render_time(self, render_t: f64) -> Self`; `FrameView::new` unchanged. Without it `presences()` yields raw samples with alpha 1 (M19 behaviour); with it (always, in `GameInstance::frame`) pos/vel/alpha are interpolated and a faded remote is skipped. `RemotePresence::sample` stays the newest raw sample.
- `ClientCore::{render_time() -> f64, host_now() -> f64, interp_delay_ms() -> f32, interp_counters() -> (rendered, extrapolated)}`. Counters are per client frame, per visible remote (extrapolated = mode `Extrap` only, not `Hold`).
- ABI 31 -> 32: `client_presence_sample_at(index: u32) -> status` (client role, test-only), 52 LE bytes into `Result`: `visible u32, rendered u32, extrapolated u32, delay_ms f32, who u32, x i32, y i32, alpha f32, mode u32 (0 interp/1 extrap/2 hold), render_t f64, host_now f64`; out of range: sample fields zero. Registry, `abi.ts` row and `ABI_VERSION` updated together.
- `engine/test`: `samplePresences(client) -> PresenceSampleRow[] { who, x, y, alpha, mode: 'interp'|'extrap'|'hold' }` (x, y raw Q24.8) and `interpCounters(client) -> { interpRenderedFrames, interpExtrapolatedFrames, interpDelayMs, renderTime, hostClockNow }` (both need the worker parked, like `predictStats`); `HeadlessClient.samplePresences()` / `.interpCounters()` synchronous equivalents. Decoding lives in `src/test/presence-samples.ts`.
- `createNetHarness({ clientFrameMs })` (default = tick, unchanged behaviour): several client frames per host tick so a client sees arrival times finer than a tick (with one frame per tick every arrival is stamped on the tick grid and jitter is invisible). `NetHarness.hostTick()` (`SimHost.counters.ticksRun`).
- Scripted path producer: `fx-presence`'s `PresenceClient::frame` copies the camera's centre and velocity (tiles, tiles/s to Q24.8) into its presence **when the camera has left its all-zero default**; a camera still at its default keeps the old counter walk (every earlier test relies on it). Scenarios drive curves through `HeadlessClient.setView`.
- New budget `counters.presence.downBytesPerSec7Remotes` = 1220 (camelCase under `counters.presence`, like M19's `uplinkBytesPerSec`, not the brief's snake_case), derivation in its `formula`; measured 911 B/s.
- `scripts/lib/engine-test-binary-layout.test.mjs` allowlist gained `no_alloc_interp.rs`. That unit test had been failing since step 2 (I ran only `pnpm test rust` then); fixed here, not weakened.

Scenarios (`tests/netcode/interpolation.test.ts`, ten tests, 1.0 s together; suite 4.7 s of 10 s): `constant_latency_tracks_path`, `jitter_profile_adapts`, `stall_then_recover`, `resting_player_stays_solid`, `disconnect_removes_at_once`, `extrapolation_ratio`, `seed_reproducible`, `presence_bytes_budget`, `host_clock_under_jitter`, `lead_tracks_rtt_under_jitter`. Measured (all seeds fixed, reproducible):
- Path tracking: worst error 0.350 tile against the curve at `render_t` minus the pipeline delay (1 tick frame + latency + half a tick alignment); stated bound 0.5 tile.
- Delay at 0010's assumed network (40 ms one way, jitter 30): settles at 100 ms (the floor; the target is `max(100, 50 + p95)` and p95 of arrival error is at most one jitter range); with jitter 150 it rises above 150 ms; per-tick change never above 5 ms (10% dilation).
- Resting player: alpha 1.0 for 5 s; uplink 35 B in 100 ticks = five 7-byte keepalive batches, nothing else.
- Stall: 1 s uplink stall gives `interp -> extrap -> hold -> interp`, held position exactly constant; recovery is one step of 1.56 tiles at a producer speed of about 1.4 tiles/s (speed x stall, the bound asserted) followed by a few frames of catch-up at up to about twice the producer speed. That single-step catch-up is the design's hold semantics (0012: hold, no smoothing on return); if it is judged too visible, a catch-up slew is a later, separate change.
- `disconnect_removes_at_once`: `leave()` then one tick for the host to see the close, and the `Gone` frame arrives the tick after: the remote is absent two ticks after `leave()`.
- Clock tests: `HostClock` monotone, lags the host's true tick by exactly 1 tick throughout (one-way 40 ms, jitter 30); asserted `[latency/tick - 1, latency/tick + jitter/tick + 1.5]`. `LeadEstimator` (puts fixture, a second client repainting a tile each tick so a host frame arrives every tick; in an idle world the sample also measures the 10-tick heartbeat staleness of the client's own tick and reads 4 or 8): lead within 1 of `ceil(rtt/tick) + 1` at rtt 140 ms (want 4).
- `presence_bytes_budget`: 911 B/s; ceiling 1220 (see above).

**`extrapolation_ratio` verdict: 0.607 at the median profile (RTT 80, jitter 20, seed 3006), above the 0.2 line.** It is structural, not jitter: 0.556 at jitter 0, 0.556 at 10, 0.607 at 20, 0.658 at 30. Cause as the brief predicted: presence samples arrive at 10 Hz, so with the 0010 delay (floor 100 ms = 2 frame intervals) the newest bracketing sample is missing about 60% of frames. **Proposal (not applied, decision needed):** supersede the 0010 "Interpolation delay" row by ADR so the formula's interval term is the presence sample interval (100 ms): `max(2 x 100, 100 + p95 jitter)` clamped by a floor of 200 ms (cap and initial move up with it, cap 400 stays as is or rises to 500). Not measured with the new constants (a change needs the Rust rebuild); expected effect: the newest sample then precedes `render_t` by less than the delay, so extrapolation falls to jitter-driven stalls only. Cost: +100 ms of remote-player display latency. The test asserts only `0 <= ratio <= 1` and does not change 0010.

Notes: the fixtures build (`pnpm test` step) takes about 9 minutes after any engine-crate edit on this machine; TS-only edits do not trigger it. `RemotePresences` still pushes every sample under `InterpKey::Player`; the entity feed stays Non-scope. Step 5 (`rebase` flag, `RemotePresences::clear`, resync clear) and step 6 (loopback `ws` repeat) are untouched.

### Orchestrator decision after steps 3-4 (2026-09-29)

`extrapolation_ratio` = 0.607 > 0.2 (structural: 0.556 at zero jitter). Per this brief's planning decision the formula's interval term becomes the **presence sample interval** (100 ms at 0010's 10 Hz), not the frame interval: `max(2 × presence_interval, presence_interval + p95)`, **floor 200 ms, initial 250 ms** (floor + one tick, the same relation 150/100 had), **cap 400 ms** unchanged, 10 % dilation limit unchanged. `docs/spec/sync.md` leaves the delay open, so this is technical, not Tyler's. Cost accepted: ~+100 ms of remote-player display latency. To land with steps 5-6: a new ADR (write-adr skill) amending 0010's "Interpolation delay" row, the constants changed in `interp::delay`, the native delay tests updated to the new values, and `extrapolation_ratio` re-measured and asserted `≤ 0.2` (if it is still above, stop and report, do not tune further).
