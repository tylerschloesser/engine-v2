# 0038: Persistence container additions from M22 (Formats)

Status: Accepted (2026-09-25). Amends [0005](0005-persistence-and-recovery.md) Formats.
Implemented in M22 (`docs/plan/22-persistence-log-and-snapshots.md`).

## Context

Building the snapshot and log-frame containers (`docs/plan/22-persistence-log-and-snapshots.md`
Deviations, steps 1-3 and fix round 2) surfaced three points where 0005's literal grammar could not
be implemented as written, or left a real bug reachable. Accepted ADRs are not rewritten, so the
fixes are recorded here rather than edited into 0005.

## Decision

**1. Snapshot: a `total_len` varint after `container_version`.** 0005's grammar has no way for a
block-split reader (`SnapshotReader::push`, arbitrary block boundaries) to tell "not enough bytes
buffered yet" apart from "corrupt" while decoding a compound, variable-length body. Amendment: a
varint immediately after `container_version`, giving the byte length of `identity..crc32` inclusive.
Same role as the log frame's own leading `len` varint, which already had this property.

**2. Log frame: the action payload is length-prefixed.** 0005 gives the action record's payload as
bare `seq varint | G::Action`, a self-delimiting decode that consumes "as much as it needs" from an
unverified tail. Amendment: `seq varint | write_sized(G::Action)`, matching `Store::write_canonical`'s
own convention for every other game-typed value, so `read_sized` always runs `decode_canonical` over
an exact, pre-sliced span (`.claude/rules/determinism.md`: "untrusted bytes go through
`decode_canonical`").

**3. Snapshot: `log_ref_tick: u32` added after `log_offset`.** Frames carry `tick_delta` relative to
the *previous logged frame*, not an absolute tick, but a snapshot taken after an idle gap (no frame
logged for several ticks before the snapshot) gave a replay resuming from it no way to know what that
previous frame's tick was. Fix round 1 found this by testing exactly that shape
(`replay_from_snapshot_after_idle_gap_matches_live`); seeding the reference from the snapshot's own
tick instead of the real last-logged tick reproduced the bug:

```
assertion `left == right` failed: replay from the mid-run snapshot must match the live tail
  left: [(Tick(30), 389520028661840756), (Tick(31), 389520028661840756), (Tick(60), 3586399577821007430)]
 right: [(Tick(30), 389520028661840756), (Tick(31), 5324014682923496518), (Tick(60), 8680060105247801486)]
```

Amendment: `log_ref_tick: u32`, the tick of the last frame logged before `log_offset` in that segment
(`0` = none logged yet; frame ticks start at `1`, so `0` is unambiguous). `testing::replay`'s
snapshot-based path seeds its tick reference from this field instead of assuming it equals the
restored `Sim`'s own tick. Opening a segment (`sim_segment_header`) resets the writer's same
reference (to `0` for genesis, or the segment's `base_tick` otherwise), for the same reason,
preemptively: a segment's first frame has nothing preceding it in that segment.

## Consequences

- `container_version` stays `1`: no build has shipped against the old shape, so this is a format
  addition, not a version bump.
- `SnapshotWriter` currently encodes the whole snapshot into one buffer before `sim_snapshot_next`
  drains it in blocks, rather than a true incremental per-section cursor; that is an implementation
  choice behind an unchanged wire format and ABI, not a format deviation, and M36 owns measuring
  whether the arena-peak cost of that choice needs a true incremental encode (Planning decisions 2,
  `docs/plan/22-persistence-log-and-snapshots.md`).

## Sources

- `docs/plan/22-persistence-log-and-snapshots.md` Deviations: "Snapshot format deviations from 0005's
  literal grammar" (points 1-2), "Fix round 2: the fix: `log_ref_tick` in the snapshot container"
  (point 3, including the reproduction pasted above).
