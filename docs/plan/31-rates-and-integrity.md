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
- **The number this milestone has to pace against.** M15 measured `encode_chunk_snapshot`'s O(all entities)-twice-per-chunk cost under a realistic join — 2,000 entities across a 121-chunk view, one connection joining at once: **10.3 ms, 11,131 bytes**. That single join exceeds 0010's entire 10 ms tick-CPU budget on its own, before any other connection's frame or `apply`/`tick` work (`docs/plan/15-connection-and-subscriptions.md`'s Deviations, "Measured, not fixed"). This is what the enter queue and per-tick chunk-bucket refill must pace across ticks rather than pay in one.
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

### Steps 1-2 (first delegation)

- **Step 1 counter placement.** `assertBudget(counters, row)` is `src/test/budget.ts` (exported from `engine/test`); it reads `budgets.json` with `process.getBuiltinModule('node:fs')`, so `engine/test` stays browser-bundle safe. Rows are `counters.net.<row>` (camelCase, beside `counters.presence`, following M30's `counters.presence.downBytesPerSec7Remotes`): `{ counter, exact, ceiling, source }`, where `counter` is a dotted path into the object passed to `assertBudget`. Failure messages name `net.<row>`; exact-vs-recorded and over-ceiling are distinct messages. `rates/assert-budget-names-the-row` pins that.
- **Counters landed in step 1 are the ones derivable from the wire** (`src/test/net-sections.ts`, parsed from `trace()` entries so determinism is untouched): `NetHarnessCounters.sections` (whole-section bytes by `SectionId` name), `header`, `frames`, `heartbeats`, `chunkEnters`/`chunkLeaves` (coordinates in sections 4 and 6 only; a chunk entering as a `ChunkSnapshots` entry is not decoded to a coordinate), `worstSecondBytesDown`. **Deferred to the steps whose Host state they need, not stubbed as zeros:** `reentersWithin5s`, `reenterBytes` (needs per-connection enter coordinates, so a Host counter, step 3), `capEvictions`, `lateVisibleTicks` (step 3), `degradeLevel` (step 4), `rateLimited`, `cameraReportsDropped` (step 5). Those need one batched `sim_conn_counters` widening (ABI) plus the Rust counters; do it once in step 3. M31b's `net.*` frames are single whole frames only: `parseFrame` cannot split concatenated frames, so step 4's multi-frame messages need it to learn the framing (or an end-of-frame marker).
- **Today's numbers for M27's scenarios (before any pacing)**, recorded as `counters.net.baseline*` (ceiling = ceil(exact x 1.1)) and asserted by `rates/baseline-*` in `tests/netcode/rates-baseline.test.ts`: counters-exact (seed 4001, client 0): bytesDown 112, chunkEnters 15; sections Global 10, OwnPlayer 5, ChunkEnterPristine 32, ChunkSnapshots 16, header 20, 2 frames. join-converges (seed 1001, client 0): bytesDown 335, worstSecondBytesDown 196; 11 frames, 2 heartbeats; sections Global 44, OwnPlayer 5, ChunkEnterPristine 32, ChunkSnapshots 16, Presence 44, ActionResults 5, ChunkDeltas 50. late-join (seed 1002, the joiner, client 1): bytesDown 275, worstSecondBytesDown 161; 10 frames, 3 heartbeats.
- **Step 2, `fixtures/busy-field` (`fx-busy-field`).** `Game` is `BusyField<const DENSE: bool = false>`; `export_game!(BusyField<false>)`, so the `.wasm` and netcode harness get the steady field and the native-only bench genesis is `BusyField<true>` (all 121 chunks, chunk radius 5, 24,200 entities; `max_entities` must be raised). Steady genesis: 200 machines on a 20 x 10 grid, 3-tile pitch, period 50 ticks (`PERIOD` = 2.5 s), phase `1 + id % 50` so 4 puts per tick. Dense chunk: `fill_chunk` = 200 dormant machines (`period == 0`) + 224 modified tiles; `Action::Fill { cx, cy }` does it on any host with growth 200 entities / 224 tiles, nominal 28,288 B, so the world needs `maxActionGrowth >= 28,288` and `maxEntities` room (the netcode test passes 65,536 / 4,096).
- **Measured, native `Loopback`** (`fixtures/busy-field/tests/load.rs`, pinned): steady field 400 puts per 5 s (80/s exactly), 7,446 B down per 5 s for one client = 100 frames x 13 B (10 B header + section id and length) + 400 puts at 15.4 B (0010's ~16 B). Dense join at camera radius 1 (9 chunks, all dense): 35,195 B, 3,911 B per chunk (0010's ~4 KB); the 64 KiB `Loopback` frame buffer cannot hold a 121-chunk join, so the full-view figure comes from the netcode harness in step 3+.
- **Other.** `Cargo.lock` gained `fx-busy-field`. The `fixtures` build step is now the slowest build step (7 s of the 10 s build budget, `build WARN 10s/10s` on the cold run). The new fixture crate's tests live in `fixtures/busy-field/tests/`, outside `crates/engine/tests/`, so `engine-test-binary-layout.test.mjs` does not apply (its scope is `crates/engine/tests` only). The netcode `CLAUDE.md` was at its 60-line cap: prose reflowed to 140 columns to fit the new `assertBudget` section (58 lines). No Rust engine-crate edit yet, so no fixture-rebuild cost was paid beyond the new crate; netcode harness change is trace-read-only, `trace()` bytes unchanged (`pnpm test:slow netcode` not run for that reason; the ws transport path is untouched).
