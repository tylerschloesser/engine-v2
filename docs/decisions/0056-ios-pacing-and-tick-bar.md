# 0056: What M09b asserts on iOS, and which phone is the large-save tick bar

Status: Accepted (2026-10-07). Amends what [0010](0010-rates-and-subscriptions.md) (the tick ceiling) and the M09b-fill-rate check say about phones. Implemented by M39z. Tyler answered Q18 (a) and Q19 "yes to all" on 2026-10-07. Amended by [0057](0057-ios-m09b-portrait-only.md) (iOS M09b measures portrait only).

## Context

M39v compared M09b-fill-rate and M16-coexist on the iPhone 12 three ways, with the agent's gap attribution on (`docs/plan/39v-iphone-gap-attribution.md` Deviations):

- Driverless (Tyler's QR, round `m39v-ios-driverless-1`): M09b over-20 per 10 s 8, 10, 10, 9; rAF p95 17.7-18.2 ms; M16-coexist 11 gaps over 25 ms.
- Driven, attached (`m39v-ios-attached-1`): 9, 17, 20, 34; p95 17.8-20.5 ms; coexist 50 gaps. Driven, inspector detached (`m39v-ios-detached-1`): 8, 24, 24, 32. Control without the heartbeat (`m39r-iphone`): 13, 17, 18, 28.
- In every leg callback lateness was 0-0.2 ms and almost no main-thread stall stood behind a gap (coexist: 1 of 524 attached, 0 of 245 driverless); GPU exec p95 2.8 of 6 ms. The gaps are WebKit frame delivery, not page work, and a live WDA session makes them worse.

Large-save tick time: the Pixel 5's tail is about 1 tick in 6 waking on a little core (M39s Deviations, round `m39s-pixel`; M39y's cold-wake finding), which a page cannot control. The iPhone 12 is the baseline phone.

## Decision

**1. M09b-fill-rate on iOS Safari passes on the engine-owned numbers.** The pass is: `isolated` and adapter green, GPU exec p95 within its limit (6 ms), **and** no gap over 20 ms with an engine cause: every gap in the measured windows has `stall` under 16 ms and callback lateness under 2 ms (a gap without that attribution counts as a cause). The rAF p95 (17.5 ms) and over-20 count (5 per 10 s) are still recorded and shown, as advisory. The hitch proxy (gaps over 25 ms) keeps asking the person. On Android the rAF limits stay criteria (the Pixel passes them). M18-fill-rate-with-anchors, which borrows M09b's numbers, is unchanged.

**2. iOS frame pacing is judged only from driverless runs.** A driven iOS attempt (a round run with `--drive ios`; each attempt carries `inspector: 'attached' | 'detached'`) of M09b, M16-coexist, M29-net-heap or M34-remote-motion records its numbers with a note and no pass or fail on its rAF or hitch criteria (`raf_p95_ms`, `raf_over20_per_10s`, `engine_gap_causes`, `hitch_gaps_over_25ms`, M34's `snaps`). The item's other criteria are judged as before. Frame pacing for the tick comes from a driverless round with Tyler.

**3. The large-save tick bar is the iPhone 12's `tick_p95_ms` at 10 ms.** On Android the criterion is reported, not judged (the number is in the evidence and metrics, the verdict ignores it). The 10 ms figure is [0010](0010-rates-and-subscriptions.md)'s and PRE-PLAN §7's; this ADR changes who is held to it.

**4. Where it lives.** `scripts/lib/device-walk/checks.mjs` (criteria carry `platform`, `only` and `pacing`; `evaluate` takes `{platform, driven}`), `auto-round.mjs` (platform from the phone's `env` user agent, driven from the round's `inspector`), and the Pass text of the two items in `docs/plan/device-checks.md`.

## Alternatives rejected

- **Loosening the numbers (p95 18.5, 10 over-20):** it calls a WebKit delivery property a budget and still fails a driven run.
- **Judging the Pixel's tail against 10 ms:** it fails on a core migration no page controls (M39s).
- **Dropping M09b on iOS:** the GPU share and the engine-cause check are real evidence.

## Consequences

- A driven iPhone round no longer ticks the pacing items; a driverless round is needed for them.
- A real main-thread stall on an iPhone still fails M09b even though the rAF numbers are advisory.
- Revisit if WebKit's driverless gaps change (a new iOS) or the Pixel's wake behaviour does.

## Sources

- `docs/plan/39v-iphone-gap-attribution.md`, `docs/plan/39s-sim-tick-tail.md`, `docs/plan/39y-wasm-tick-cost.md` Deviations; `docs/plan/questions-for-tyler.md` Q18, Q19.
