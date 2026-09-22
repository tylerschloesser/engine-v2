# M15d: The client's per-frame clock read, off the main-thread hot path

Status: not started · After: 15b · Tyler-dependent: no (acts on `questions-for-tyler.md` Q13's recommended default)

Written by the orchestrator at M15b's gate. This is M13b's fix applied to the isolate M13b did not
touch, and it is now blocking rather than cosmetic: see "Why now" below.

## Goal
`client.ts` stops reading the wall clock on the per-frame path of the `main` isolate. Every zero-GC
page's `main` reading drops by the ~11.96 B/frame that read currently costs in the interpreter tier,
`gc-sim-paced` stops failing intermittently, and the budgets that were sized around the old cost are
**re-derived downward** rather than left slack.

## Why now
M13b recorded this cost and deliberately left it: "`client.ts`'s `now()` costs ~11.94 B/frame on
`main` in the interpreter tier -- the same defect class M13b fixed on the sim worker, quietly
absorbed by every page's `main` budget since 0028's re-derivation, and a candidate milestone of its
own." Three measurements since then have turned "candidate" into "blocking":
- At M15's gate, `[gc] sim-paced clean` and `[gc] sim-paced neg object sim` failed **1 run in 6
  under `--load 10`**, with `main` raw ~33.5 against its hardware budget of 30 and **11.96 B/frame
  attributed to `now@client-*.js`**. Confirmed pre-existing: the same rate on M15's base commit
  `ebea2a3`, and M15 changed zero TS/JS.
- At M15b's gate, with the suite grown from 98 to 103 tests, the same failure reached **7 runs in 15
  with no injected load at all** (5 of them `sim-paced clean`; no `connected*` test ever failed).
- M15c adds another zero-GC page, which raises the concurrency that provokes it again.

A gate that is red roughly half the time cannot certify anything, and **the remedy must not be a
budget**: ADR 0029 makes a budget that stops a negative control tripping the exact failure mode to
avoid, and `main`'s figure was deliberately held at 30 by M13b for that reason.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0030-sim-host-resync-based-pacing.md` (the same defect solved on the sim worker:
   what worked, and the two measured rejections that must not be re-litigated)
3. `docs/decisions/0016-zero-gc-definition.md` (§1, §3) and `docs/decisions/0028-zero-gc-two-measured-windows.md`
   (the two-window rule and how every `main` budget was re-derived)
4. `docs/decisions/0029-zero-gc-software-mode-attribution.md` (attribution nests inside the root;
   never widen a root or relax a budget to make a control behave)

Also read `docs/plan/13b-tick-timing-allocation.md`'s **Deviations** (the measured numbers and the
seam shapes of the sim-side fix). Rules: `.claude/rules/hot-paths.md`.

## Scope
- Find **every** wall-clock read on the `main` isolate's per-frame path in `packages/engine/src/`
  (`client.ts` is the known one; do not assume it is the only one -- attribute first, then fix).
- Remove them from the per-frame path. 0030's sim-side answer was to read once every `RESYNC_TICKS`
  and use integer arithmetic between reads; the client's frame path has a different shape (it is
  driven by rAF or by `stepFrame`, and a timestamp is often already in hand), so **pick the shape
  that fits and say why in Deviations**. If a rAF timestamp argument is already available, prefer it
  to a fresh `performance.now()` call -- but *measure* that it does not box in the same way rather
  than assuming.
- **Re-derive downward** every zero-GC budget that was sized to absorb this cost, the way ADR 0028
  re-derived them after the last instrument correction. A fix that leaves the old slack in place
  hides the next regression of the same kind.
- Prove the fix under the forced-interpreter condition, not only the optimised one:
  `--js-flags=--no-opt --no-sparkplug` on the `gc` project, which is how M13b's equivalent was
  proven (and how the original defect was made reproducible on demand).

## Non-scope
The sim worker (M13b, done). The **other** open intermittent red -- `sim neg burst main`/`burst sim`
on `gc-sim`, where `main` attributes 28 against a software budget of 0 -- is a different phenomenon
whose leading hypothesis is the M06b sibling-isolate nudge; do not conflate the two, and do not
"fix" it here. If this milestone's fix happens to change that page's numbers, report it as a
measurement, do not chase it.

## Files, packages and crates touched
`packages/engine/src` (`client.ts` and whatever else attribution names), `packages/engine/budgets.json`.

## Seams
**Provides:** no new public API expected. If the fix changes an `engine/test` or `ClientOptions`
shape, name it exactly in Deviations -- M15c and M16 both build on this file.
**Consumes:** M04 zero-GC harness, `pnpm gc <software|flat|reliability>`, the `gc-test` skill;
M13b's `gc-sim-paced` page; ADR 0028's two-window assertion.

## Planning decisions
- **Two mechanisms are already measured and rejected; do not re-litigate them** (0030): a
  WASM-imported clock still allocated 7.98 B/tick, because its glue is ordinary JS; and
  `Math.trunc()` does not help, because the box happens at the native call's return boundary, not at
  the arithmetic.
- **A budget may go down in this milestone, never up.** If some page's `main` cannot meet a
  re-derived figure, that is a finding to report, not a number to raise.
- **The negative controls must still trip.** M13b's own trap is the precedent: a margin wide enough
  to swallow the `object` control's 16 B/frame made the control measure 0/8 trips, and the
  implementer caught it and narrowed the margin instead. Verify controls still trip after every
  budget change.

## Order of work
1. Attribute: `windowByFn` on `gc-sim-paced` and the other pages, forced-interpreter, to list every
   per-frame clock read on `main` by function and byte cost. 2. Fix. 3. Re-derive budgets downward,
   verifying controls still trip. 4. Repeat evidence.

## Tests added
No new page. The evidence is: `gc-sim-paced`'s `main` reading before and after (optimised and
forced-interpreter); `byFn` no longer naming any `now@`-shaped frame on `main`; every existing
zero-GC page still green with its re-derived budget; every negative control still tripping.

## Exit criteria
- [ ] Attribution table: every per-frame `main` clock read, its function and its B/frame, before and after.
- [ ] `byFn` for `main` on `gc-sim-paced` names no clock read after the fix, forced-interpreter included.
- [ ] Budgets re-derived downward where the old figure absorbed this cost, with each new number's derivation stated.
- [ ] Every zero-GC negative control still trips (paste the trip counts).
- [ ] `node scripts/repeat.mjs browser 15` is **15/15** with no injected load, and the `sim-paced` failures are gone.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm gc software` · `pnpm gc flat` · `pnpm test browser -t sim-paced` · `node scripts/repeat.mjs browser 15` · `pnpm lint`.

## Budgets
`budgets.json` `gc.pages.*.isolates.main.bytesPerFrame` rows, revised downward. No row goes up.

## Context artifacts
If the fix establishes a rule for clock access on the client frame path, state it in
`packages/engine/src/CLAUDE.md` in one or two lines.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
