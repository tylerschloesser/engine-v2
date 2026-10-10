# crates/engine/src/persist

Write-side containers for 0005 (persistence): `Identity`, `SegmentHeader`, the log frame
writer/reader, and the streaming snapshot writer/reader. Loading a stored world, `node:fs`, and
restore-side/`sim_seal_frame`/`sim_snapshot_*` ABI wiring: `M22b-...md` and
`M22-...md` steps 4-6.

**Field order here is owned by 0005 Formats, not by this crate.** A byte-shape change invalidates
every checked-in golden this module blesses (`persist_frame_golden_bytes`,
`persist_snapshot_golden_bytes`, `fx-persist`'s recorded log + checkpoints) and bumps
`container_version` (`snapshot.rs`); regenerate only by the explicit `GOLDEN_BLESS=1` command and
review the diff like any other golden change. The `Store` canonical shape has a second reader: `migrate.rs`'s `OldStore::decode` re-implements `Store::write_canonical`'s reader side byte for byte (new code cannot name old types), so change `write_canonical`/`decode` and `OldStore::decode` together or old saves silently misparse.

**Never iterate an unordered container here** (`.claude/rules/determinism.md`): every writer reads
`Store`'s own ordered accessors; a new section goes only where 0005 (or a later ADR) places it.

Untrusted bytes (anything read back from storage) go through `decode_canonical`
(`persist::read_sized`), never plain `decode`.

The upgrade path's own mismatch matrix (`Same`/`Direct`/`NeedsMigrate`/`Incompatible`) lives in
`Identity::compare` (`identity.rs`), not here or in `crate::migrate`. `SaveIncompatible` performs
no write at all (0005): every stored byte stays untouched on that path (M24b).

Restore/replay drivers (`host::Host::sim_restore_*`/`sim_replay_*`/`sim_replay_scan_*`/
`sim_log_skip`, M22b) live in `host/mod.rs`, not here: this module stays the container
level. Replay is two-pass (M24: `sim_replay_scan_begin/push/
end` decode a segment tail once, purely to collect `Skip { segment, offset }` targets (a `Skip`'s
own target typically lives in an *earlier* frame than the `Skip` record itself), before
`sim_replay_begin/push/end`'s own real apply pass -- kept as a genuinely separate reader/pass
rather than folded into the apply pass, so `sim_replay_push`'s pre-existing "apply each frame as
soon as it's decoded" contract (`engine/test`'s `replayWorld`/`runHeavy` drive it tick-by-tick)
stays intact. `persist::progress::{Phase, ProgressCursor}` (`RegionId::Progress`) is written by
`Host<G>` around this and every other risky call, not by this module.
