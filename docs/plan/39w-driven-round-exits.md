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
(filled in during Phase 3)
