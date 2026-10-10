# PROMPT: finish everything outstanding

## Status

- **Phases 1-4 are done** (tag `phase-4-complete`, 2026-10-10). **Goal (Tyler, 2026-10-10): close every item below so he can start iterating on features.** Start from root `CLAUDE.md`; this file only lists what is left. Work on `main`, no branches; commit early and often; push green commits yourself.
- **M29 passed** on the iPhone 12 (round `tyler-m29`, the `device-check` skill). The phone-round tool is deleted (ADR 0070); recover it from tag `phase-3-complete` only if a round truly needs it.
- **CI:** the gc projects run on one worker (ADR 0071); green on `244cf2e8`.

## Your job

Work every item below; Tyler's answers are recorded on each. Record technical choices with the `write-adr` skill. Remove each item from this file as it closes (commit and push); delete this file in the commit that closes the last one, and tell Tyler.

## Tyler's items (answered 2026-10-10)

- **Cloudflare:** remove the `reference-server-do` worker (wrangler is logged in). Tyler: yes, and downgrade Workers Paid: check nothing else on the account needs Paid, then tell Tyler to downgrade in the dashboard (billing is not in wrangler).
- **Desktop criteria:** M16's ten-press Paint HUD in desktop Chrome (`slice.html`); M34's two windows on the invite link plus "Slow 4G" own bars. Automate in Playwright before asking him to look.
- **COOP/COEP on a real static host is unverified** (ADR 0015 §3 listings, ADR 0067: both headers also on `304`). Tyler: deploy `games/reference`'s `vite build` to **Cloudflare Pages** (`_headers`); then `node games/reference/scripts/check-coi.mjs <url>` and `DEPLOYED_URL=<url> pnpm test:slow -t deployed/` against a server on another origin.
- **Android** is not run anywhere since late Phase 3. The Pixel 5 is on USB (`adb devices`); drive it from the Mac (Chrome over `adb` / CDP), never ask Tyler to tap.
- **M29 drops not run:** airplane 15 s (iOS keeps Wi-Fi on in airplane mode on this phone) and Wi-Fi to cellular (no SIM). Tyler: close as not applicable; say why in the `device-check` skill.

## Technical (yours)

- `Persistence.open` instantiates the module twice on a restore (peak two arenas): diagnose (ADR 0065; 0051's revisit condition).
- `WorldMismatch` has no reload policy (ADR 0064).
- Reference game, never diagnosed: tile (58, 55) (wood, `collect-flow.spec.ts`) never completed a `collectN` in one observed run; `net.hashesBytesPerS` read 68.6 B/s against a 66 B/s ceiling once.
- Known, no action unless it moves (not an open item): `slow_tick_large_save` sits at 2.87-3.0 ms against the 3 ms desktop proxy (a quiet red is a regression, a loaded red is not; ADR 0063).
