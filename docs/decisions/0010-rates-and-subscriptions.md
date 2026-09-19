# 0010: Rates, subscriptions, and the bandwidth budget

Status: Accepted (2026-09-19)

## Context

`docs/spec/sync.md` leaves tick rate, send rate, interpolation delay, and a per-client bandwidth budget open, for "decent, not great 5G" mobile links over a TCP transport ([0009](0009-transport-and-hosting.md)). Subscriptions derive from a client-reported, untrusted camera ([0001](0001-camera-and-presence.md)), so the host's clamps set worst-case chunk count, bandwidth, and render load. Network budget assumed: RTT median 60–100 ms, p95 200 ms, p99 400 ms; jitter 10–30 ms; loss 0.5–2%; stalls of 0.3–3 s a few times an hour; at least 5 Mbps down / 1 Mbps up, of which the engine may use under 10%. Patterns taken from Fiedler's snapshot interpolation (delay sized from send interval plus jitter), Colyseus (20 Hz default patch rate), lightyear (priority-ordered sends under a byte cap), and naia (coarse scope plus fine relevance).

## Decision

**Rates**

| Parameter | Value |
|---|---|
| Sim tick | **20 Hz (50 ms)**; per-game constant in 10–60, fixed for a world's life |
| Host → client | One frame per tick when there is anything to send; otherwise nothing; a heartbeat frame at least every **500 ms** |
| Degrade | Per client: every 2nd, then 4th tick (frames concatenate) while `tick − last_received_tick` backlog grows or the soft cap is exceeded |
| Interpolation delay | Adaptive `max(2 × frame interval, frame interval + p95 inter-arrival jitter)`; initial **150 ms**, floor **100 ms**, cap **400 ms**; slewed with at most 10% time dilation, never stepped |
| Client → host | At most one uplink batch per 50 ms: pending actions (flushed at once), plus the latest camera report and presence sample at **≤ 10 Hz, on change**, plus `last_received_tick: u32`. At least one batch per 1 s |
| Host drop rule | Camera reports beyond 20/s per client are discarded |

**Tick CPU budget: ≤ 10 ms per tick** (20% of the 50 ms interval) on the slowest supported host (the baseline phone's sim worker; a Fly `shared-cpu-1x`, [0009](0009-transport-and-hosting.md)), covering `apply`, `tick`, frame building for every client and the log append. Derived, not measured: it is the largest value at which the 5 catch-up ticks per wakeup of [0005](0005-persistence-and-recovery.md) still fit in one interval, and it always leaves room for the 2 ms warmer and a worst-case generation miss ([0008](0008-chunk-generation.md)). Tick cost scales with active entities, never chunks ([0007](0007-world-model.md)). The automated proxy is the slow-tier native tick-time benchmark on the standard large save (size and load defined in [0020](0020-testing-strategy.md) section 9): median ≤ 3 ms on Tyler's Mac. A tick that overruns the 50 ms interval is counted and reported; sim time then falls behind wall time ([0005](0005-persistence-and-recovery.md)).

**Camera report** (`latest-wins`, 16 bytes, never seen by the sim): `{center_x: i32, center_y: i32, half_w: u16, half_h: u16, vel_x: i16, vel_y: i16}` in whole tiles and tiles/s. Sent when the tile-quantized rectangle or velocity changes, with a leading-edge send when motion starts and a trailing send at rest. The client sends the *view*; the host derives the chunk set.

**Subscription set** (host-side, chunks of 32×32 tiles, rings counted around the clamped view rectangle):
- Subscribe: every chunk within **ring 1**, plus look-ahead of `velocity × 1.0 s` in the direction of travel, capped at **2 extra chunks**.
- Unsubscribe: only when a chunk is beyond **ring 3** *and* has been outside the subscribe set for **5 s**. Pans that oscillate under ~64 tiles and zoom wiggles cause no traffic.
- Cap: **128 chunks per client**. Over the cap, evict farthest-first immediately, in priority order visible > ring 1 > look-ahead > retained.

**Untrusted-view clamps** (per-game config, sent in `Welcome` so the client clamps zoom-out to match): view at most **256 tiles per axis**; centre inside the world's coordinate range; zero or over-large extents are clamped about the centre, never rejected. Camera teleports are allowed; chunk pacing is the rate limit. At the clamp an unaligned 256×256 view spans 9×9 chunks, so ring 1 is 11×11 = **121 chunks**, which is why the cap is 128; a 256×144 view gives 88. At maximum zoom-out the cap therefore leaves little room for look-ahead and retention, and hysteresis degrades to farthest-first eviction. A phone at mid zoom holds 20–35 chunks and gets the full rings.

**Bandwidth budget per client** (application bytes; each WebSocket message adds ~85 B of WS + TLS + TCP/IP on the wire):

| | Budget |
|---|---|
| Steady state down, typical | **1–5 KB/s** (8–40 kbps) |
| Steady state up | **~0.4 KB/s** while panning (10 batches/s × ~38 B; ~1.3 KB/s on the wire), ~0 at rest |
| Soft cap for tick frames | **16 KB/s**. Above it: degrade that client's frame rate; a chunk whose queued deltas exceed its snapshot size is sent as a snapshot instead |
| Chunk streaming | Token bucket, **48 KB/s refill, 128 KB burst**, spent visible-first, then nearest to `camera + velocity × 0.5 s`. Tick frames never queue behind chunk data |
| Hard ceiling | **64 KB/s** (512 kbps, about 10% of the assumed downlink) |
| Data use | about 10–20 MB per hour of active play |

Worked numbers: a frame header is 10 B ([0011](0011-wire-format-and-deltas.md)), so 20 near-empty frames/s would cost ~1.9 KB/s on the wire, which is why idle ticks send nothing. 200 active machines changing state twice per 5 s are 80 whole-value puts/s × ~16 B = 1.3 KB/s. Seven remote players' presence at 10 Hz × ~14 B is ~1 KB/s. Desync hashes are ~60 B/s ([0013](0013-sessions-and-integrity.md)). A pristine chunk enter is ~3 B; a dense chunk (200 entities × ~16 B plus 0.5–1 KB of overlay runs) is ~4 KB.
- **Join, phone** (35 chunks): < 0.2 KB in wilderness; ~140 KB in a dense base, i.e. the burst plus ~0.25 s.
- **Join, maximum zoom-out** (121 chunks): < 0.5 KB in wilderness; ~480 KB if every chunk were dense, i.e. ~7 s, visible chunks first. That case likely exceeds the state budget in [0007](0007-world-model.md); games with dense content should configure a smaller view.
- **Worst pan** (maximum zoom-out, two view-widths per second): 16 columns × 11 rows = ~176 chunk enters/s. Wilderness: ~0.5 KB/s. Dense: ~700 KB/s wanted, paced to 48 KB/s (~12 dense chunks/s); far chunks arrive late, and nothing is legible at that speed.
- **Reconnect resume hint**: at most 128 × 8 B ≈ 1 KB up.

## Alternatives rejected

- **60 Hz tick** (Factorio): 3× host CPU and log volume for no visible gain, since clients interpolate and do not simulate.
- **Fixed 10 Hz sends at a 20 Hz tick:** doubles interpolation delay and gives TCP fewer following packets for fast retransmit.
- **Camera at 5 Hz:** saves ~80 B/s and adds up to 100 ms to chunk look-ahead.
- **Client sends chunk-set diffs:** stateful, larger, and harder to clamp than a rectangle.
- **640×384-tile view / 512-chunk cap:** 4× the worst-case client memory, join cost, and render load for a zoom level at which a tile is only 1–3 device pixels wide.
- **Rejecting over-large views:** a resize race would disconnect honest clients; clamping is harmless.

## Consequences

- **Games must never replicate per-tick progress.** Replicate parameters (`started_at`, `done_at`) and derive the bar from the synced tick clock ([0012](0012-prediction-and-reconciliation.md)). Belt-like content must be parametric too, or it breaks every row above.
- The clamp bounds memory and chunk count; pacing bounds bandwidth. Both live host-side, outside the sim, and are unlogged.
- Every number here is config with these defaults; the tick rate is stamped into the save because seconds-to-ticks conversion depends on it ([0006](0006-time-units.md)).
- The jitter, loss, and stall figures behind the budget are engineering assumptions, not measurements.
- Deferred to Phase 2: measuring real frame sizes against this budget with the reference game under the scripted-network fake transport, because no encoder exists yet.

## Sources

- `docs/research/sync.md` sections 1.5, 3.1, 3.3, 3.4; ADR brief resolutions 1–3 (10 Hz camera, 256-tile / 128-chunk clamp, which supersede the 5 Hz and 640×384 / 512 figures in research); `spikes/prediction-api/RESULT.md` (whole-value put sizes).
- https://gafferongames.com/post/snapshot_interpolation/ · https://docs.colyseus.io/room · https://github.com/cBournhonesque/lightyear · https://github.com/naia-lib/naia
- https://www.rcrwireless.com/20260203/5g/ookla · https://spenza.com/telecom/5g-vs-4g-speed-comparison/ (latency figures)
