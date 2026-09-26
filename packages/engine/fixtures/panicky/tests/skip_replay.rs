//! docs/plan/24-recovery-and-migration.md step 3: `Skip` semantics in the scan/apply passes,
//! proven natively against `Host<Panicky>` (`sim_replay_scan_begin/push/end`, `sim_replay_begin/
//! push/end`, `sim_log_skip`) -- no ABI/`.wasm` involved. `Global::apply_count` (`fx_panicky`'s own
//! doc comment) is the "additive action" a double-apply would show.

use engine::abi::{Instance, Status};
use engine::bytes::ByteSink;
use engine::codec;
use engine::game::PlayerId;
use engine::persist::{FrameProgress, FrameReader};
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::{CameraReport, UplinkWriter};
use fx_panicky::{Action, Panicky};

fn params() -> WorldParams<Panicky> {
    WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 64,
        max_modified_tiles: 64,
        max_action_growth: 64,
    }
}

/// Builds one `UplinkBatch` carrying a single `(seq, action)` pair -- the same shape
/// `testkit::Loopback::action` builds internally, but with an explicit `seq` (needed to *resend*
/// one, which `Loopback::action`'s own auto-incrementing counter cannot do).
fn uplink_bytes(seq: u32, action: &Action) -> Vec<u8> {
    let mut action_buf = [0u8; 64];
    let n = codec::encode(action, &mut action_buf).expect("action fits");
    let mut out = Vec::new();
    struct V<'a>(&'a mut Vec<u8>);
    impl ByteSink for V<'_> {
        fn put(&mut self, b: &[u8]) {
            self.0.extend_from_slice(b);
        }
    }
    UplinkWriter::write(
        &mut V(&mut out),
        0,
        std::iter::once((seq, &action_buf[..n])),
        None::<CameraReport>,
        None,
    );
    out
}

/// Live run: connect a player, admit one `ArmTickPanic` (the "poisoned" record we'll later mark
/// `Skip`), seal + tick, then a second idle tick. Returns the whole segment-0 log and the byte
/// offset of the poisoned record within it (via a scratch `FrameReader`, never hand-computed).
fn build_log_with_one_action() -> (Vec<u8>, u64, PlayerId) {
    let mut lb = Loopback::<Panicky>::new(params());
    let player = lb.host.connect(0);
    let mut log = Vec::new();
    let mut buf = vec![0u8; 4096];
    // Seal + tick the connect's own `Joined`/`Connected` records into their own frame first, so
    // the *next* frame holds only the action -- its own record is then unambiguously
    // `frame.record_offsets[0]`.
    let n = lb
        .host
        .sim_seal_frame(&mut buf)
        .expect("sim_seal_frame must succeed once genesis has run");
    assert!(n > 0, "connect must log Joined+Connected");
    log.extend_from_slice(&buf[..n as usize]);
    lb.step();

    lb.action(player, Action::ArmTickPanic { at: 999 }); // never actually fires
    let n = lb
        .host
        .sim_seal_frame(&mut buf)
        .expect("sim_seal_frame must succeed");
    assert!(n > 0, "the frame must carry the admitted action");
    log.extend_from_slice(&buf[..n as usize]);
    lb.step(); // applies it live (apply_count -> 1 on the live side, irrelevant to replay below)

    // One persistent `FrameReader` over the *whole* log, from byte 0: `record_offsets` are
    // already absolute (relative to this reader's own first-ever byte) once the two frames are
    // decoded back to back, exactly the same basis `sim_replay_push`'s own reader uses.
    let mut reader: FrameReader<Panicky> = FrameReader::new();
    let first = match reader.push(&log).expect("must decode the first frame") {
        FrameProgress::Frame(f) => f,
        FrameProgress::NeedMore => panic!("first frame must decode in one push"),
    };
    assert_eq!(first.records.len(), 2, "connect logs Joined+Connected");
    let frame = match reader.push(&[]).expect("must decode") {
        FrameProgress::Frame(f) => f,
        FrameProgress::NeedMore => panic!("second frame must already be fully buffered"),
    };
    assert_eq!(
        frame.records.len(),
        1,
        "the action must be alone in its own frame"
    );
    let offset = frame.record_offsets[0];
    (log, offset, player)
}

/// Feeds `log` through the scan pass then the real apply pass on `host` (segment 0, offset 0) --
/// the exact two-call sequence `Persistence.loadLatest`/`test/replay.ts` use.
fn replay(host: &mut engine::host::Host<Panicky>, log: &[u8]) {
    assert_eq!(host.sim_replay_scan_begin(0), Status::Ok);
    assert_eq!(host.sim_replay_scan_push(log), Status::Ok);
    assert_eq!(host.sim_replay_scan_end(), Status::Ok);
    assert_eq!(host.sim_replay_begin(0, 0), Status::Ok);
    assert_eq!(host.sim_replay_push(log), Status::Ok);
    assert_eq!(host.sim_replay_end(), Status::Ok);
}

#[test]
fn skip_record_golden_bytes() {
    // `sim_log_skip` reuses `persist::FrameWriter` directly (`Host::sim_log_skip`'s own doc
    // comment): this golden pins the exact bytes a `Skip { segment: 5, offset: 1234 }` frame
    // produces, `tick_delta = 0`.
    let host = engine::host::Host::<Panicky>::genesis_for_test(params());
    let mut host = host;
    let mut buf = vec![0u8; 64];
    let n = host
        .sim_log_skip(5, 1234, &mut buf)
        .expect("sim_log_skip must succeed");
    engine::assert_golden_bytes!("skip_record_golden_bytes", &buf[..n as usize]);
}

#[test]
fn replay_honours_skip_and_advances_seq() {
    let (mut log, offset, player) = build_log_with_one_action();

    // Append a `Skip` frame targeting the poisoned record, exactly what `Host::sim_log_skip`
    // (called on a scratch instance) would produce.
    let mut scratch = engine::host::Host::<Panicky>::genesis_for_test(params());
    let mut skip_buf = vec![0u8; 64];
    let skip_len = scratch
        .sim_log_skip(0, offset as u32, &mut skip_buf)
        .expect("sim_log_skip must succeed");
    log.extend_from_slice(&skip_buf[..skip_len as usize]);

    let mut fresh = engine::host::Host::<Panicky>::genesis_for_test(params());
    replay(&mut fresh, &log);

    let sim = fresh.sim().expect("replay must leave a live Sim");
    assert_eq!(
        sim.authority().store().global().apply_count,
        0,
        "the skipped record must never reach apply"
    );
    assert_eq!(
        sim.authority().store().last_seq(player),
        Ok(1),
        "a skipped record still advances that player's last processed seq"
    );

    // Reconnect (replay never calls `Host::connect`, M22b Deviations) and confirm the queued
    // `EngineFault` ack rides out on this player's first frame.
    let conn = player.0 - 1;
    let reconnected = fresh.connect(conn);
    assert_eq!(reconnected, player);
    let mut frame_buf = vec![0u8; 4096];
    let built = fresh
        .sim_build_frame(conn, &mut frame_buf)
        .expect("build_frame must succeed");
    assert!(built > 0, "the reconnect frame must carry the queued ack");

    // A resend of the skipped seq (an additive action, so a double-apply would show) must not be
    // applied: `on_uplink`'s own dedup floor already covers this once `last_seq` is advanced.
    let resend = uplink_bytes(1, &Action::ArmTickPanic { at: 999 });
    fresh
        .on_uplink(conn, &resend)
        .expect("a resend is not a protocol error");
    fresh.tick();
    let sim = fresh.sim().expect("still live");
    assert_eq!(
        sim.authority().store().global().apply_count,
        0,
        "a resend of the skipped seq must not be applied"
    );
}

#[test]
fn replay_with_skip_is_deterministic() {
    let (mut log, offset, _player) = build_log_with_one_action();
    let mut scratch = engine::host::Host::<Panicky>::genesis_for_test(params());
    let mut skip_buf = vec![0u8; 64];
    let skip_len = scratch
        .sim_log_skip(0, offset as u32, &mut skip_buf)
        .expect("sim_log_skip must succeed");
    log.extend_from_slice(&skip_buf[..skip_len as usize]);

    let mut a = engine::host::Host::<Panicky>::genesis_for_test(params());
    replay(&mut a, &log);
    let mut b = engine::host::Host::<Panicky>::genesis_for_test(params());
    replay(&mut b, &log);
    assert_eq!(
        a.sim().unwrap().state_hash(),
        b.sim().unwrap().state_hash(),
        "two replays of the same Skip-bearing log must agree"
    );

    // ... and must differ from a replay of the *original*, Skip-free log (otherwise this proves
    // nothing: the poisoned record's own apply is a state mutation, so honouring the Skip must
    // change the resulting hash).
    let (log_no_skip, _offset, _player) = build_log_with_one_action();
    let mut c = engine::host::Host::<Panicky>::genesis_for_test(params());
    replay(&mut c, &log_no_skip);
    assert_ne!(
        a.sim().unwrap().state_hash(),
        c.sim().unwrap().state_hash(),
        "a Skip-bearing replay must diverge from the Skip-free one -- otherwise the Skip proved nothing"
    );
}

#[test]
fn replay_of_a_segment_whose_last_frame_is_skip_then_more_live_frames() {
    // Skip frame appended at the *end* of the segment (as it would be right after recovery),
    // followed by more real frames from continued live play -- proves `sim_log_skip`'s own
    // `tick_delta = 0` never disturbs the writer's or any reader's tick reference (M22's own
    // `log_ref_tick`/segment-reset rules; ADR 0038).
    let (mut log, offset, player) = build_log_with_one_action();
    let mut scratch = engine::host::Host::<Panicky>::genesis_for_test(params());
    let mut skip_buf = vec![0u8; 64];
    let skip_len = scratch
        .sim_log_skip(0, offset as u32, &mut skip_buf)
        .expect("sim_log_skip must succeed");
    log.extend_from_slice(&skip_buf[..skip_len as usize]); // the Skip frame is now the last frame

    // More live frames, from a *live* host continuing past the point recovery reached (matches
    // "resumes with connections open"): reconnect, then admit and log one more real action.
    let mut live = engine::host::Host::<Panicky>::genesis_for_test(params());
    replay(&mut live, &log);
    let conn = player.0 - 1;
    live.connect(conn);
    let more = uplink_bytes(2, &Action::ArmTickAlloc { at: 999 });
    live.on_uplink(conn, &more).expect("not a protocol error");
    let mut buf = vec![0u8; 4096];
    let n = live
        .sim_seal_frame(&mut buf)
        .expect("sim_seal_frame must succeed");
    assert!(n > 0, "the new action must be logged");
    log.extend_from_slice(&buf[..n as usize]);
    live.tick();

    // Replay the whole thing (Skip frame in the middle, one more real frame after it) from
    // scratch and confirm it reaches the same state as the live run just did.
    let mut replayed = engine::host::Host::<Panicky>::genesis_for_test(params());
    replay(&mut replayed, &log);
    assert_eq!(
        live.sim().unwrap().state_hash(),
        replayed.sim().unwrap().state_hash(),
        "a Skip frame at the end of a segment must not disturb frames logged after it"
    );
    assert_eq!(
        replayed
            .sim()
            .unwrap()
            .authority()
            .store()
            .global()
            .armed_tick_alloc,
        Some(999),
        "the post-Skip action must have been applied for real"
    );
    // Independent of the `live`/`replayed` comparison above (which replays the Skip-terminated
    // log on *both* sides, so a bug shared by both paths would cancel out and prove nothing): the
    // Skip-only frame's own `tick_delta = 0` must never advance the tick counter by itself. Three
    // real frames were logged in total (connect's own Joined+Connected at tick 1, `ArmTickPanic`
    // at tick 2, the post-Skip `ArmTickAlloc` at tick 3) -- the Skip frame between the second and
    // third must not add a fourth.
    assert_eq!(
        replayed.sim().unwrap().tick().0,
        3,
        "the Skip-only frame must not itself advance the tick counter"
    );
}
