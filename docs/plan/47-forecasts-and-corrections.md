# M47: Forecasts and corrections

Status: not started · After: 46 · Tyler-dependent: no

Later-phase brief: goal, exit criteria and open questions. Filled in to the full template at the start of its phase, from 0078's Amendment (M41) and M46's Deviations.

## Goal
Items reach the client as forecasts the host corrects only when wrong: `advance` marks dirty lines by the events of 0078 §3, the host rebuilds the cheap forecast for each and sends it in section `Forecasts` (13) to every connection whose subscription meets the line; the replica stores the latest forecast per line and answers `pos_at(line, run, render_t)` by the formula of 0078 §2, with no belt rule. The saturated-viewport scenario measures bytes per second against the 16 KB/s row and corrections per visible run; the belts tick baseline is re-recorded with the tracker on.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (whole, with its Amendment)
3. `docs/plan/41-forecast-spike.md` (Deviations: the instrumented events, the chosen `path` depth, the periodic-spawner decision)
4. `docs/architecture/sync-and-netcode.md` ("Rates, subscriptions, bandwidth"; the netcode `assertBudget` pattern in `tests/netcode/rates.test.ts`)
Rules that apply: `.claude/rules/determinism.md` (the tracker is host-only but runs inside the tick), `.claude/rules/hot-paths.md`.

## Scope (sketch)
- `transport/forecast.rs`: the dirty list (a preallocated `Vec<LineId>` plus a per-line bit, cleared at `seal`), the builder (`Forecast`, `RunForecast` as 0078 §2, `path` depth from the amendment, `period` if adopted), `forecast_version` per line.
- `advance` marks the events (M42's `touched` and `jam` hooks become the marking); the cost is measured against M45's baseline and recorded (re-record `belts-tick.json` if the reviewed delta is under the amendment's 1 ms).
- `wire/forecast.rs`: section 13, allocation-free; the layout in `wire/CLAUDE.md`; a frame that cannot fit every dirty forecast keeps the rest dirty (0078 §7), the one-second resend rule.
- Replica: `Transport::apply_forecast`, `pos_at(line, run_index, render_t) -> Option<(LineId, pos)>` following `path` then plain `Next` links; counters `forecastsApplied`, `forecastSeenLate` (applied for a tick already rendered: the client's render time is past the forecast's tick when it arrives).
- Netcode: the saturated-viewport scenario on `fx-belts` (`Regime::SaturatedView` at genesis through `BeltsParams.bench`, jams toggled by scripted `Sink`/`DeadEnd` requests), one client holding the whole view, 20 s of virtual time, production hashing on: `assertBudget({ transportDownBytesPerSec }, 'transport.downBytesPerSec')` against a new `counters.transport.downBytesPerSec` row (16,384; its `formula` names the scenario), `transport.correctionsPerVisibleRunPerSec` recorded in the row's formula, `forecastSeenLate` at the median network profile recorded.
- A followability test on the replica: for a scripted world with no corrections for 50 ticks, `pos_at` equals the host's actual positions at every tick (the host's `items_in` as the oracle).

## Seams
**Provides:** `SectionId::Forecasts`, `wire::forecast`, `Transport::{apply_forecast, pos_at, forecast_counters}`, host dirty list and builder, the `counters.transport.*` rows, `engine/test` `forecastCounters(client)`, the saturated-view netcode scenario (M48, M57 reuse).
**Consumes:** M41's event list and byte decision, M46 structures and `last_sent`, M45 baseline and world.

## Exit criteria
- [ ] `belts/forecast_followable` (replica positions equal host positions for 50 correction-free ticks) and `belts/forecast_corrected_on_jam` (a jam forming moves the forecast within one frame) pass with inject-fail-reverts.
- [ ] `belts/saturated_view_bytes` passes `transport.downBytesPerSec` at 16,384 B/s with every visible belt saturated and jams toggling at the amendment's worst cell; the row's formula records the measured number and corrections per visible run per second.
- [ ] `slow_tick_belts_large` with the tracker on is within 1 ms of M45's median, or the amendment names the cost and an optimisation step ran; the baseline is re-recorded for the reviewed delta.
- [ ] `no_alloc_wire` and `no_alloc_transport` cover the builder and the section; the netcode scenario's `MajorGC` count is zero on the host side is not asserted (server is outside 0016).
- [ ] `pnpm test` and `pnpm lint` are green.

## Open questions (answered by earlier phases)
- M41: the exact dirty events, `path` depth, the periodic-spawner forecast, the expected bytes at the worst cell.
- M46: the per-connection `last_sent` shape (reused for forecast versions).
- Left to M48: late join cost, degrade behaviour, position-window culling if the budget needs it.

## Deviations
(filled in during execution)
