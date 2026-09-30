//! M31b (docs/plan/31b-desync-hashes.md "Tests added", Rust half): the hash schedule, the
//! `Hashes` section and `ResyncChunk` bytes, the client check, and the resync heal, end to end
//! through `testkit::Loopback` (real wire bytes both ways). The scenarios use M15's `LGame`.

use engine::bytes::{ByteReader, SliceSink};
use engine::game::PlayerId;
use engine::host::hashes::{
    CHUNK_HASH_EVERY_TICKS, FAIR_EVERY, HashMode, HashSchedule, MAX_DUE_PER_FRAME,
    SCOPE_HASH_EVERY_SECONDS,
};
use engine::integrity::{DesyncScope, RESERVED_SCOPE_COORD};
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::{
    CameraReport, FrameReader, HashEntry, SectionId, read_hashes, read_resync_chunk,
    write_hash_entry, write_resync_chunk,
};
use engine::world::{CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile, TilePos};

use crate::connection_and_subscriptions::{LAction, LGame, LPos};
use engine::game::Game;

struct Flat;
impl PristineSource for Flat {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

fn dims() -> ChunkDims {
    ChunkDims::new(LGame::CHUNK_BITS)
}

fn loopback(seed: u64) -> Loopback<LGame> {
    let mut lb = Loopback::new(WorldParams {
        seed,
        worldgen: (),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    });
    lb.host.set_hash_mode(HashMode::Production);
    lb
}

fn add_client(lb: &mut Loopback<LGame>, cx: i32, cy: i32) -> (usize, PlayerId) {
    let (i, who) = lb.add_client(0, dims(), Box::new(Flat), CacheCapacity::Chunks(1024));
    lb.set_camera(
        i,
        CameraReport {
            center_x: cx,
            center_y: cy,
            half_w: 16,
            half_h: 16,
            vel_x: 0,
            vel_y: 0,
        },
    );
    (i, who)
}

/// The `Hashes` entries of one built frame (empty for no frame, or a frame without the section).
fn hash_entries(frame: &[u8]) -> Vec<HashEntry> {
    let mut out = Vec::new();
    if frame.is_empty() {
        return out;
    }
    let mut r = FrameReader::new(frame).expect("well-formed frame");
    while let Some((id, body)) = r.next_section().expect("well-formed section") {
        if id == SectionId::Hashes {
            read_hashes(&mut ByteReader::new(body), |e| out.push(e)).expect("well-formed hashes");
        }
    }
    out
}

fn frame_tick(frame: &[u8]) -> u32 {
    FrameReader::new(frame).expect("frame").header().tick
}

fn c(x: i32, y: i32) -> ChunkCoord {
    ChunkCoord::new(x, y)
}

// -- Wire ---------------------------------------------------------------------------------------

#[test]
fn integrity_golden_resync_chunk() {
    let mut buf = [0u8; 32];
    let mut sink = SliceSink::new(&mut buf);
    write_resync_chunk(&mut sink, c(3, -2));
    let n = sink.finish().unwrap();
    assert_eq!(read_resync_chunk(&buf[..n]), Ok(c(3, -2)));
    engine::assert_golden_bytes!("wire_resync_chunk", &buf[..n]);

    let mut sink = SliceSink::new(&mut buf);
    write_resync_chunk(&mut sink, RESERVED_SCOPE_COORD);
    let n = sink.finish().unwrap();
    assert_eq!(read_resync_chunk(&buf[..n]), Ok(RESERVED_SCOPE_COORD));
    // Trailing bytes and a wrong type byte are malformed.
    assert!(read_resync_chunk(&[0x04, 2, 2, 0]).is_err());
    assert!(read_resync_chunk(&[0x05, 2, 2]).is_err());
}

#[test]
fn integrity_golden_hashes_section() {
    let entries = [
        HashEntry::Chunk {
            coord: c(-1, 2),
            hash: 0x0123_4567_89ab_cdef,
        },
        HashEntry::Global { hash: 7 },
        HashEntry::OwnPlayer { hash: u64::MAX },
    ];
    let mut buf = [0u8; 64];
    let mut sink = SliceSink::new(&mut buf);
    for e in entries {
        write_hash_entry(&mut sink, e);
    }
    let n = sink.finish().unwrap();
    let mut back = Vec::new();
    read_hashes(&mut ByteReader::new(&buf[..n]), |e| back.push(e)).unwrap();
    assert_eq!(back, entries);
    engine::assert_golden_bytes!("wire_hashes_section", &buf[..n]);
    // An unknown kind cannot be skipped (entries carry no length).
    assert!(read_hashes(&mut ByteReader::new(&[9, 0, 0]), |_| {}).is_err());
}

// -- Schedule ------------------------------------------------------------------------------------

#[test]
fn integrity_schedule_recent_first_then_round_robin() {
    let eligible = [c(0, 0), c(1, 0), c(0, 1), c(1, 1), c(0, 2)];
    let mut s = HashSchedule::new(0, 20);

    // Nothing modified: pure round-robin in (y, x) order, wrapping.
    let quiet = |_c: ChunkCoord| 0u32;
    let mut order = Vec::new();
    let mut tick = 0;
    for _ in 0..7 {
        let p = s.pick(&eligible, quiet).unwrap();
        assert!(p.round_robin);
        order.push(p.coord);
        s.commit(tick, p);
        tick += CHUNK_HASH_EVERY_TICKS;
    }
    assert_eq!(
        order,
        [
            c(0, 0),
            c(1, 0),
            c(0, 1),
            c(1, 1),
            c(0, 2),
            c(0, 0),
            c(1, 0)
        ]
    );

    // Two chunks modified since they were last hashed: the most recently modified goes first, then
    // the other; a chunk hashed at or after its modification is clean again.
    let mut s = HashSchedule::new(0, 20);
    let versions = |ch: ChunkCoord| match (ch.x, ch.y) {
        (1, 1) => 50,
        (0, 2) => 60,
        _ => 0,
    };
    let p = s.pick(&eligible, versions).unwrap();
    assert_eq!((p.coord, p.round_robin), (c(0, 2), false));
    s.commit(60, p);
    let p = s.pick(&eligible, versions).unwrap();
    assert_eq!((p.coord, p.round_robin), (c(1, 1), false));
    s.commit(64, p);
    let p = s.pick(&eligible, versions).unwrap();
    assert!(p.round_robin, "everything modified has been hashed since");
    s.commit(68, p);

    // Fairness: chunks modified faster than the sweep cannot starve the cursor forever. With the
    // modified chunk perpetually newer than its last hash, every FAIR_EVERY-th pick is round-robin.
    let mut s = HashSchedule::new(0, 20);
    let mut rr = 0;
    for k in 0..(FAIR_EVERY * 5) {
        let v = 1000 + k;
        let p = s
            .pick(&eligible, |ch| if ch == c(1, 1) { v } else { 0 })
            .unwrap();
        if p.round_robin {
            rr += 1;
        }
        s.commit(100 + k, p);
    }
    assert_eq!(rr, 5, "one round-robin pick per {FAIR_EVERY}");
    assert!(HashSchedule::new(0, 20).pick(&[], quiet).is_none());
}

/// The host side of the schedule: one chunk hash per `CHUNK_HASH_EVERY_TICKS` ticks, every held
/// chunk covered in `held * period` ticks, `Global` + `OwnPlayer` once per `SCOPE_HASH_EVERY_SECONDS`.
/// A due hash rides the next frame sent anyway (M31b R2): in this idle world that is a heartbeat, so
/// a frame carries every hash that fell due since the last one (at most `MAX_DUE_PER_FRAME`), and
/// the cadence is asserted on the running total and on the frames, not on each tick.
#[test]
fn integrity_host_hashes_one_chunk_per_period_and_sweeps() {
    let mut lb = loopback(11);
    let (i, _) = add_client(&mut lb, 0, 0);
    lb.run(3);
    let held = lb.host.debug_held(lb.conn(i));
    assert!(held.len() >= 4, "held {held:?}");

    let hz = LGame::TICK_RATE.hz_value();
    let ticks = held.len() as u32 * CHUNK_HASH_EVERY_TICKS + 2 * hz * SCOPE_HASH_EVERY_SECONDS;
    let mut frames_with_hashes = Vec::new();
    let mut chunk_total = 0u32;
    let mut seen = std::collections::BTreeSet::new();
    let mut scope_ticks = Vec::new();
    for _ in 0..ticks {
        lb.step();
        let frame = lb.last_built_frame(i).to_vec();
        let entries = hash_entries(&frame);
        let chunks: Vec<_> = entries
            .iter()
            .filter_map(|e| match e {
                HashEntry::Chunk { coord, .. } => Some(*coord),
                _ => None,
            })
            .collect();
        assert!(
            chunks.len() <= MAX_DUE_PER_FRAME as usize,
            "production cadence: at most the hashes that fell due since the last frame"
        );
        if !entries.is_empty() {
            frames_with_hashes.push(frame_tick(&frame));
        }
        for coord in &chunks {
            chunk_total += 1;
            seen.insert(*coord);
        }
        let globals = entries
            .iter()
            .filter(|e| matches!(e, HashEntry::Global { .. }))
            .count();
        let players = entries
            .iter()
            .filter(|e| matches!(e, HashEntry::OwnPlayer { .. }))
            .count();
        assert_eq!(globals, players);
        if globals > 0 {
            scope_ticks.push(frame_tick(&frame));
        }
    }
    // One chunk per period, however the frames batch them (the last period may not have landed).
    let expected = ticks / CHUNK_HASH_EVERY_TICKS;
    assert!(
        chunk_total + 3 >= expected && chunk_total <= expected + 1,
        "{chunk_total} chunk hashes over {ticks} ticks, expected about {expected}"
    );
    // Nothing forces a frame: in this idle world the hash-carrying frames are the heartbeats,
    // one per 500 ms (10 ticks), not one per 4-tick period.
    for w in frames_with_hashes.windows(2) {
        assert!(w[1] - w[0] >= 10, "{frames_with_hashes:?}");
    }
    let held_after = lb.host.debug_held(lb.conn(i));
    assert!(
        held_after.iter().all(|h| seen.contains(h)),
        "every held chunk was hashed: held {held_after:?}, hashed {seen:?}"
    );
    assert_eq!(scope_ticks.len(), 2, "{scope_ticks:?}");
    let gap = scope_ticks[1] - scope_ticks[0];
    let period = hz * SCOPE_HASH_EVERY_SECONDS;
    assert!(
        gap >= period - 10 && gap <= period + 10,
        "scope hashes {gap} ticks apart, period {period} (a heartbeat carries them)"
    );
    assert_eq!(lb.client(i).desyncs().count(), 0);
}

// -- Clean sessions ------------------------------------------------------------------------------

/// A busy little session: paints, entity spawn/move/despawn across a chunk edge, a wide entity on
/// a chunk seam, two overlapping clients.
fn run_busy(lb: &mut Loopback<LGame>, who: [PlayerId; 2], ticks: u32) {
    let mut next_id = 0u32;
    for t in 0..ticks {
        match t % 40 {
            1 => lb.action(
                who[0],
                LAction::Paint {
                    pos: LPos { x: 3, y: 4 },
                    base: (t % 7) as u8 + 2,
                },
            ),
            5 => lb.action(
                who[1],
                LAction::Paint {
                    pos: LPos { x: -5, y: 9 },
                    base: (t % 5) as u8 + 2,
                },
            ),
            9 => {
                lb.action(
                    who[0],
                    LAction::Spawn {
                        id_hint: 0,
                        pos: LPos { x: 30, y: 2 },
                    },
                );
                next_id += 1;
            }
            13 => lb.action(
                who[1],
                LAction::SpawnWide {
                    id_hint: 0,
                    pos: LPos { x: 31, y: 20 },
                },
            ),
            17 => lb.action(
                who[0],
                LAction::Move {
                    id: next_id.max(1),
                    pos: LPos { x: 34, y: 2 },
                },
            ),
            25 => lb.action(who[1], LAction::SetNote { n: t }),
            29 => lb.action(who[0], LAction::Despawn { id: next_id.max(1) }),
            _ => {}
        }
        lb.step();
    }
}

/// Every chunk the host holds for `i` hashes the same on both sides (the version-agnostic check the
/// desync hashes use; `region_hash` also compares per-chunk versions).
fn chunks_converged(lb: &Loopback<LGame>, i: usize) -> bool {
    let conn = lb.conn(i);
    let held = lb.host.debug_held(conn);
    !held.is_empty()
        && held
            .iter()
            .all(|&ch| lb.client(i).view().chunk_hash(ch) == lb.host.chunk_hash(conn, ch))
}

fn no_reports(lb: &Loopback<LGame>, clients: usize) {
    for i in 0..clients {
        assert_eq!(
            lb.client(i).desyncs().count(),
            0,
            "client {i}: {:?}",
            lb.client(i).desyncs().get(0)
        );
    }
    assert_eq!(lb.host.desyncs().count(), 0);
}

#[test]
fn integrity_clean_session_no_reports() {
    let mut lb = loopback(21);
    let (a, wa) = add_client(&mut lb, 0, 0);
    let (b, wb) = add_client(&mut lb, 20, 8);
    lb.run(4);
    run_busy(&mut lb, [wa, wb], 400);
    lb.run(60);
    assert!(chunks_converged(&lb, a) && chunks_converged(&lb, b));
    no_reports(&lb, 2);
}

/// Hash-all (`HashMode::All`) is the harshest probe of the check: every held chunk every frame.
#[test]
fn integrity_clean_session_no_reports_hash_all() {
    let mut lb = loopback(22);
    lb.host.set_hash_mode(HashMode::All);
    let (_a, wa) = add_client(&mut lb, 0, 0);
    let (_b, wb) = add_client(&mut lb, 20, 8);
    lb.run(4);
    run_busy(&mut lb, [wa, wb], 240);
    no_reports(&lb, 2);
}

// -- The overlay is never hashed -----------------------------------------------------------------

#[test]
fn integrity_hash_ignores_overlay() {
    let mut lb = loopback(31);
    let (i, _) = add_client(&mut lb, 0, 0);
    lb.run(6);
    let chunk = c(0, 0);
    let conn = lb.conn(i);
    let before = lb.client(i).view().chunk_hash(chunk).expect("held");
    assert_eq!(Some(before), lb.host.chunk_hash(conn, chunk));

    // A predicted paint sits in the overlay (not yet acked) -- and changes what the game sees.
    let pos = TilePos::new(4, 4);
    let seen_before = lb.visible(
        i,
        engine::world::TileRect::new(pos, TilePos::new(pos.x + 1, pos.y + 1)),
    );
    lb.dispatch(
        i,
        LAction::Paint {
            pos: LPos { x: 4, y: 4 },
            base: 9,
        },
    );
    assert!(lb.overlay_len(i) > 0, "a pending predicted action exists");
    let seen_after = lb.visible(
        i,
        engine::world::TileRect::new(pos, TilePos::new(pos.x + 1, pos.y + 1)),
    );
    assert_ne!(
        seen_before, seen_after,
        "the overlay changes the merged view"
    );
    assert_eq!(
        lb.client(i).view().chunk_hash(chunk),
        Some(before),
        "the replica's hash ignores the overlay"
    );
    assert_eq!(
        lb.client(i).view().global_hash(),
        lb.client(i).view().global_hash()
    );
}

// -- Heal ------------------------------------------------------------------------------------

/// Ticks enough for one full sweep of the held chunks plus resync latency.
fn sweep_ticks(lb: &Loopback<LGame>, i: usize) -> u32 {
    (lb.host.debug_held(lb.conn(i)).len() as u32 + 3) * CHUNK_HASH_EVERY_TICKS + 8
}

#[test]
fn integrity_corrupt_chunk_heals() {
    let mut lb = loopback(41);
    let (i, _) = add_client(&mut lb, 0, 0);
    lb.run(8);
    let chunk = c(0, 0);
    assert!(lb.client_mut(i).debug_corrupt_chunk(chunk));
    let conn = lb.conn(i);
    assert_ne!(
        lb.client(i).view().chunk_hash(chunk),
        lb.host.chunk_hash(conn, chunk),
        "the injected corruption changes the hash"
    );
    lb.run(sweep_ticks(&lb, i));
    assert_eq!(lb.client(i).desyncs().count(), 1);
    let r = lb.client(i).desyncs().get(0).unwrap();
    assert_eq!((r.scope, r.coord), (DesyncScope::Chunk, chunk));
    assert_ne!(r.host_hash, r.client_hash);
    assert_eq!(lb.host.desyncs().count(), 1);
    let h = lb.host.desyncs().get(0).unwrap();
    assert_eq!((h.scope, h.coord), (DesyncScope::Chunk, chunk));
    assert_eq!(h.host_hash, r.host_hash);
    // Healed: converged, and a second full sweep reports nothing new.
    assert!(chunks_converged(&lb, i));
    lb.run(sweep_ticks(&lb, i));
    assert_eq!(lb.client(i).desyncs().count(), 1);
    assert_eq!(lb.host.desyncs().count(), 1);
}

#[test]
fn integrity_skipped_delta_heals() {
    let mut lb = loopback(42);
    let (i, who) = add_client(&mut lb, 0, 0);
    lb.run(7);
    let conn = lb.conn(i);
    lb.host.skip_delta(conn, c(0, 0));
    lb.action(
        who,
        LAction::Paint {
            pos: LPos { x: 2, y: 3 },
            base: 5,
        },
    );
    // The frame that would carry the delta has none for chunk (0, 0), so the replica is behind; the
    // very next hash slot picks that modified chunk first, and the client reports it at once.
    lb.step();
    assert_eq!(
        lb.client(i).last_summary().tile_deltas,
        0,
        "the delta was dropped"
    );
    let mut steps = 1;
    while lb.client(i).desyncs().count() == 0 && steps <= CHUNK_HASH_EVERY_TICKS {
        assert!(!chunks_converged(&lb, i));
        lb.step();
        steps += 1;
    }
    assert!(
        lb.client(i).desyncs().count() >= 1,
        "reported within one hash period ({steps} steps)"
    );
    lb.run(sweep_ticks(&lb, i));
    assert!(lb.client(i).desyncs().count() >= 1);
    assert_eq!(lb.client(i).desyncs().get(0).unwrap().coord, c(0, 0));
    assert!(lb.host.desyncs().count() >= 1);
    assert!(chunks_converged(&lb, i));
}

// -- Resync ------------------------------------------------------------------------------------

/// The reserved coordinate asks for `Global` and `OwnPlayer`: the host records a `Global` report and
/// the very next frame carries both sections, though nothing about either changed.
#[test]
fn integrity_reserved_coord_resends_both_scopes() {
    let mut lb = loopback(51);
    let (i, _) = add_client(&mut lb, 0, 0);
    lb.run(8);
    let conn = lb.conn(i);
    // A quiet frame carries neither section.
    let frame = lb.last_built_frame(i).to_vec();
    let sections = |frame: &[u8]| {
        let mut ids = Vec::new();
        if !frame.is_empty() {
            let mut r = FrameReader::new(frame).unwrap();
            while let Some((id, _)) = r.next_section().unwrap() {
                ids.push(id);
            }
        }
        ids
    };
    assert!(!sections(&frame).contains(&SectionId::Global));

    let mut msg = [0u8; 16];
    let mut sink = SliceSink::new(&mut msg);
    write_resync_chunk(&mut sink, RESERVED_SCOPE_COORD);
    let n = sink.finish().unwrap();
    lb.host.on_uplink(conn, &msg[..n]).unwrap();
    assert_eq!(lb.host.desyncs().count(), 1);
    let r = lb.host.desyncs().get(0).unwrap();
    assert_eq!(
        (r.scope, r.coord),
        (DesyncScope::Global, RESERVED_SCOPE_COORD)
    );

    lb.step();
    let ids = sections(lb.last_built_frame(i));
    assert!(
        ids.contains(&SectionId::Global) && ids.contains(&SectionId::OwnPlayer),
        "{ids:?}"
    );
    // A second frame is quiet again: the resend is one-shot.
    lb.step();
    assert!(!sections(lb.last_built_frame(i)).contains(&SectionId::Global));
    // A malformed resync closes the connection (an `UplinkError`); an unheld chunk is ignored.
    assert!(lb.host.on_uplink(conn, &[0x04, 2]).is_err());
    let before = lb.host.desyncs().count();
    let mut sink = SliceSink::new(&mut msg);
    write_resync_chunk(&mut sink, c(900, 900));
    let n = sink.finish().unwrap();
    lb.host.on_uplink(conn, &msg[..n]).unwrap();
    assert_eq!(lb.host.desyncs().count(), before);
}

/// Two heavy chunks corrupted at once on a connection with a slow chunk bucket: the two resync
/// snapshots are paid from the bucket one after the other (the second waits out the first's
/// debt). The same scenario with no pacing delivers them within a hash period of each other.
fn resync_snapshot_ticks(paced: bool) -> Vec<u32> {
    use engine::host::pacing::BandwidthConfig;
    let mut lb = loopback(61);
    // The painter (client 0) is never paced; it only exists to put ~200 distinct tiles in each of
    // two chunks, and to be a second connection the paced one is compared against.
    lb.host.set_bandwidth(BandwidthConfig {
        unpaced: true,
        action_per_s: 100_000,
        action_burst: 100_000,
        ..BandwidthConfig::default()
    });
    let (p, painter) = add_client(&mut lb, 0, 0);
    lb.run(3);
    for k in 0..200 {
        for (x0, y0) in [(0, 0), (-32, 0)] {
            lb.action(
                painter,
                LAction::Paint {
                    pos: LPos {
                        x: x0 + (k % 25),
                        y: y0 + (k / 25),
                    },
                    base: 2 + (k % 3) as u8,
                },
            );
        }
        lb.step();
    }
    lb.run(10);
    assert!(chunks_converged(&lb, p));

    // The observer joins with the slow bucket (or none): 10 B per tick, 100 B burst.
    lb.host.set_bandwidth(if paced {
        BandwidthConfig {
            chunk_refill_bytes_per_s: 200,
            chunk_burst_bytes: 100,
            action_per_s: 100_000,
            action_burst: 100_000,
            ..BandwidthConfig::default()
        }
    } else {
        BandwidthConfig {
            unpaced: true,
            ..BandwidthConfig::default()
        }
    });
    let (o, _) = add_client(&mut lb, -8, 8);
    let mut guard = 0;
    while !chunks_converged(&lb, o)
        || lb.host.pacing_counters(lb.conn(o)).unwrap().queued_enters > 0
    {
        lb.step();
        guard += 1;
        assert!(guard < 2000, "observer never converged");
    }
    lb.run(40);
    let held = lb.host.debug_held(lb.conn(o));
    assert!(held.contains(&c(0, 0)) && held.contains(&c(-1, 0)));
    assert_eq!(lb.client(o).desyncs().count(), 0);

    // Corrupt both heavy chunks, then record the ticks at which snapshots reach the observer.
    assert!(lb.client_mut(o).debug_corrupt_chunk(c(0, 0)));
    assert!(lb.client_mut(o).debug_corrupt_chunk(c(-1, 0)));
    let mut ticks = Vec::new();
    for _ in 0..1500 {
        lb.step();
        if !lb.last_built_frame(o).is_empty() && lb.client(o).last_summary().chunk_snapshots > 0 {
            let t = lb.client(o).last_summary().tick.0;
            if ticks.last() != Some(&t) {
                ticks.push(t);
            }
        }
        if ticks.len() >= 2 && chunks_converged(&lb, o) {
            break;
        }
    }
    assert!(chunks_converged(&lb, o), "healed (paced: {paced})");
    ticks
}

#[test]
fn integrity_resync_respects_bucket() {
    let unpaced = resync_snapshot_ticks(false);
    assert_eq!(unpaced.len(), 2, "{unpaced:?}");
    assert!(
        unpaced[1] - unpaced[0] <= 2 * CHUNK_HASH_EVERY_TICKS,
        "without a bucket the snapshots follow the two reports: {unpaced:?}"
    );
    let paced = resync_snapshot_ticks(true);
    assert_eq!(paced.len(), 2, "{paced:?}");
    // ~800 B at 10 B/tick: the second snapshot waits ~80 ticks for the first's debt.
    assert!(
        paced[1] - paced[0] >= 40,
        "the resync snapshots are paid from the chunk bucket: {paced:?}"
    );
}
