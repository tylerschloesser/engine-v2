# crates/engine/src/persist

Write-side containers for 0005 (persistence): `Identity`, `SegmentHeader`, the log frame
writer/reader, and the streaming snapshot writer/reader. Loading a stored world, `node:fs`, and
restore-side/`sim_seal_frame`/`sim_snapshot_*` ABI wiring: `docs/plan/22b-...md` and
`docs/plan/22-...md` steps 4-6.

**Field order here is owned by 0005 Formats, not by this crate.** A byte-shape change invalidates
every checked-in golden this module blesses (`persist_frame_golden_bytes`,
`persist_snapshot_golden_bytes`, `fx-persist`'s recorded log + checkpoints) and bumps
`container_version` (`snapshot.rs`); regenerate only by the explicit `GOLDEN_BLESS=1` command and
review the diff like any other golden change.

**Never iterate an unordered container here** (`.claude/rules/determinism.md`): every writer reads
`Store`'s own ordered accessors; a new section goes only where 0005 (or this module's own recorded
Deviation) places it.

Untrusted bytes (anything read back from storage) go through `decode_canonical`
(`persist::read_sized`), never plain `decode`.

Restore/replay drivers (`host::Host::sim_restore_*`/`sim_replay_*`, docs/plan/
22b-persistence-load-and-fs.md) live in `host/mod.rs`, not here: this module stays the container
level. Replay is single-pass over each decoded frame (Planning decisions 4's own "scan pass that
collects `Skip` targets" is not built -- the set is always empty until M24 gives `Skip` real
meaning, at which point that pass, and this line, need revisiting).
