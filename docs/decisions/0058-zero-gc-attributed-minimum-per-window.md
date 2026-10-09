# 0058: Software-mode attributed bytes take their own two-window minimum

Status: Accepted (2026-10-09). Amends [0028](0028-zero-gc-two-measured-windows.md) §1 (which window
the software-mode `attributedBytes` is read from). Implemented in milestone M39ah.

## Context
0028 §1 runs two 600-frame windows. It takes each isolate's lower raw total, and it reads `byFn`
and the software-mode `attributedBytes` from that same window, so that a failure's printed sites
belong to the total it failed on. In software mode the assertion is on attributed bytes alone
([0029](0029-zero-gc-software-mode-attribution.md)), so the window is chosen by one quantity and
judged on another. `[gc] sim neg object sim` failed on CI three times (deferred-ledger row 170,
CI runs 37507742158, 37884536875 and 37953467887). Each time, `main` tripped as well as `sim`,
with 56 B attributed under `drive`. M39ah traced it to a one-off allocation in the `Atomics.load`
builtin (`drive > stepSimTickSync > load`), which lands in the first window only. Whenever the
first window's raw total was the lower one, that one-off decided `main`'s verdict. Locally in
software mode it failed 5 times in 6 before the change and passed 6 of 6 after it.

## Decision
**1. The attributed minimum is taken over attributed bytes.** In software mode, `measure()`
computes `attributedBytes` for each window and asserts on the lower of the two. 0028's
discriminator ("does this recur?") is applied to the quantity the assertion reads: an attributed
allocation that recurs every frame lands in both windows and passes through the minimum, and a
one-off lands in at most one.

**2. Everything else in 0028 §1 is unchanged.** The raw total, `byFn` and `windowByFn` still come
from the raw-total winner. `windowBytes` and both windows' `windowByFn` are printed with every
failure, so the discarded window stays visible.

## Alternatives rejected
- Keep 0028 §1 as written and raise `main`'s software attributed budget above 0: this widens a
  budget to pass, which 0029 forbids.
- Warm `Atomics.load` before the window: the allocation appears only while the `sim` control is
  armed, and nothing pins why. A warm-up aimed at an unexplained one-off would be guesswork.
- Choose the window by attributed bytes for everything (total and `byFn` too): this would change
  hardware-mode assertion B, which has no reason to change.

## Consequences
In software mode, a failure's printed `byFn` can come from a different window than the attributed
number. `windowByFn` holds both windows, so the sites are still on the page. A source-string test
in `gc/analyse.test.ts` pins the per-window attributed minimum. Revisit if an attributed leak is
ever found that lands in one window only (not expected for per-frame code).

## Sources
- M39ah Deviations (`docs/plan/39ah-gc-sim-neg-object-main-trip.md`), CI artefacts of runs
  37884536875 and 37953467887 (2026-10-09).
