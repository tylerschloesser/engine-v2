# 0078: Replicating transport lines: structures as puts, motion as forecasts with corrections

Status: Proposed (2026-10-11). Implements [0076](0076-transport-lines-engine-game-split.md) §7; amends [0011](0011-wire-format-and-deltas.md) (two new sections), [0013](0013-sessions-and-integrity.md) (what the per-chunk hash covers) and [0012](0012-prediction-and-reconciliation.md) "Remote motion" (a second interpolation path beside `InterpBuffer`). The scheme is measured in milestone 41 (`docs/plan/41-forecast-spike.md`) and built in milestones 46-48; the amendment that accepts it records the measured correction rate and bytes.

## Context

A client must draw items moving at 60 fps on belts that span far beyond its viewport, while the host sends nothing per tick that merely says "everything moved by one step" (`docs/architecture/sync-and-netcode.md`: never replicate per-tick progress) and the client runs no belt logic (Tyler, 2026-10-11). Tyler's answer is forecasting: for each visible item or run the host says where it will be, and sends an update only when the forecast turns out wrong. Exact motion depends on upstream and downstream state that is too costly to walk every tick, so the forecast is deliberately cheap and its corrections are budgeted. The replication budget is the existing soft cap of 16 KB/s per client (`host/pacing.rs`), with every visible belt saturated.

What exists: chunk-scoped whole-value deltas with versions ([0011](0011-wire-format-and-deltas.md), [0064](0064-phase-3-decisions-sync-and-netcode.md) §18), chunk snapshots on subscribe, per-chunk desync hashes ([0013](0013-sessions-and-integrity.md)), a client render time `host_now - delay` with the delay sized from the presence interval ([0040](0040-interpolation-delay-presence-interval.md): floor 200 ms, cap 400 ms), and `InterpBuffer` for presence and "moving entities" that no game has yet ([0012](0012-prediction-and-reconciliation.md)).

The observation the scheme rests on: the client renders tick `t` only after `delay` (at least 200 ms, four ticks) has passed on the host clock. A correction the host sends at tick `t` reaches the client after one-way latency, which on the target networks (`docs/architecture/README.md`: decent mobile, not worst case) is under the delay. So a correction usually arrives *before* the client renders the tick it corrects, and the forecast is wrong on screen only when latency exceeds the delay or a frame is lost. The forecast is not a prediction of the far future; it is what lets the host stay silent while things go as expected.

## Decision

**1. Two kinds of replicated line data.** A line's **structure** (`len`, `speed`, `Output`, segments, anchor chunk; [0076](0076-transport-lines-engine-game-split.md) §4) is replicated whole-value per line, on change, like an entity: a new frame section `LineStructs` (section id 12; `wire/CLAUDE.md` owns the layout) carries `Put { id, structure }` and `Gone { id }`, routed to every connection whose subscription meets the line's chunk set; a `ChunkSnapshots` entry also carries the structures *anchored* in that chunk (anchor = the chunk of the line's front point, the multi-tile entity rule of [0007](0007-world-model.md) §5), with their forecast at the snapshot tick. A line's **motion** is replicated as a **forecast** through section `Forecasts` (13).

**2. A forecast is per line, at a tick `T`, and lists runs.** `Forecast { line, tick: T, runs: [RunForecast] }` with `RunForecast { item, count, pos: position of the first item at T, stop: Option<position>, path: [LineId; <= 4] }`:

- A run moves toward the front at the line's speed: `pos(t) = max(pos - speed * (t - T), stop)` for `t >= T`; items in a run are `SPACING` apart behind the first.
- `stop` is where the first item will halt (the end of a jam ahead plus `SPACING`, the line front of a `DeadEnd`, the front of a blocked `Merge`/`Fork`), or `None` when nothing in sight blocks it.
- When `pos(t)` goes below 0 the run continues at `pos + next.len` on the next line of `path`; past the explicit `path` it follows `Output::Next` links as long as they are plain (`Next`) and stops at the front of anything else. A run that will split at a `Fork` is sent as several entries (one per contiguous group with the same path), so a path is always one line per entry and the client makes no choice. A `Merge` target in `path` carries its landing position explicitly (`enter_pos`, the host's `at - overshoot`), so the client applies no entry rule.
- The client stores the latest forecast per line and evaluates it at its render time (host ticks, fractional, from `InterpDelay::render_time`) with linear motion, no squash and no rule. That is the whole of client interpolation for items: "follow the forecast". `InterpBuffer` is not used (items do not carry velocity samples; their motion is piecewise linear by construction).

**3. The host sends a line's forecast when it changes, and otherwise never.** `Transport::advance` computes each line's new state anyway; it marks a line *dirty* when the tick's outcome is not what the current forecast says: a run blocked at a position other than its `stop`, a run that moved although its `stop` said it would not, a hand-off or fork decision other than the forecast's path, an item inserted or removed (spawner, sink, inserter, surgery), a structure change. A clean tick marks nothing. The per-tick cost of this check is one comparison per run that was touched by the advance, which a run representation keeps near O(lines that changed) ([0077](0077-transport-item-representation.md)). After the advance the host rebuilds the forecast of each dirty line (the *cheap* forecast: what the line will do if its upstream inputs and downstream outputs keep their present state; it walks at most the `path` depth of 4 lines) and queues it to every connection whose subscription meets the line's chunk set. Nothing is sent for a line whose forecast did not change, however long it keeps moving.

**4. Scope and culling.** A connection receives a line's structure and forecasts while any chunk of the line's set is subscribed; it receives `Gone` for the structure when it drops out (chunk leave) and forgets the forecast with it. Runs outside the subscribed chunks are not culled in the first build (a merged line is sent whole); milestone 47 measures the bytes at the stated scale and adds a position-window cull (`runs whose positions map into subscribed chunks`) only if the budget needs it.

**5. Budget.** `counters.transport.downBytesPerSec` in `budgets.json`, ceiling 16,384 B/s per client measured in the netcode harness on the saturated-viewport scenario of milestone 47 (a dense grid of belts and splitters fed by spawners into sinks, with jams forming and clearing at a stated rate), with production hashing on and the client's whole view subscribed. The measurement also records `transport.correctionsPerSec` and corrections per visible run per second; the amendment that accepts this ADR states both. A `forecast_seen_late` client counter (a correction applied for a tick the client has already rendered) measures how often the screen was wrong; it is reported, not budgeted, in this effort.

**6. Hashes and prediction.** The per-chunk desync hash covers line structures anchored in the chunk and nothing of the items: the replica's items are forecast-derived, never authoritative per tick, and must not be compared. The full state hash and snapshots cover everything ([0076](0076-transport-lines-engine-game-split.md) §7). Under prediction there are no transport writes ([0076](0076-transport-lines-engine-game-split.md) §6); the client's overlay never touches a line.

**7. Degrade and overflow.** A connection degraded to every 2nd or 4th tick ([0010](0010-rates-and-subscriptions.md)) receives the latest forecast of each dirty line in the frame it gets; forecasts are idempotent whole values, so skipped frames lose nothing. A frame that cannot fit every dirty forecast keeps the rest dirty for the next frame (the same rule as queued chunk deltas), and a line whose queued forecast is older than one second is resent in full on the next frame regardless.

## Alternatives rejected

- **Replicate item positions every tick for visible lines.** Per-tick progress on the wire; at a saturated viewport it is hundreds of kilobytes per second.
- **Client-side belt simulation of the visible lines.** Tyler's rule, and [0012](0012-prediction-and-reconciliation.md)'s reason: inputs from unsubscribed lines make it systematically wrong.
- **Forecast per item, not per run.** Bytes scale with items; runs are the natural unit (packed items share one future) and are what [0077](0077-transport-item-representation.md) stores.
- **A fixed horizon with periodic refresh.** A refresh every `H` ticks for every visible run is a steady cost proportional to visible items (about 15 KB/s at 1,500 visible runs and `H = 16`), the opposite of "send only when wrong". A forecast is valid until invalidated; `path` plus "follow plain `Next` links" keeps a free-flowing run valid for as long as it flows.
- **Hermite through `InterpBuffer`.** Items have no sampled velocity; their motion is exactly linear between hand-offs and stops.
- **Hashing items in the chunk hash with a tolerance.** A hash cannot be tolerant; structure-only is exact and cheap.

## Consequences

- New wire sections 12 and 13, new `wire/forecast.rs` writer and reader, both allocation-free; `no_alloc_wire` extends to them.
- The host keeps per line a `forecast_version` and per connection a `last_sent` map (a sorted `Vec`, reserved at attach for `max_lines`), plus a per-tick dirty list; all preallocated.
- The late-join cost at scale (every structure and forecast of a dense world through the 48 KB/s chunk bucket) is measured in milestone 48 and may need a smaller default view or a compact structure encoding; recorded, not solved here.
- Deferred: forecasting a spawner's periodic inserts (a `period` field on a line, so a spawner at a steady rate causes no corrections); position-window culling (§4); any smoothing of a late correction on screen (today it snaps; `forecast_seen_late` says how often).
- Trigger to revisit: `transport.downBytesPerSec` over budget in milestone 47 with the cheap forecast, or `forecast_seen_late` above 1 % of rendered ticks on the median network.

## Sources

- Tyler's answers of 2026-10-11 (forecasting, client runs no belt logic, the budget).
- [0010](0010-rates-and-subscriptions.md) (soft cap, degrade), [0011](0011-wire-format-and-deltas.md), [0012](0012-prediction-and-reconciliation.md), [0013](0013-sessions-and-integrity.md), [0040](0040-interpolation-delay-presence-interval.md), [0064](0064-phase-3-decisions-sync-and-netcode.md) §18-§22.
- Gambetta, "Entity interpolation" (https://www.gabrielgambetta.com/entity-interpolation.html) for rendering in the past; as cited by [0012](0012-prediction-and-reconciliation.md).
