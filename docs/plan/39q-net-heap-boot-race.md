# M39q: M29-net-heap waits for the page, and an empty window can't pass

Status: not started · After: 39p · Tyler-dependent: no

## Goal
Finding 6 of the driven rounds: M29-net-heap fails in every driven round with `reloads: null` while `hitch_gaps_over_25ms` reads 0. M39j's note ("the `mp.html` adapter is missing") was wrong. A read-only diagnosis (2026-10-06) found:
- `mp.ts` defines `check.act.paint` and `linkLog`, but assigns `check.act` and `check.ready` only at the foot of the page, after `await client.ready`.
- `MP.netheap` (`scripts/lib/device-walk/agent/collect-life.js`, about line 570) is the only collector that goes straight to `measureWindow` without `ready(item)` and without waiting for `link === 'online'` (compare `MP.drops`).
- Over the tunnel the agent attaches before boot finishes. The Pixel and `ios-redo` rounds threw on `check().act` undefined; `ios-full` threw `engine: dispatch before ready`.
- The thrown error became `data={error}`, so `reloads` arrived null. The hitch criterion read 0 from a window that never ran: **a criterion that passes on no measurement.**

When this is done the collector waits for the page and the link, and a run with no measured window can't pass any criterion. A loopback test makes the race fail deterministically.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39f-device-auto-runner.md` Deviations (collectors, `measureWindow`, criteria and `nullIs`)
3. `docs/plan/39n-two-devices-join.md` Deviations (the `why` shape on a failed join, and the late-`check.js` walk-ref test: the precedent for a deterministic race test)

## Scope
1. `MP.netheap` waits for `ready(item)` and then `link === 'online'`, bounded by the item's timeout. If either times out it returns `{ ready: false, why }` (the M39n `why` shape), never a hard-coded `reloads: 0`.
2. **Empty windows.** When a measuring window did not run or collected no frames, every criterion computed from it is `null` (and so fails or goes to the judge per its `nullIs`), never 0. Check this in `checks.mjs` for M29-net-heap's `hitch_gaps_over_25ms` and `reloads`, and grep the other collectors for the same pattern: a reading defaulted to 0 when nothing was measured. List each one checked in Deviations and fix any you find.
3. **Test.** A slow-tier loopback test (extend `walk-life.spec.ts`'s M29-net-heap case or add one beside it) where the page's boot is delayed past the agent's attach (`?genDelay=` if it delays `client.ready`, otherwise a test-only `page.route` delay as in M39n). It is red on the old collector (an error, `reloads` null) and green on the new. A unit test in `scripts/lib/` checks that a result with no window yields null criteria, not a pass.

## Non-scope
`mp.ts` (unchanged unless the test shows the page itself is wrong); the `pagehide` interruption that arrives after a result (noted by the diagnosis, a separate item); the 10-minute window length.

## Files touched
`scripts/lib/device-walk/agent/collect-life.js`, `scripts/lib/device-walk/checks.mjs`, their tests under `scripts/lib/`, `packages/engine/tests/browser/walk-life.spec.ts` (and `support/walk-rig.ts` if it needs a page-query override).

## Exit criteria
- [ ] The race test and the unit test exist, pass, and were seen red (red lines pasted).
- [ ] The empty-window audit is listed in Deviations.
- [ ] `pnpm test:slow browser -t walk-life` green (pasted line); no golden, budget or baseline changed.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t device-walk` · `pnpm test:slow browser -t walk-life` (targeted, foreground).

## Manual device checks
After landing, the orchestrator runs M29-net-heap driven on the Pixel (10 min) and on the iPhone when its passcode is off.

## Deviations
(filled in during Phase 3)
