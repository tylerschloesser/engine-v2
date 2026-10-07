# M39w: a driven round exits when every item is walked

Status: not started · After: 39v · Tyler-dependent: no

## Goal
A driven round (`--drive ios|android`) does not exit while any item has a pending judge sheet. The driver saves the screenshot, logs `shot` and `defer`, and walks on. But the process then waits for a result that only `pnpm device:walk --judge` can write, holding the Appium/WDA session and the page on the phone:
- Round `m39v-ios-attached-1` finished walking at 22:47 on 2026-10-06 and held Tyler's iPhone until 08:26 the next morning.
- Round `m39r-iphone` held it for about 3 h.

The `device-round` skill already says judge sheets "are not answered ... the walk goes on", and that the driving process "may be gone by then". The process does not match that design. When this is done, a driven round whose items are all walked or deferred ends by itself and releases the phone. Its sheets stay open in the log for `--judge`.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39j-device-driver.md` Deviations (the drive loop, judge deferral, `shot` and `defer` events, cleanup)
3. `docs/plan/39u-low-power-left-on.md` Deviations (cleanup and shutdown bounds in `auto-main.mjs`)

## Scope
1. **Exit.** In driven mode, once every walked item has a result or a `defer`, the round runs its normal shutdown (the M39u cleanup path: rotation, Low Power, airplane, session, WDA, servers) and exits 0. It prints the `humanPending` ids and the `--judge` command line. A QR (non-driven) round is unchanged, since Tyler answers sheets on the phone there.
2. **Status.** `--status` and `--wait` show such a round as `done-pending-judge` (or an existing state name that means the same), not `waiting-for-human`. `--wait` returns once the walk is over, not when the sheets are judged. Name the state in Deviations.
3. **Tests.** A unit or fake-backend test: a driven round with one judge item ends with cleanup called and the process exit path taken. It is red at base (red line pasted). A second test shows a QR round still waits.

## Non-scope
Judging itself (the orchestrator's `--judge`); any criterion; the iOS rAF limits (Q19).

## Files touched
`scripts/lib/device-walk/drive/loop.mjs`, `auto-main.mjs`, `auto-round.mjs` and the status code, their tests under `scripts/lib/`; the `device-round` skill's section 1b if a state name changes.

## Exit criteria
- [ ] The exit test and the QR test exist, pass, and the exit test was seen red (red line pasted).
- [ ] `pnpm test unit -t device-walk` green (pasted line).
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t device-walk` (targeted, foreground). No phone runs.

## Context artifacts
`.claude/skills/device-round/SKILL.md` section 1b and 2: the new end state, and that a driven round ends by itself.

## Manual device checks
None; the next driven round shows it.

## Deviations
- **State name: `done-pending-judge`** (`live.mjs` `roundState`). It holds when every unresolved walked item's newest attempt is a judge sheet with a `defer` after it, whether or not the process is alive (so it does not read `stalled` after the exit). `waitRound` returns code 0 for it. `humanPending` still lists the ids. A QR round never has a `defer`, so it is unaffected.
- **Seams.** `createAutoRound(...).walkOver(events?)`: every item has a result or is parked (`done()` is unchanged and stricter). `auto-cli.mjs` exports `walkFinished({ machine, endOnParked, timeoutMs, signal, pollMs })`; `startAutoRound` takes `o.endOnParked` and its `finished()` delegates to it. `auto-main.mjs` exports `endRound({ round, done, live, status, shutdown, log })`: sets `live.phase` (`done` | `done-pending-judge` | `stopped`), prints the status, then `judge sheets open: <ids>` and the `pnpm device:walk --judge <round> <id> pass|fail|skip [--note "..."]` line, awaits the same `shutdown()` as before (M39u path: driver stop, backend cleanup 70 s, monitor, servers), returns 0 (done or pending-judge) or 2. `autoCli` passes `endOnParked: !!o.drive`; `device-walk.mjs` still does `process.exit(code)`, so exit is 0. SIGTERM handling is untouched.
- **Tests** (`scripts/lib/device-walk-exit.test.mjs`, about 26 ms in all, no real sleeps beyond the drive loop's 10 ms poll): the exit test drives a real `startDrive` over the fake backend on a log with a judge sheet, waits with `walkFinished({endOnParked: true})`, then `endRound` calls shutdown once, sets the phase and exits 0; a status/`--wait` test; the QR test (`walkOver` false, state `waiting-for-human`, `walkFinished` without `endOnParked` does not finish). Red at base (the four source files at HEAD, the test new): `TypeError: (0 , __vite_ssr_import_4__.walkFinished) is not a function`, `expected { state: 'stalled', …(6) } to match object { state: 'done-pending-judge', …(1) }`, `TypeError: machine.walkOver is not a function`.
- `pnpm test unit -t device-walk`: `unit pass 244 tests  2.7s/3s`. Not run: full `pnpm test`, `pnpm lint` (the orchestrator is the gate).
- Skill: `.claude/skills/device-round/SKILL.md` 1b (judge sheets bullet) and 2 (state list, `done-pending-judge`).
- Not covered by a test: `autoCli` as a whole (it starts real servers); the glue is two lines (`endOnParked`, `endRound`).
