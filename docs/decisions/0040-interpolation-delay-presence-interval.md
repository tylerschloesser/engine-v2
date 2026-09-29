# 0040: The interpolation delay is sized from the presence sample interval

Status: Accepted (2026-09-29). Amends [0010](0010-rates-and-subscriptions.md) Rates table, row
"Interpolation delay". Implemented in M30 (`docs/plan/30-interpolation.md`).

## Context

[0010](0010-rates-and-subscriptions.md) writes the delay as `max(2 x frame interval, frame interval
+ p95 inter-arrival jitter)`, initial 150 ms, floor 100 ms, cap 400 ms, at most 10% time dilation.
Its "frame interval" is the tick interval (50 ms at 20 Hz). But presence samples travel at up to 10 Hz
(0010, uplink row), so a remote's samples are 100 ms apart, twice the interval the formula assumes.
M30 measured `interpolation/extrapolation_ratio` at the median network profile (RTT 80 ms, jitter
20 ms, fixed seed): 0.607 of remote-player frames extrapolated; 0.556 at zero jitter. The cause is
structural, not jitter: a 100 ms floor is one sample interval, so the newest bracketing sample is
missing on most frames. 0010 sized the delay from Fiedler's rule (send interval plus jitter) but took
the wrong send interval for this stream. The brief's planning decision (0024 section 15's rule)
required an ADR rather than silent tuning. `docs/spec/sync.md` leaves the delay open.

## Decision

**1. The interval term is the presence sample interval.** `max(2 x pi, pi + p95 inter-arrival
jitter)` with `pi` = 100 ms (10 Hz, 0010).

**2. Constants.** Floor 200 ms (`2 x pi`), initial 250 ms (floor plus one tick, the same relation
150/100 had), cap 400 ms (unchanged), dilation limit 10% (unchanged), never stepped.

**3. Acceptance.** `interpolation/extrapolation_ratio` asserts at most 0.2 at the median profile.

## Alternatives rejected

- **Raise the send rate to 20 Hz:** doubles presence bytes (0010's worked number) for smoothness
  only; 0010 already rejected fixed rates that fight the tick.
- **Extrapolate more (raise the 250 ms cap of 0012):** hides the gap with guessed positions that
  visibly rubber-band on turns.
- **Keep 0010 and accept 0.6:** most frames would be extrapolated at the median network.

## Consequences

About 100 ms more display latency for remote players (0.2-0.25 s total at the median). Own avatar,
prediction and host tick timing are unaffected. Revisit if a game raises the presence rate: `pi`
should then follow the configured rate.

## Sources

Measured in M30 step 4 (Deviations of `docs/plan/30-interpolation.md`, 2026-09-29); 0010, 0012.
