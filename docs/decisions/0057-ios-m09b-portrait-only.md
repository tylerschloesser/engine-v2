# 0057: M09b-fill-rate measures portrait only on iOS

Status: Accepted (2026-10-07). Amends [0056](0056-ios-pacing-and-tick-bar.md) §1 (what M09b asserts on iOS). Implemented by M39ac. Tyler agreed on 2026-10-07.

## Context

[0056](0056-ios-pacing-and-tick-bar.md) §2 judges iOS frame pacing only from driverless QR runs. M09b-fill-rate measures one 60 s window per orientation, with a "Rotate the phone" prompt between them, on every ladder rung. A page cannot rotate an iPhone (Safari has no `screen.orientation.lock`), and without a driver session a person has to turn the phone, up to four times in a ladder.

## Decision

**1. On iOS, M09b-fill-rate measures one portrait window per rung and asks for no rotation.** iOS is decided at the page from the user agent (iPhone, iPad, iPod), the same rule as `verdictContext`. A phone that starts in landscape gets one prompt, for portrait. Android and desktop measure both orientations, as before.

**2. The criteria follow.** `windows_measured` counts portrait windows on iOS and needs 1 (distinct orientations, 2, elsewhere); the collector measures nothing else there, and the record carries `portraitOnly`. All other M09b criteria are unchanged. M18-fill-rate-with-anchors is unchanged.

**3. Why.** Landscape has the same pixel count as portrait, so it adds nothing to the fill-rate question on a phone. Rotation on the driverless leg needs a person. Resize handling is covered by M11-gestures' rotation criterion (`rotation_keeps_centre`).

## Alternatives rejected

- **Keep both windows:** costs Tyler up to four turns per ladder for no extra evidence.
- **Rotate through the driver:** the driverless leg is the only one 0056 §2 judges.

## Consequences

- A landscape-only fill-rate regression on iOS is not caught by M09b. Revisit if one is seen on a device.

## Sources

- `docs/plan/39ac-ios-fill-rate-portrait-only.md`; [0056](0056-ios-pacing-and-tick-bar.md).
