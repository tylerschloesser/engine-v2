# 0080: Belts budgets as measured

Status: Accepted (2026-10-13). Amends [0062](0062-budgets-as-measured-at-phase-3-exit.md) with the rows the belts effort added (tick, frame, bytes, memory and records for transport lines) and the measurements against them, on the desktop proxies and in the harnesses; the phone cells are not run (the iPhone was not on the USB cable and no Pixel was attached at milestone 57's gate) and are left as device-check rows with their defaults. Written in milestone 57. The figures' origins: [0078](0078-transport-forecast-replication.md) A9-A15, [0079](0079-transport-core-decisions.md) §21-§23, `packages/engine/baselines/{belts-tick,frame-belts}.json`, `packages/engine/budgets.json`.

## Context

0062 recorded Phase 3's budgets. The belts effort added a tick cost (the transport `advance`), a frame cost (belt sprites and items in a dense view), a byte cost (structures, forecasts, the late join) and a memory cost (the transport arenas), each with a desktop proxy and a gate, and deferred the phone readings to milestone 57. This ADR is the ledger for those rows in 0062's form: the number, the owner, the measured value and date, the verdict, and how to re-measure. 0062 §1's rules for wall-clock budgets apply unchanged (0047's floor and `minDeltaMs`).

## Decision

**1. The ledger.**

*Tick time* (owner 0079 §19 (d), §21; desktop proxy `belts-tick`, the `Mixed` bench world of milestone 45: 3,810 lines, 250,000 items at the recommended caps, 8 ticks of `advance` plus the frames for a 256 x 144 view).
- Desktop proxy: **0.2146 ms** median (tick 0.12, frames 0.10; `packages/engine/baselines/belts-tick.json`, limit 5 ms, 2026-10-12; 1.2638 before the schedule became transport state, 0079 §21). Gates at the 0047 floor. Re-measure: `pnpm test:slow rust -t slow_tick_belts_large` (the record lands at `test-results/rust/bench/belts-tick.json`, repo root).
- The reference bench field (`?bench=belts`: 48 saturated runs, 12,264 belt entities, 348 lines, 98,304 items at the phone pair's caps): desktop Chromium tick p95 **0.215 ms** at maximum zoom-out, **0.270 ms** at 64 tiles across (2026-10-13, 10 s windows, load about 1.5). Tick 1 maps the whole field in 0.40 s natively (release). Recorded.
- Phone sim worker, belts: **not run** (manual). Re-measure: device check `M57-belts-tick`; the bar is 0056's 10 ms per tick on the iPhone 12.

*Frame time* (owner 0018 §9: main <= 4 ms, client-worker `frame` <= 8 ms, GPU <= 6 ms on the phone; desktop proxies 1.3 / 2.7 ms; 0047 A1 for the belts baseline).
- Desktop proxy `frame-belts` (`SaturatedView`, 1280 x 720, DPR 1): zoom-out main p50 0.361 ms, worker p50 1.267 ms (bimodal 0.914-1.762, 0047 A1's rerun rule); mid zoom (64 across, items drawn) main p50 0.261 ms, worker p50 1.861 ms, p95 2.067 ms (`packages/engine/baselines/frame-belts.json`, `minDeltaMs` 0.04, 2026-10-12). Met. Re-measure: `pnpm test:slow frame-bench -t bench.frame_belts`.
- The reference bench field on desktop Chromium (Metal 3 adapter): maximum zoom-out frame p95 **0.595 ms**, main p95 0.370 ms, rAF p95 16.67 ms, 0 intervals over 20 ms per 10 s, GPU p95 1.022 ms; 64 across frame p95 **1.980 ms**, main 0.305, rAF 16.67, 0 over 20 ms, GPU 0.752 ms, about 7,100 items drawn (2026-10-13 at 1-min load 1.5; a second read at load 5.8 gave 2.495 / 0.315 / 0.688); portrait 390 x 844 at maximum zoom-out (the field's 256 tiles on the short side, 555 along the long one for the client camera; the host still subscribes 256 x 256 about the centre, which covers the field) frame p95 0.635 ms, main 0.370, GPU 0.781 (GPU timing on in every belts run, so the frame and main figures include its readback). Recorded, not gated (`bench_belts @slow` pins the records and prints these).
- Phone frame shares with belts: **not run** (manual; the projection from 0062's ratios, about 3x main and 6x frame, puts the mid-zoom worker p95 near 12 ms against 8: the phone decides, and 0076 Consequences' tile-visual fallback is the lever if it misses). Re-measure: device check `M57-belts-frame-pacing` (driverless on iOS, 0056).

*Bytes* (owner 0078 A5: 16,384 B/s of sections 12 and 13 per connection; A9's gated cell).
- Saturated view, lifted: **3,946 B/s** exact (`counters.transport.downBytesPerSec`, ceiling 16,384; A11); the stress cell 19,468 recorded, not gated (A9). Re-measure: `pnpm test netcode -t belts/saturated_view_bytes`.
- A 4x4 balancer of the reference game: **1,392.5 B/s**, all `Arrival`s (A15). An underground pair: **148 B/s** (A14). An idle line holder: 268.6 B/s of per-tick frames (A12). Re-measure: `pnpm test:slow netcode -t reference_balancer_arrival_bytes`, `pnpm test netcode -t reference_underground`.
- Late join, 256 x 144 view at default pacing: fixture `Mixed` world **6.95 s**, `MixedFeeders` 6.30 s (A11, A12); the reference belt field **1.0 s and 180,256 B** (20 ticks; `ChunkSnapshots` 151,206 = 12.3 B per belt entity over 77 chunks, `LineStructs` 11,763, `Forecasts` 16,820; degrade level 1 throughout; 19 ticks and 174,064 B after 400 ticks of flow), against 0078's 10 s: met. The reference game's belts are entities and ride the chunk bucket, which costs less than the fixture's lists. Re-measure: `pnpm test:slow netcode -t reference_join_at_scale`.
- `counters.net.bytesPerHour` 325,638 of 20 MB (the entity discriminant and the caps, milestone 51). Met.

*Memory* (owner 0015 §5, 0079 §5, §21).
- Transport arenas at the recommended caps (32,768 lines / 262,144 items): **21,757,984 B** on a host, **18,022,416 B** on a replica, inside the sim and client arenas; the phone pair (12,288 / 98,304): 8,200,224 B and 6,799,376 B (0079 §21). The client arena needs about 25 MiB of its 48 with the recommended caps (fails at 24); the soak's arena is 9 MiB with caps 1,024 / 8,192 (milestone 51). Computed.
- The reference bench field: `engineMemGrows` 0 in both workers at both zooms on desktop, 98,304 items at the cap (2026-10-13). Phone: **not run** (manual). Re-measure: device check `M57-belts-memory` (60 s at each zoom after the field fills, about 140 s; no reload, grows 0).
- The shipped world's caps (question 15): the recommended caps stay until the phone read (default); the phone pair is the fallback.

*Render records* (owner 0076 §5, milestone 50).
- `counters.render.beltsViewRecords` **36,864** exact (ceiling 49,152: one sprite per belt tile across the 256 x 144 `SaturatedView`); the reference bench field 12,264 at maximum zoom-out in landscape and in portrait (every belt in view in either orientation; `itemLayerRecords` 2 and 0) and 893 at 64 across. Met. Re-measure: `pnpm test:slow frame-bench -t bench.frame_belts`, `pnpm test:slow browser -t bench_belts`.
- Zero-GC pages: `gc.pages.gc-belts`, `gc.pages.reference` 236 (the belt popover's panel, milestone 53b), `gc.pages.reference_single_player`; all exact. Re-measure: `pnpm test browser -t gc`.

*Determinism across engines.* Every `fx-belts` golden (15 scenarios) and the reference `full-game.log` replay to the same hashes in Chromium, WebKit and Firefox (`@engines` leg, 2026-10-13) and under Node and Bun on every release variant (the `belts` variants: plain 1,046,980 B raw / 270,089 B brotli, simd128 1,043,169 / 270,658; wasm-opt not on PATH). Met. Re-measure: `pnpm test:slow browser -t "@engines"`, `pnpm test:slow wasm -t feature-matrix`.

**2. Device checks that stay open.** `M57-belts-tick`, `M57-belts-frame-pacing`, `M57-belts-memory`, `M57-belts-android` (the Pixel's notes) and `M57-palette-look` (the two-row palette under the refusal label on a 390 px phone) in `.claude/skills/device-check/SKILL.md`, and `M53-item-lead` (0078 A12's lead; default accept). Each phone cell above moves from "not run" to a figure here when a row is walked; a miss is a question to Tyler with the profile, never a widened budget.

## Alternatives rejected

Gating the phone bench from the harness (no phone-side runner exists since 0070; the rows are hand-walked or Mac-driven one-offs). Building the tile-visual fallback before a phone misses the frame budget (0076 Consequences: the desktop does not need it).

## Consequences

The belt rows have desktop gates and recorded phone defaults; the phone readings are a day's round on Tyler's devices with the bench build served through `pnpm device:serve --tunnel --app reference --bench`. 0062 §2's "Re-measure" paths for phones no longer name `pnpm device:walk` (retired, 0070): the rows name the page and the HUD field.

## Sources

Milestone 57's Deviations (`docs/plan/57-belt-measurements-browsers-and-phones.md`, at tag `belts-complete`), `scratchpad/m57-report.md` (session-only), the baselines and budget rows named above; code checked 2026-10-13.
