//! Resume hint: building one from a client's held chunks (`build_resume_hint`) and diffing one
//! against a host's own per-chunk versions and new subscription (`diff_resume_hint`) --
//! docs/plan/28b-reconnect-and-lifecycle.md steps 1-2, 0013-sessions-and-integrity.md "Reconnect".
//! Pure, native-tested functions only: wiring `build_resume_hint`'s output into a real
//! `client_hello`, and `diff_resume_hint`'s output into a live `sim_attach`/`build_frame` call
//! (the `ChunkKeeps` section, `SectionId::ChunkKeeps` = 11, actually going out on the wire), is
//! step 3's own scope (this milestone's Non-scope: "step 3's pending-resend/reconcile path ...
//! read this shape").
//!
//! **`ChunkKeeps`'s body is exactly `wire::coordlist`'s coordinate-list encoding** (the same one
//! `ChunkEnterPristine`/`ChunkLeaves` already use, `wire/coordlist.rs`'s own module doc comment:
//! "sections 4 ..., 6 ..., 11 (ChunkKeeps)") -- a "keep" carries no version of its own (0013: "a
//! 3-byte 'keep'"; the client already holds the version it hinted, and the diff below only ever
//! keeps a chunk whose hinted version matches the host's, so there is nothing left to say beyond
//! the coordinate itself). `golden_keep_entries` (below) blesses that exact shape.

use crate::world::ChunkCoord;

use super::{MAX_RESUME_CHUNKS, ResumeChunkHint, ResumeHint};

/// Builds a [`ResumeHint`] from a client's held chunks and their per-chunk versions, relative to
/// `camera_center` (0013: "chunk coords relative to the view centre") -- bounded to
/// [`MAX_RESUME_CHUNKS`] entries (0013 "bounded there"), nearest-to-centre first (by squared
/// distance, ties broken by `(y, x)` for a deterministic order regardless of `held`'s own
/// iteration order -- `.claude/rules/determinism.md`: no `HashMap`) so a truncation drops the
/// least useful hints first. A chunk whose offset from `camera_center` does not fit an `i16` on
/// either axis is simply omitted (Planning decisions: "chunks outside the `i16` range ... are
/// simply omitted and arrive as snapshots") -- correct by construction, since such a chunk can
/// never be represented in [`ResumeChunkHint::dx`]/`dy` at all.
pub fn build_resume_hint(
    held: impl Iterator<Item = (ChunkCoord, u32)>,
    camera_center: ChunkCoord,
    epoch: u32,
    last_tick: u32,
) -> ResumeHint {
    let mut candidates: Vec<(i64, ChunkCoord, u32)> = held
        .filter_map(|(coord, version)| {
            let dx = coord.x.wrapping_sub(camera_center.x);
            let dy = coord.y.wrapping_sub(camera_center.y);
            if dx < i32::from(i16::MIN) || dx > i32::from(i16::MAX) {
                return None;
            }
            if dy < i32::from(i16::MIN) || dy > i32::from(i16::MAX) {
                return None;
            }
            let dist = i64::from(dx) * i64::from(dx) + i64::from(dy) * i64::from(dy);
            Some((dist, coord, version))
        })
        .collect();
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then((a.1.y, a.1.x).cmp(&(b.1.y, b.1.x))));
    candidates.truncate(MAX_RESUME_CHUNKS);
    let chunks = candidates
        .into_iter()
        .map(|(_, coord, version)| ResumeChunkHint {
            dx: (coord.x.wrapping_sub(camera_center.x)) as i16,
            dy: (coord.y.wrapping_sub(camera_center.y)) as i16,
            version,
        })
        .collect();
    ResumeHint {
        epoch,
        last_tick,
        chunks,
    }
}

/// The host's own classification of every chunk in the new subscription, plus whatever the hint
/// held but the new subscription no longer wants.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct HintDiff {
    /// Wanted, and the hint's own claimed version for it matches the host's: no bytes needed
    /// beyond a `ChunkKeeps` coordinate-list entry.
    pub keep: Vec<ChunkCoord>,
    /// Wanted, but not validly hinted (absent from the hint, a stale version, or the hint was
    /// ignored outright -- foreign epoch): needs a full `ChunkSnapshots` entry.
    pub snapshot: Vec<ChunkCoord>,
    /// Held per the hint, but not in the new subscription at all: needs a `ChunkLeaves` entry.
    pub leave: Vec<ChunkCoord>,
}

/// Diffs `hint` against `current_epoch`, `camera_center` and the new subscription's own `wanted`
/// chunk list (0013 Reconnect): equal version -> keep; different or absent -> snapshot; held but
/// unwanted -> leave. `Global`/`OwnPlayer` are always resent regardless (0013) -- not this
/// function's concern, since it only ever classifies chunks.
///
/// **A hint from another epoch than `current_epoch` is ignored outright** (0013: "a hint from
/// another epoch is ignored, because a recovery that lost the log tail can reuse tick numbers for
/// different content"): every wanted chunk becomes `snapshot` and `leave` stays empty, the same
/// result a plain join (no hint at all) would produce -- `hint: None` and a foreign-epoch `hint:
/// Some(..)` are indistinguishable in the output.
pub fn diff_resume_hint(
    hint: Option<&ResumeHint>,
    current_epoch: u32,
    camera_center: ChunkCoord,
    wanted: &[ChunkCoord],
    host_version: impl Fn(ChunkCoord) -> u32,
) -> HintDiff {
    let Some(hint) = hint.filter(|h| h.epoch == current_epoch) else {
        return HintDiff {
            keep: Vec::new(),
            snapshot: wanted.to_vec(),
            leave: Vec::new(),
        };
    };
    let held: Vec<(ChunkCoord, u32)> = hint
        .chunks
        .iter()
        .map(|c| {
            (
                ChunkCoord::new(
                    camera_center.x.wrapping_add(i32::from(c.dx)),
                    camera_center.y.wrapping_add(i32::from(c.dy)),
                ),
                c.version,
            )
        })
        .collect();

    let mut keep = Vec::new();
    let mut snapshot = Vec::new();
    for &w in wanted {
        match held.iter().find(|&&(c, _)| c == w) {
            Some(&(_, hinted_version)) if hinted_version == host_version(w) => keep.push(w),
            _ => snapshot.push(w),
        }
    }
    let mut leave = Vec::new();
    for &(c, _) in &held {
        if !wanted.contains(&c) {
            leave.push(c);
        }
    }
    HintDiff {
        keep,
        snapshot,
        leave,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;
    use crate::wire::{ChunkCoordListWriter, FrameHeader, FrameReader, FrameWriter, SectionId};
    use std::collections::BTreeMap;

    fn coord(x: i32, y: i32) -> ChunkCoord {
        ChunkCoord::new(x, y)
    }

    // -- build_resume_hint ------------------------------------------------------------------

    #[test]
    fn build_resume_hint_reports_offsets_relative_to_centre() {
        let held = vec![(coord(10, 10), 5), (coord(9, 10), 7)];
        let hint = build_resume_hint(held.into_iter(), coord(10, 10), 3, 900);
        assert_eq!(hint.epoch, 3);
        assert_eq!(hint.last_tick, 900);
        let mut chunks = hint.chunks.clone();
        chunks.sort_by_key(|c| (c.dy, c.dx));
        assert_eq!(
            chunks,
            vec![
                ResumeChunkHint {
                    dx: -1,
                    dy: 0,
                    version: 7
                },
                ResumeChunkHint {
                    dx: 0,
                    dy: 0,
                    version: 5
                },
            ]
        );
    }

    #[test]
    fn build_resume_hint_omits_chunks_outside_i16_range() {
        let centre = coord(0, 0);
        let held = vec![(coord(40_000, 0), 1), (coord(1, 1), 2)];
        let hint = build_resume_hint(held.into_iter(), centre, 0, 0);
        assert_eq!(hint.chunks.len(), 1);
        assert_eq!(hint.chunks[0].version, 2);
    }

    #[test]
    fn build_resume_hint_truncates_to_max_nearest_first() {
        let centre = coord(0, 0);
        // MAX_RESUME_CHUNKS (128) + 5 chunks strung out along the x axis: the 5 farthest must be
        // the ones dropped.
        let held = (0..(MAX_RESUME_CHUNKS as i32 + 5)).map(|i| (coord(i, 0), i as u32));
        let hint = build_resume_hint(held, centre, 0, 0);
        assert_eq!(hint.chunks.len(), MAX_RESUME_CHUNKS);
        let max_dx = hint.chunks.iter().map(|c| c.dx).max().unwrap();
        assert_eq!(max_dx, MAX_RESUME_CHUNKS as i16 - 1);
    }

    // -- diff_resume_hint ---------------------------------------------------------------------

    fn versions(pairs: &[(ChunkCoord, u32)]) -> BTreeMap<ChunkCoord, u32> {
        pairs.iter().copied().collect()
    }

    #[test]
    fn equal_version_keeps() {
        let centre = coord(0, 0);
        let hint = ResumeHint {
            epoch: 2,
            last_tick: 10,
            chunks: vec![ResumeChunkHint {
                dx: 1,
                dy: 0,
                version: 5,
            }],
        };
        let host = versions(&[(coord(1, 0), 5)]);
        let wanted = [coord(1, 0)];
        let diff = diff_resume_hint(Some(&hint), 2, centre, &wanted, |c| {
            host.get(&c).copied().unwrap_or(0)
        });
        assert_eq!(diff.keep, vec![coord(1, 0)]);
        assert!(diff.snapshot.is_empty());
        assert!(diff.leave.is_empty());
    }

    #[test]
    fn stale_version_snapshots() {
        let centre = coord(0, 0);
        let hint = ResumeHint {
            epoch: 2,
            last_tick: 10,
            chunks: vec![ResumeChunkHint {
                dx: 1,
                dy: 0,
                version: 4, // stale: host has moved on to 5
            }],
        };
        let host = versions(&[(coord(1, 0), 5)]);
        let wanted = [coord(1, 0)];
        let diff = diff_resume_hint(Some(&hint), 2, centre, &wanted, |c| {
            host.get(&c).copied().unwrap_or(0)
        });
        assert!(diff.keep.is_empty());
        assert_eq!(diff.snapshot, vec![coord(1, 0)]);
        assert!(diff.leave.is_empty());

        // Absent from the hint entirely is the same outcome as stale.
        let empty_hint = ResumeHint {
            epoch: 2,
            last_tick: 10,
            chunks: vec![],
        };
        let diff2 = diff_resume_hint(Some(&empty_hint), 2, centre, &wanted, |c| {
            host.get(&c).copied().unwrap_or(0)
        });
        assert_eq!(diff2.snapshot, vec![coord(1, 0)]);
    }

    #[test]
    fn held_but_unwanted_leaves() {
        let centre = coord(0, 0);
        let hint = ResumeHint {
            epoch: 2,
            last_tick: 10,
            chunks: vec![ResumeChunkHint {
                dx: 5,
                dy: 5,
                version: 1,
            }],
        };
        // The new subscription no longer wants (5, 5) at all.
        let wanted: [ChunkCoord; 0] = [];
        let diff = diff_resume_hint(Some(&hint), 2, centre, &wanted, |_| 0);
        assert!(diff.keep.is_empty());
        assert!(diff.snapshot.is_empty());
        assert_eq!(diff.leave, vec![coord(5, 5)]);
    }

    #[test]
    fn foreign_epoch_snapshots_everything_and_leaves_nothing() {
        let centre = coord(0, 0);
        let hint = ResumeHint {
            epoch: 1, // the host is on epoch 2 now (a restart in between)
            last_tick: 10,
            chunks: vec![ResumeChunkHint {
                dx: 0,
                dy: 0,
                version: 9,
            }],
        };
        let wanted = [coord(0, 0), coord(1, 0)];
        // `host_version` would happily match (version 9) if the epoch check were skipped --
        // proves the epoch gate, not merely an absent/stale hint.
        let diff = diff_resume_hint(Some(&hint), 2, centre, &wanted, |_| 9);
        assert_eq!(diff.keep, Vec::<ChunkCoord>::new());
        let mut got = diff.snapshot.clone();
        got.sort_by_key(|c| (c.y, c.x));
        assert_eq!(got, vec![coord(0, 0), coord(1, 0)]);
        assert!(diff.leave.is_empty());

        // A plain join (`hint: None`) produces the identical result.
        let diff_none = diff_resume_hint(None, 2, centre, &wanted, |_| 9);
        assert_eq!(diff_none, diff);
    }

    // -- ChunkKeeps section body --------------------------------------------------------------

    /// `session/golden-keep-entry`: a `ChunkKeeps` section is exactly a `ChunkCoordListWriter`
    /// sequence (module doc comment) -- built here the same way `host::Host::build_frame` will
    /// wire it in step 3 (`fw.section(SectionId::ChunkKeeps, |s| { .. })`), proving the shape and
    /// pinning its bytes.
    #[test]
    fn golden_keep_entries() {
        let keep = [coord(5, 5), coord(6, 5), coord(-3, 9)];
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        let mut fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 42,
                ack_seq: 7,
            },
        );
        fw.section(SectionId::ChunkKeeps, |s| {
            let mut w = ChunkCoordListWriter::new();
            for &c in &keep {
                w.write(s, c);
            }
        });
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("session_chunk_keeps", &buf[..n]);

        // Round-trips back through the generic frame reader as an ordinary section, and its body
        // decodes as the same coordinate list.
        let mut r = FrameReader::new(&buf[..n]).unwrap();
        let (id, body) = r.next_section().unwrap().unwrap();
        assert_eq!(id, SectionId::ChunkKeeps);
        let mut cr = crate::wire::ChunkCoordListReader::new();
        let mut br = crate::bytes::ByteReader::new(body);
        let mut got = Vec::new();
        for _ in 0..keep.len() {
            got.push(cr.read(&mut br).unwrap());
        }
        assert_eq!(got, keep);
    }
}
