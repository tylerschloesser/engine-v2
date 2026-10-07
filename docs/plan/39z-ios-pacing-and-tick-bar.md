# M39z: what M09b asserts on iOS, and which phone is the large-save bar

Status: not started · After: 39y · Tyler-dependent: no (Q18 and Q19 answered 2026-10-07: "yes to all" on the recommended defaults)

## Goal
Tyler accepted two recommendations on 2026-10-07 (`docs/plan/questions-for-tyler.md`):
- **Q19.** On iOS Safari, M09b-fill-rate passes on the engine-owned numbers, and its rAF limits (p95 17.5 ms, 5 frames over 20 ms per 10 s) become advisory. M39v's three-way comparison showed the iPhone's gaps are WebKit frame delivery: callback lateness 0-0.2 ms, no main-thread stall behind any gap, GPU exec p95 2.8 of 6 ms. Driverless, the iPhone still reads 8-10 per 10 s and p95 17.7-18.2 ms. The Pixel keeps the rAF limits, and it passes them.
- **Q18 (a).** The large-save tick bar is the iPhone 12 at p95 (10 ms, ADR 0010). The Pixel 5's number is informational: its tail is about 1 tick in 6 waking on a little core (M39s Deviations, `m39s-pixel`), which a page cannot control.

When this is done, an ADR records both decisions, `checks.mjs` and `device-checks.md` assert them, and a test shows each new verdict.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39v-iphone-gap-attribution.md` Deviations (the comparison table; the `gaps.summary` fields `withStall`/`withoutStall`, `late`, `stall`)
3. `docs/plan/39s-sim-tick-tail.md` and `docs/plan/39y-wasm-tick-cost.md` Deviations (the Pixel's bimodal ticks, the cold wake)
Also `docs/decisions/0010-rates-and-subscriptions.md` (the tick ceiling) and the M09b and M39-large-save sections of `docs/plan/device-checks.md`.

## Scope
1. **ADR 0056** (`write-adr` skill), amending what 0010 and the M09b check say about phones:
   - (a) On iOS Safari, M09b's pass is GPU exec p95 within its limit, **and** no long gap with an engine cause: every gap over 20 ms in the measured windows has `stall` under 16 ms and callback lateness under 2 ms. The rAF p95 and over-20 numbers are still recorded, shown as advisory.
   - (b) iOS frame-pacing items are judged only from driverless runs. A driven iOS attempt of M09b, M16-coexist, M29-net-heap or M34-remote-motion records its numbers with a note and no pass/fail verdict on rAF or hitch criteria.
   - (c) The large-save tick bar is the iPhone 12's `tick_p95_ms` at 10 ms. On Android the criterion is reported, not judged.
   Cite the rounds by name. Don't edit 0010 itself; the orchestrator adds its "Amended by" note.
2. **`checks.mjs`.** Make (a), (b) and (c) the criteria. Platform comes from the round's `env` (user agent; `iPhone`/`Mac OS X` WebKit against Android). Driven against driverless comes from the attempt's driver mode. Find how a round knows it is driven (`--drive`, or `inspector` on attempts, M39v) and name it in Deviations. Every check's `pass:` hash must still match its `device-checks.md` text. If you change a pass text, update the hash the way the existing tool does, and say how.
3. **`device-checks.md`.** Update the M09b and M39-large-save **Pass** text to match, and the note on driven iOS frame-pacing items. Change no other item.
4. **Tests** (`pnpm test tools`), each seen red first:
   - an iOS M09b attempt with rAF p95 18 and over-20 of 9, GPU 2.8, and gaps with no stall passes;
   - the same with one gap carrying `stall` 30 fails;
   - an Android M09b with rAF p95 18 fails;
   - a driven iOS M16-coexist attempt has no hitch verdict;
   - an Android large-save with p95 26 is reported, not failed;
   - an iOS large-save with p95 11.5 fails.

## Non-scope
Re-running any round (the orchestrator's); `--apply` of existing rounds; any engine code; other items' criteria.

## Files touched
`scripts/lib/device-walk/checks.mjs` (and the module that applies criteria, if separate), their tests under `scripts/lib/`, `docs/plan/device-checks.md` (the M09b and M39-large-save sections only), new `docs/decisions/0056-*.md`.

## Exit criteria
- [ ] ADR 0056 exists and covers (a), (b) and (c).
- [ ] The six tests exist, pass, and were seen red (red lines pasted).
- [ ] `pnpm test tools` green (pasted line); every `pass:` hash matches its text.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test tools` (targeted, foreground). No phone runs.

## Manual device checks
After landing, the orchestrator re-applies the iPhone rounds' results under the new criteria, through a new driverless round with Tyler for the frame-pacing items.

## Deviations
(filled in during Phase 3)
