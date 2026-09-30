# M30d: Redials after a pre-`Welcome` drop hear nothing

Status: not started · After: 31 · Tyler-dependent: no

Written by the orchestrator at the start of the session after M31 (2026-09-29). Same shape as M30c: an intermittent red on one test, so first find which side goes silent, then fix the function that does it. No test is weakened.

## Goal
`[chromium] mp/hello-resent-after-pre-welcome-drop` (M30c's regression test, `packages/engine/tests/browser/mp.spec.ts`) passes in a bounded repeat quiet and under load. Its intermittent failure has a named cause in a named function, with a fix whose revert makes a test fail.

## The evidence (orchestrator)
- Failed on CI run 36652166451 (`M30c done`) and once locally in a full `browser` run at load 11-15 (M31 steps 3-4). It passed in run 36650050838 and passes alone (~2.6 s).
- M30c's failure-only diagnostic (`mpDiagnostics(page)`) printed `last link state=reconnecting log(newest first)=["silence:-","open:-", … ×7, "close:1006","open:-"]`. The forced drop happens (`close:1006`), and then **every** redial opens and hears nothing until the dead-peer timeout (`silence`). No `Welcome`, no `close:4002`/`4004`. So either the resent `Hello` never leaves the page or never reaches the host, or the host receives it and never answers.
- The path was changed by M30c's fixes 1-4 (read M30c's Deviations § C): `helloSent` in `worker/client-net.ts`, `dialSeq` → `CB_LINK_GEN` in `worker/net.ts`, the retry chain in `client.ts`, and the `conns[entry.conn] === entry.connection` check in `server.ts`'s `pumpHandshakes`. Also on the path: `startTestServer({ dropFirstHello: true })` in `tests/browser/support/test-server.ts`.
- **Guesses only, not findings:** (a) the resend is keyed on a generation the page reads before the new socket's `open` is published, so a load-dependent ordering skips it on every later dial; (b) the `Hello` goes onto the uplink ring and the net worker drains it to the dead socket or drops it on a link rebuild; (c) the host's handshake queue keeps a stale entry for the reused `ConnId` and ignores the new connection's `Hello` (fix 4 covers one ordering of this, not necessarily all); (d) `dropFirstHello` in the test server kills more than the first socket under some ordering. Rule them in or out with a measurement, not by reading.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/30c-ci-reds-after-m30.md` (Deviations § C: fixes 1-4, the test, the diagnostic)
3. `docs/plan/29-net-worker-and-reference-server.md` (Deviations: the ws transport, `mp.html`, net worker, link states)
Rules that apply: `.claude/rules/hot-paths.md` (the net worker's per-message path).

## Scope
1. **Reproduce.** Run the one test in a bounded foreground loop (`for i in $(seq 1 N); do timeout 60 pnpm test browser -t hello-resent-after-pre-welcome-drop || break; done`), quiet and alongside `node scripts/repeat.mjs` style load (`--load` burners are self-terminating only inside `repeat.mjs`; if you start your own load, bound it with `timeout` and check `pgrep -x yes` is 0 after). If the single test won't fail in ~40 runs under load, reproduce with the full `browser` suite in batches of 15 via `node scripts/repeat.mjs browser 15 --load 10`, copying `test-results/browser` aside on each failure (the runner keeps only the last).
2. **Attribute.** Extend the failure-only diagnostic so a failure says, per dial: the `CB_LINK_GEN`/`dialSeq` at `open`, whether and when the page sent `Hello` on that dial, and whether the host received a `Hello` on the matching server-side socket and what `pumpHandshakes` did with it (queued, attached, skipped as stale, rejected). Host-side facts come from the test server (Node side) and must print only on failure. Get one failing run with this output before you change behaviour.
3. **Fix** the function the diagnostic names. Then add or tighten a test that fails with the fix reverted (inject-fail-revert; paste both lines). If the cause is in the test server rather than the engine, fix it there and say so.
4. **Repeat:** the single test 30 runs quiet and 30 under load (0 failures, 0 hangs); plus `node scripts/repeat.mjs browser 15 --load 10` once (report failures and whether any is this test).

## Non-scope
Other `mp/*` tests' timing, the ws harness (`net-harness.ts`), Chrome for Testing `EXC_GUARD` crashes (a machine issue; ledger), any budget in `budgets.json`, `SimHost.accept`'s `sim_connect` fallback.

## Files, packages and crates touched
`packages/engine` only: likely some of `src/worker/client-net.ts`, `src/worker/net.ts`, `src/worker/client.ts`, `src/server.ts`, `tests/browser/mp.spec.ts`, `tests/browser/support/test-server.ts`. No Rust change is expected; if one is needed, report first.

## Seams
**Provides:** none new. `createLink`'s `onUp(conn, gen)` and `startTestServer`'s options stay compatible (a new optional field is fine).
**Consumes:** M29 net worker and ws transport; M30c fixes 1-4 and `mpDiagnostics`.

## Tests added
The test from Scope 3 (a new test or a tightened assertion in `mp.spec.ts`), each under 3 s: the `browser` suite has no headroom (38-39 s of 48 s quiet).

## Exit criteria
- [ ] A failing run's diagnostic, pasted in Deviations, names the side and function that went silent.
- [ ] The fix is in that function; reverting it makes a named test fail (both result lines pasted).
- [ ] The single test passes 30/30 quiet and 30/30 under load, no hangs; one `repeat.mjs browser 15 --load 10` batch reported.
- [ ] No timeout, retry count, deadline or budget was raised to get there.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t hello-resent-after-pre-welcome-drop` · `pnpm test browser -t mp/` · the loops in Scope 1 and 4.

## Budgets
`browser` suite wall time (ADR 0036): no new test over 3 s.

## Context artifacts
None, unless the diagnostic's reading needs a line in `packages/engine/CLAUDE.md`.

## Manual device checks
None.

## Deviations
(filled in during Phase 3)
