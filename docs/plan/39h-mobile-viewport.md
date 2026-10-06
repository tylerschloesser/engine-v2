# M39h: Mobile viewport from the page-CSS helper

Status: not started · After: 39g · Tyler-dependent: no (M09b and M11 re-run on the phones follows)

## Goal
The 2026-10-05 device-driver spikes (`spikes/device-driver-android/RESULT.md`, `spikes/device-driver-ios/RESULT.md`) found that `device.html` lays out at a 980 CSS px width on both phones: Pixel 5 canvas 1960x3999 px at about 40 fps, iPhone `visualViewport.scale` 0.398, screenshots a black page with a green block. Every fixture page lacks a viewport `<meta>`, and the engine's page-CSS helper (`packages/engine/src/input/page-css.ts`), which inserts one when absent, writes only `viewport-fit=cover`. With no `width=device-width` a mobile browser uses its desktop layout width. So every phone reading from a fixture page so far (M09b fill-rate's GPU p95 of about 14 ms on the iPhone, M11) was taken at the wrong size. When this is done a page set up by the helper lays out at the device width on a phone, with `viewport-fit=cover` kept.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0019-camera-input-and-overlay.md` §3 (the page-CSS helper: `viewport-fit=cover`, pull-to-refresh, `100dvh`)
3. `packages/engine/src/input/page-css.ts` and its test (`grep -rln page-css packages/engine/src`)

## Scope
1. The helper's inserted meta is `width=device-width, initial-scale=1, viewport-fit=cover`. An existing meta without `width=` gets `width=device-width` added (and `initial-scale=1` if absent); an existing `width=` is left alone (a game's own choice); `viewport-fit=cover` is still added when missing. Do not add `user-scalable=no` or `maximum-scale` (0019 §3 stops page zoom with `touch-action` and `preventDefault`, not by disabling accessibility zoom); if you believe 0019 says otherwise, quote it in Deviations.
2. Check which fixture pages served to phones (`docs/plan/device-checks.md` *Open* lines: `device.html`, `slice.html`, `world.html`, `mp.html`, `determinism.html`, `worldgen-bench.html`, `opfs-latency.html`, the harness page) actually call the helper. A page that does not call it gets the static `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` in its HTML. A page that does call it gets the static tag too, because a meta inserted after first layout may not take effect on every browser. Say which in Deviations.
3. The release bundle and the reference game are untouched (`games/reference/index.html` already has its own tag).

## Non-scope
Renderer, scale caps, budgets, any device-walk tooling, the desktop-only test pages (a viewport meta is ignored by desktop Chromium; adding it there is allowed but not required).

## Tests added
- The helper's unit test gains cases: no meta, which inserts the full content; a meta with only `viewport-fit=cover`, which gets width and scale added; a meta with `width=500`, which keeps 500. Each is seen red against the old helper (inject-fail-revert, red line pasted in the report).
- A browser-free check (unit suite) that every page named in scope 2 carries a viewport meta with `width=device-width`, red if one is removed.

## Exit criteria
- [ ] The helper tests and the page check exist, pass, and each was seen red.
- [ ] No golden, budget or baseline changed. Desktop Chromium ignores the meta, so a moved desktop number is a finding to report, not to absorb.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t page` (targeted, foreground).

## Manual device checks
Re-run M09b-fill-rate and M11-gestures on both phones once the device driver exists; the orchestrator can confirm the layout width now through the spikes' safaridriver / CDP scripts (`window.innerWidth` ≈ 390 on the iPhone, ≈ 393 on the Pixel).

## Deviations
(filled in during Phase 3)
