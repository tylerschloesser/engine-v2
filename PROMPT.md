# PROMPT: finish everything outstanding

## Status

- **Phases 1-4 are done** (tag `phase-4-complete`, 2026-10-10). **Goal (Tyler, 2026-10-10): close every item below so he can start iterating on features.** Start from root `CLAUDE.md`; this file only lists what is left. Work on `main`, no branches; commit early and often; push green commits yourself.
- **M29 passed** on the iPhone 12 (round `tyler-m29`, the `device-check` skill). The phone-round tool is deleted (ADR 0070); recover it from tag `phase-3-complete` only if a round truly needs it.
- **CI:** the gc projects run on one worker (ADR 0071); green on `244cf2e8`.

## Your job

Work every item below; Tyler's answers are recorded on each. Record technical choices with the `write-adr` skill. Remove each item from this file as it closes (commit and push); delete this file in the commit that closes the last one, and tell Tyler.

## Tyler's items (answered 2026-10-10)

- **Android** is not run anywhere since late Phase 3. The Pixel 5 is on USB (`adb devices`); drive it from the Mac (Chrome over `adb` / CDP), never ask Tyler to tap.

## Technical (yours)

- Reference game, never diagnosed: tile (58, 55) (wood, `collect-flow.spec.ts`) never completed a `collectN` in one observed run; `net.hashesBytesPerS` read 68.6 B/s against a 66 B/s ceiling once.
- Known, no action unless it moves (not an open item): `slow_tick_large_save` sits at 2.87-3.0 ms against the 3 ms desktop proxy (a quiet red is a regression, a loaded red is not; ADR 0063).
