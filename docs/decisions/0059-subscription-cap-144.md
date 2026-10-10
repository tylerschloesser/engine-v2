# 0059: Subscription cap 128 → 144 chunks

Status: Accepted (2026-10-10). Amends [0010](0010-rates-and-subscriptions.md) "Cap" and, by reference,
[0007](0007-world-model.md)'s line "hard cap 128 subscribed = 512 KiB of dense terrain" (now 144 = 576 KiB).
Tyler answered Q15 (`docs/plan/questions-for-tyler.md`) on 2026-10-10. Implemented by M39ai.

## Context

[0010](0010-rates-and-subscriptions.md) set a cap of 128 chunks per client. At the 256-tile view
clamp ring 1 is 121 chunks, so the cap leaves 7 for look-ahead and hysteresis, and PRE-PLAN §9 risk 3
named it tight. M31's risk-3 rule triggered (`docs/plan/31-rates-and-integrity.md` Deviations "Risk 3"):
at maximum zoom-out over dense chunks, panning back and forth over less than 64 tiles re-sent about
50 KB/s of chunks the client had just dropped, against the 48 KB/s chunk budget. The same scenario
with `WorldConfig.view.maxChunks = 144` re-enters 9 chunks, 31,403 B per 10 s (3.1 KB/s), against
505,565 B at 128 (`budgets.json` `net.zoomoutOscillateCap144ReenterBytes`): about 16x less.

## Decision

**1. The default cap is 144 chunks per client.** `subs::CAP_CHUNKS` and the `WorldConfig.view.maxChunks`
default are both 144. The cap stays configurable per game; the eviction order of 0010 is unchanged.

**2. Dense terrain at the cap is 144 x 4 KiB = 576 KiB** (edge 32), inside the client arena
([0015](0015-threads-memory-and-topology.md) §5). The client replica's cache check (`Replica::with_source`)
tracks `CAP_CHUNKS`.

## Alternatives rejected

- **Keep 128 and lower the default maximum zoom-out.** A Requirement-level change to the view; Tyler chose the cap.
- **Look-ahead only below a zoom threshold.** Does not remove the churn from hysteresis at full zoom-out.

## Consequences

- Fast pans (1-2 view-widths per second) still arrive late at any cap, as 0010 predicts; only byte
  diffing or a smaller default view for dense games helps. Revisit if the cap is raised again.
- The `zoomout/*` budgets keep their measured rows (they already measured 144 where named so).

## Sources

- `docs/plan/questions-for-tyler.md` Q15 (Tyler, 2026-10-10); `docs/plan/31-rates-and-integrity.md` Deviations.
