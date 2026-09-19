# M31: Rates: chunk pacing, soft cap, rate limits, byte budgets

Status: not started · After: 29 · Tyler-dependent: no (may raise PRE-PLAN §11 item 8; see Planning decisions)

**Split.** The PLAN.md row "rates and integrity" is about 1,900 lines, so it is two briefs. This one is everything in 0010 that paces bytes, plus the counters that prove it. `31b-desync-hashes.md` is the integrity half of 0013 and needs this brief's chunk bucket.

## Goal
Per client, chunk data is paced by a token bucket and sent visible-first, tick frames are held under a soft cap by degrading that client's frame rate, actions and camera reports are rate limited, and the netcode suite asserts deterministic byte counters against `budgets.json`. The 128-chunk cap is measured at full zoom-out and the result is written down.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0010-rates-and-subscriptions.md` (all of Decision; Worked numbers)
3. `docs/decisions/0011-wire-format-and-deltas.md` (frame sections; Versions instead of acks: the snapshot-instead-of-deltas rule)
4. `docs/decisions/0020-testing-strategy.md` (§7 assertions, §9 budgets file)

Also cited: 0004 (admit step 2: `RateLimited`), `PRE-PLAN.md` §9 risks 3 and 10. Rules that apply: `.claude/rules/hot-paths.md`, `.claude/rules/determinism.md` (pacing is host-side and unlogged, but must be reproducible under the virtual clock).

## Scope
- **Chunk-data bucket** per client: refill and burst from `WorldConfig.bandwidth` (0009; defaults 0010), refilled per tick in integer bytes (rate / tick rate), so it is a function of tick count, not wall time. It gates ChunkEnterPristine, ChunkSnapshots and resync snapshots only; every other section bypasses it (0010: tick frames never queue behind chunk data).
- **Priority** of the per-client enter queue: visible, then distance to `camera + velocity × 0.5 s` (0010 Bandwidth table). A queued chunk that leaves the subscription set is dropped from the queue; a chunk's deltas start only after its enter is sent (0011).
- **Soft cap + degrade** per client: a 1 s sliding byte window over non-chunk sections and the backlog `tick − last_received_tick`; levels 1 → 2 → 4 ticks per message (0010 Rates: Degrade), frames concatenated whole in one message and applied one by one by `on_frame`. A chunk whose queued deltas outgrow its snapshot is sent as a snapshot through the bucket.
- **Heartbeat under degrade:** M28's heartbeat still meets its interval at level 4; asserted.
- **Action rate limit** per connection from `WorldConfig.actionRate` (0004): over-limit actions get `Rejected(Engine(RateLimited))`, unlogged. **Camera-report drop rule** of 0010.
- **Counters → budgets.** `NetCounters` extended (below); ceilings and exact values in `packages/engine/budgets.json` under `net.*`.
- **New fixture `fixtures/busy-field`:** a dense field of timer-driven entities doing whole-value puts at the rate of 0010's "200 active machines" worked number, plus a bench-only genesis that fills chunks to the "dense chunk" figure.
- **Churn measurement** (risk 3): scenario family `zoomout/*`, results recorded in Deviations and as ceilings.

## Non-scope
`Hashes`, `ResyncChunk` (M31b). Interpolation delay adaptation (M30). Reference-game measurements and the byte-diffing decision (M36b). Wall-clock tick benchmarks (M36).

## Files, packages and crates touched
- `packages/engine/crates/engine`: bucket, enter queue, degrade and limits inside M15's `Host<G>`, beside `SubscriptionSet`; native tests through `testkit::Loopback`
- `packages/engine/src/test/net-harness.ts`, `packages/engine/tests/netcode/`, `packages/engine/budgets.json`, `packages/engine/fixtures/busy-field/`

## Seams
**Provides:**
- `NetCounters` additions, on top of M15's per-connection counters (`bytes_down`, `chunk_snapshots`, …): per-section bytes; `chunkEnters`, `chunkLeaves`, `reentersWithin5s`, `reenterBytes`, `capEvictions`, `lateVisibleTicks` (ticks from a chunk becoming visible to its enter being sent; max and p95), `degradeLevel` per tick, `rateLimited`, `cameraReportsDropped`.
- `assertBudget(counters, 'net.<row>')` in `engine/test`: exact value equals the recorded one and is ≤ the ceiling; the failure message names the row.
- `HeadlessClient.panTo(x, y, tilesPerS)` and `setView` scripted on the virtual clock.
- Chunk-bucket entry point `enqueueChunkSnapshot(conn, coord, priority)` for M31b's resync answer.
- Multi-frame messages: `on_frame` accepts several whole frames per message.

**Consumes:** `Host<G>`, `SubscriptionSet`, counters, fixture ceilings, `testkit::Loopback` (M15); `FrameWriter`, `UplinkBatch.last_received_tick`, `encode_chunk_snapshot` (M14); admit pipeline and `EngineReject::RateLimited` (M16); heartbeat (M28); harness, `NetCounters`, `conditionLink.stall` (M27); entities and timers for the fixture (M21, M21b); `budgets.json` + its loader (M04); `WorldConfig.bandwidth`/`actionRate` plumbing (M13).

## Planning decisions
- **Real frame sizes against the bandwidth budget (PRE-PLAN §10).** Three owners, as M15's brief already states: M15 landed counters and fixture ceilings; this brief asserts the 0010 rows under pacing with `busy-field`; **M36b** measures the reference game's busy furnace field and takes the byte-diffing decision of 0011. What M36b needs from here: `assertBudget`, per-section bytes, and `degradeLevel`, so its question ("above the typical row, or degrade engaged?") is one counter read. A miss is answered by byte diffing, never by raising a budget row.
- **`bufferedAmount` is ignored in v1.** One backpressure path (`last_received_tick`) on every host, since workerd has none (0009).
- **Degrade recovery** (unstated in 0010): step down one level after 2 s with the window under 75 % of the soft cap and backlog ≤ 2 ticks. Hysteresis avoids oscillation; numbers are config defaults, not Requirements.
- **The hard ceiling is structural,** soft cap + bucket refill; no third limiter. `net.hardCeilingBytesPerS` is asserted over every scenario's worst 1 s window.
- **Frames must be self-delimiting** to concatenate. If M14's framing is not, add an end-of-frame marker here with golden bytes.
- **Risk 3 decision rule.** Trigger: at the maximum view in the dense fixture, p95 `lateVisibleTicks` > 10 at one view-width/s, or `reenterBytes` during a < 64-tile oscillating pan above 25 % of bucket refill. If triggered, open PRE-PLAN §11 item 8 with the numbers; recommended default: cap 144 (ring 1 of the maximum view plus one entering and one retained column), after re-checking the client arena row of 0015 §5. Cap and zoom are Requirement numbers: nothing changes without Tyler. Not triggered: record the numbers, close the risk.

## Order of work
1. Counters + `assertBudget`; record today's numbers for M27's scenarios.
2. `busy-field` fixture.
3. Bucket + priority queue; join and pan scenarios.
4. Soft cap, degrade, multi-frame messages, snapshot-instead-of-deltas.
5. Action and camera limits.
6. `zoomout/*` measurement; write results into Deviations and `budgets.json`.

## Tests added
`rates/idle-sends-only-heartbeats`, `rates/steady-busy-field`, `rates/seven-remote-presences` (needs M19), `rates/uplink-panning`, `rates/join-wilderness`, `rates/join-dense-visible-first` (order of enters asserted; tick frames and acks keep flowing while the bucket is empty), `rates/bucket-refill-exact`, `rates/degrade-on-stall` (levels 2 then 4 during `stall`, recovery after, heartbeat interval held, hashes converge), `rates/deltas-collapse-to-snapshot`, `rates/action-rate-limited` (unlogged, `RateLimited` via `onActionResult`; run at the engine default and again with `WorldConfig.actionRate` overridden, and the limit moves with it: 0004 Consequences), `rates/camera-flood-dropped`, `rates/hard-ceiling`, `zoomout/pan-1vw`, `zoomout/pan-2vw`, `zoomout/oscillate-48-tiles`, `zoomout/baseline-256x144`.

## Exit criteria
- [ ] Every `rates/*` test asserts through `assertBudget`; `budgets.json` has the `net.*` rows with a source comment per row (0010 table cell or worked number).
- [ ] `zoomout/*` numbers and the rule's outcome are written in Deviations; if triggered, the question is filed.
- [ ] Netcode suite still within its 0020 §3 budget (demote `zoomout/pan-2vw` first).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test netcode -t rates/` · `pnpm test netcode -t zoomout/` · `pnpm lint`

## Budgets
PRE-PLAN §7 "Bandwidth per client, steady" and "burst": `rates/*` via `assertBudget`. "Action rate / log": `rates/action-rate-limited`. Tick time is not measured here; the bucket and queue must stay O(subscribed chunks) per client per tick.

## Context artifacts
Netcode `CLAUDE.md`: `assertBudget`, how to add a `net.*` row, "raising a number is a reviewed change" (0020 §9).

## Manual device checks
none

## Deviations
