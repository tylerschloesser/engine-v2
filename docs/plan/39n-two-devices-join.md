# M39n: M34-two-devices joins on the phones, and a failed join says why

Status: not started · After: 39m · Tyler-dependent: no

## Goal
Finding 4b of the driven rounds: M34-two-devices never joins through the tunnel on either phone. A read-only diagnosis (2026-10-06) found that the bot and the phone use the same code path in both M34 items (`bot.mjs` `join()`, `collect-ref.js` `joined()`), so the item is not the difference. The pattern is the *first load of the bench page from the tunnel origin*: across 5 rounds, the first reference-bench item returns `{ready:false, errors:[]}` after about 120 s with no diagnostics, and a second load of the same origin joins in 1.9 s. The likely mechanism (a guess) is a cold quick tunnel serving a worker or wasm without COEP while its name warms up; `m39j-ios-redo` logged "worker script blocked: is COEP set on every path?" on a first tunnel load. Separately, in `m39j-ios-redo` the *bot* also failed on loopback ("the bot never came online"). That points at the server or the `/ws` proxy in that round, perhaps an orphan `reference-server` on the ws port (finding 15). And `botView.sawPhone` turns true 1-3 s after the bot joins, before the phone page has loaded, in every run: `bot_sees_phone` is probably a false positive, cause unknown.

When this is done a failed join reports which condition failed and why, the tunnel is warmed and COEP is checked before an attempt opens, `bot_sees_phone` can't be satisfied by anything but the phone, and the item joins on both phones.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39j-device-driver.md` Deviations (drivers, tunnels, `reapOrphans`, findings 11 and 15)
3. `docs/plan/39f-device-auto-runner.md` Deviations (`bot.mjs`, `collect-ref.js`, servers)

## Order of work
1. **Diagnostics.** On timeout, `collect-ref.js` `joined()` returns `{ready:false, why:{ready, link, ui_seen, errors, url, readyState, failedResources (first 10)}}`, and the bot's `join()` puts `{phase:'failed', error, diag:{url, console tail, readings, server log tail}}` in its reading. `device-serve` keeps the server's log tail available. Test: a fake page whose `__check.ready` stays false yields `why.ready === false`.
2. **Ghost remote.** Settle the `sawPhone` false positive. Record roster ids (with `me`) and remote circle positions in `botView`, run the M34 two-devices walk-ref spec on loopback once, and name what the bot counts. Then require a roster id other than the bot's own, and a circle that is not the bot's. Test: a fake view where the only remote is the bot's own gives `sawPhone` false. Red line pasted.
3. **Warm and preflight.** Before the first attempt of a variant served through a tunnel, fetch `/`, the worker script and the `.wasm` from the Mac through the tunnel until all carry COOP/COEP (bounded, reported). Check that the server answers a ws handshake on its port before the bot starts. `reapOrphans` also reaps orphaned `reference-server` listeners (parent 1, this repo's binary), keeping its rule of never touching a live tool's server. If `joined()` fails once, the phone page is reloaded once before the attempt fails. Tests use fake fetchers and a fake process list.
4. **Re-measure.** Report the `why` of any failure that is left in Deviations. Don't run the phones: the orchestrator does that after acceptance.

## Non-scope
Remote motion and fade (M39l), `mp.html`'s `__check.act` (finding 6), the engine's join path unless step 1 or 2 shows an engine defect (stop and report).

## Files touched
`scripts/lib/device-walk/{bot.mjs,agent/collect-ref.js,servers.mjs,spawn-serve.mjs,auto-round.mjs}`, `scripts/device-serve.mjs`, their tests under `scripts/lib/`, `games/reference/src/check.ts` (botView fields), `packages/engine/tests/browser/walk-ref.spec.ts`.

## Exit criteria
- [ ] Step 1-3 tests exist, pass, and each was seen red (red lines in Deviations).
- [ ] The ghost-remote cause is named in Deviations.
- [ ] `pnpm test:slow browser -t walk-ref` green (pasted line); no golden, budget or baseline changed.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t device-walk` · `pnpm test:slow browser -t walk-ref` (targeted, foreground).

## Manual device checks
After landing, the orchestrator runs M34-two-devices driven on both phones.

## Deviations
(filled in during Phase 3)
