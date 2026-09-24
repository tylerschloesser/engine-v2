//! `relay_recipients`, `rerelay_and_gone` (docs/plan/19-presence-channel.md Tests added, steps
//! 4-6): drives `Host<Presence>` directly and decodes `Host::build_frame`'s own bytes through the
//! real wire readers (`FrameReader` + `wire::read_presence`), so these tests exercise the exact
//! bytes a client would decode, not an internal accessor.

use engine::bytes::{ByteReader, SliceSink};
use engine::codec;
use engine::game::{Game, PlayerId};
use engine::host::Host;
use engine::sim::WorldParams;
use engine::wire::{
    CameraReport, FrameReader, PresenceDeltaOp, SectionId, UplinkWriter, read_presence,
};
use fx_presence::{PlayerPresence, Presence};

fn params(seed: u64) -> WorldParams<Presence> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities: 262_144,
        max_modified_tiles: 1_048_576,
        max_action_growth: 4_096,
    }
}

fn send_camera(host: &mut Host<Presence>, conn: u32, report: CameraReport) {
    let mut buf = [0u8; 256];
    let mut sink = SliceSink::new(&mut buf);
    UplinkWriter::write(&mut sink, 0, core::iter::empty(), Some(report), None);
    let n = sink.finish().unwrap();
    host.on_uplink(conn, &buf[..n]).unwrap();
}

fn send_presence(host: &mut Host<Presence>, conn: u32, sample: PlayerPresence) {
    let mut sample_buf = [0u8; 32];
    let n_sample = codec::encode(&sample, &mut sample_buf).unwrap();
    let mut buf = [0u8; 256];
    let mut sink = SliceSink::new(&mut buf);
    UplinkWriter::write(
        &mut sink,
        0,
        core::iter::empty(),
        None,
        Some(&sample_buf[..n_sample]),
    );
    let n = sink.finish().unwrap();
    host.on_uplink(conn, &buf[..n]).unwrap();
}

/// A ring-1 camera comfortably covering the chunk containing `(0, 0)` (chunk `(0, 0)` at any
/// `CHUNK_BITS` this fixture might use): half extent 16 tiles is well over one chunk edge either
/// way.
fn covering_camera() -> CameraReport {
    CameraReport {
        center_x: 0,
        center_y: 0,
        half_w: 16,
        half_h: 16,
        vel_x: 0,
        vel_y: 0,
    }
}

/// Far outside `covering_camera`'s ring 1/3 and look-ahead (0010 "Subscription set"): never
/// subscribes chunk `(0, 0)`.
fn far_camera() -> CameraReport {
    CameraReport {
        center_x: 100_000,
        center_y: 100_000,
        half_w: 16,
        half_h: 16,
        vel_x: 0,
        vel_y: 0,
    }
}

/// Decodes `bytes` (a `Host::build_frame` output) into its `Presence` section entries, if any --
/// `None` if the frame carries no `Presence` section at all.
fn presence_entries(bytes: &[u8]) -> Option<Vec<PresenceDeltaOp<Presence>>> {
    if bytes.is_empty() {
        // `Host::build_frame`'s own "nothing to say" convention: no bytes at all, not even a
        // 10-byte heartbeat header (`host/mod.rs`'s own early `return 0`).
        return None;
    }
    let mut r = FrameReader::new(bytes).expect("well-formed frame");
    while let Some((id, body)) = r.next_section().expect("well-formed frame") {
        if id == SectionId::Presence {
            let mut br = ByteReader::new(body);
            let mut ops = Vec::new();
            read_presence::<Presence>(&mut br, |op| ops.push(op)).expect("well-formed section");
            return Some(ops);
        }
    }
    None
}

fn sample_of(ops: &[PresenceDeltaOp<Presence>], who: PlayerId) -> Option<(u32, PlayerPresence)> {
    ops.iter().find_map(|op| match op {
        PresenceDeltaOp::Sample {
            who: w,
            age_ticks,
            sample,
        } if *w == who => Some((*age_ticks, *sample)),
        _ => None,
    })
}

fn is_gone(ops: &[PresenceDeltaOp<Presence>], who: PlayerId) -> bool {
    ops.iter()
        .any(|op| matches!(op, PresenceDeltaOp::Gone { who: w } if *w == who))
}

/// `relay_recipients`: only a client subscribed to the chunk of `pos()` sees a sample; a player's
/// own sample never comes back to them; an unsubscribed client sees nothing.
///
/// Inject-fail-revert (relay to the sender): in `Host::build_frame` (`host/mod.rs`), changed `if
/// who == slot.player { continue; }` to `if false && who == slot.player { .. }` (never skips) --
/// this test's own "sender: never sees their own sample" assertion failed (panicked with "a
/// player's own sample must never be relayed back to them"); reverted. (This injection needed `a`
/// to hold a real subscription of its own -- this test's own `covering_camera()` setup for
/// connection 0 -- or the *other* guard below would mask it.)
///
/// Inject-fail-revert (relay to an unsubscribed client): changed `if !slot.subs.is_subscribed
/// (chunk) { continue; }` to `if false && !slot.subs.is_subscribed(chunk) { .. }` (never skips) --
/// this test's own "never subscribed: sees nothing" assertion failed (panicked with "an
/// unsubscribed client must never see the sample"); reverted.
#[test]
fn relay_recipients() {
    let mut host = Host::<Presence>::genesis_for_test(params(1));
    let a = host.connect(0); // sender
    let b = host.connect(1); // subscribed
    let _c = host.connect(2); // never subscribed
    host.tick();

    send_camera(&mut host, 0, covering_camera());
    send_camera(&mut host, 1, covering_camera());
    send_camera(&mut host, 2, far_camera());
    host.tick();
    let _ = host.build_frame(0, &mut [0u8; 4096]);
    let _ = host.build_frame(1, &mut [0u8; 4096]);
    let _ = host.build_frame(2, &mut [0u8; 4096]);
    host.seal();

    let sample = PlayerPresence {
        pos: [0, 0],
        vel: [1, 2],
    };
    send_presence(&mut host, 0, sample);
    host.tick();

    let mut a_buf = [0u8; 4096];
    let n_a = host.build_frame(0, &mut a_buf);
    let mut b_buf = [0u8; 4096];
    let n_b = host.build_frame(1, &mut b_buf);
    let mut c_buf = [0u8; 4096];
    let n_c = host.build_frame(2, &mut c_buf);

    // Subscribed, not the sender: sees exactly `a`'s sample, freshly relayed (a small `age_ticks`
    // -- one tick, since `received_at` is stamped just before the `host.tick()` that delivers it).
    let b_ops = presence_entries(&b_buf[..n_b]).expect("b is subscribed to a's chunk");
    let (age, got_sample) = sample_of(&b_ops, a).expect("b must see a's sample");
    assert_eq!(got_sample, sample);
    assert!(
        age <= 1,
        "a first relay's own age_ticks should be tiny, got {age}"
    );

    // The sender: never sees their own sample (0010 host drop rule).
    let a_ops = presence_entries(&a_buf[..n_a]);
    assert!(
        a_ops.is_none_or(|ops| sample_of(&ops, a).is_none()),
        "a player's own sample must never be relayed back to them"
    );

    // Never subscribed: sees nothing.
    let c_ops = presence_entries(&c_buf[..n_c]);
    assert!(
        c_ops.is_none_or(|ops| sample_of(&ops, a).is_none()),
        "an unsubscribed client must never see the sample"
    );

    let _ = b; // used only via `a`'s relay target above
}

/// `relay_recipients`'s own "newest only after a stalled client resumes": a subscribed client
/// whose frames are all applied at once (a stand-in for a stall) ends up with the *latest* sample,
/// not an intermediate one, since the host's own `PresenceTable::on_sample` never queues (host/mod
/// Deviations) and each `build_frame` reads its current value fresh.
#[test]
fn relay_recipients_newest_after_stall() {
    use engine::client::{ClientCore, Replica};
    use engine::world::{CacheCapacity, ChunkDims, PristineSource, Tile};

    struct FlatSource;
    impl PristineSource for FlatSource {
        fn generate(&self, _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::new(1, 0, 0));
        }
    }

    let mut host = Host::<Presence>::genesis_for_test(params(1));
    let a = host.connect(0);
    let b = host.connect(1);
    host.tick();
    send_camera(&mut host, 1, covering_camera());
    host.tick();
    let _ = host.build_frame(1, &mut [0u8; 4096]);
    host.seal();

    let mut client = ClientCore::new(Replica::<Presence>::new(
        ChunkDims::new(Presence::CHUNK_BITS),
        Box::new(FlatSource),
        CacheCapacity::Chunks(128),
        b,
    ));

    // Several distinct samples, each preceded by its own settling tick (so this sample's own
    // `received_at` -- stamped from `self.last_tick` at `on_uplink` time -- is strictly newer than
    // the *previous* iteration's own `presence_relayed` tick, stamped from `self.last_tick` right
    // after that iteration's `build_frame`: two events sharing one clock but read at different
    // points in the tick lifecycle need this one tick of separation, or "newer than last relayed"
    // never fires and only the >= 1 Hz floor would eventually catch up -- not what this test is
    // about). Never applied to the client until the end (the "stall"): `build_frame` re-reads the
    // table fresh every tick, so each queued frame's own `Presence` section reflects whatever was
    // current *at that tick*, not a backlog.
    let mut frames = Vec::new();
    for i in 0..5i32 {
        host.tick();
        send_presence(
            &mut host,
            0,
            PlayerPresence {
                pos: [i, 0],
                vel: [0, 0],
            },
        );
        host.tick();
        let mut buf = [0u8; 4096];
        let n = host.build_frame(1, &mut buf);
        frames.push(buf[..n].to_vec());
        host.seal();
    }
    // Apply every queued frame at once now (the stall resuming); a tick with nothing new produces
    // no bytes at all (`Host::build_frame`'s own "nothing to say" convention) and is skipped.
    for bytes in frames.iter().filter(|b| !b.is_empty()) {
        client.on_frame(bytes).unwrap();
    }

    let got = client
        .view()
        .remote_presences()
        .debug_get(a)
        .expect("a's sample must have reached the client");
    assert_eq!(
        got.sample,
        PlayerPresence {
            pos: [4, 0],
            vel: [0, 0]
        },
        "a stalled client that resumes must end up with the newest sample"
    );
}

/// `rerelay_and_gone`: a held sample (unchanged since its first relay) is re-relayed at >= 1 Hz
/// with a growing `age_ticks`; a disconnect produces `Gone` in the very next frame.
///
/// Inject-fail-revert (drop the re-relay): changed the `due` match's `Some(&last) => ...` arm to
/// always `false` (never re-relays past the first `Sample`) -- panicked with ">= 1 Hz re-relay
/// must eventually fire" (the loop ran out after 20 ticks with no second hit); reverted.
///
/// Inject-fail-revert (drop `Gone`): guarded the `Gone` push in `Host::build_frame`'s second
/// scratch-presence loop with `if false && ..` (never pushes) -- panicked with "the disconnect
/// frame must carry a Presence section" (`presence_entries` returned `None`); reverted.
///
/// Inject-fail-revert (skip `age_ticks`): hardcoded the `age_ticks` varint to `0` in
/// `write_presence_flat`'s `Sample` arm -- panicked with "age_ticks must grow across a re-relay:
/// first 0, second 0"; reverted.
#[test]
fn rerelay_and_gone() {
    let mut host = Host::<Presence>::genesis_for_test(params(1));
    let a = host.connect(0);
    let _b = host.connect(1);
    host.tick();
    send_camera(&mut host, 1, covering_camera());
    host.tick();
    let _ = host.build_frame(1, &mut [0u8; 4096]);
    host.seal();

    let sample = PlayerPresence {
        pos: [0, 0],
        vel: [0, 0],
    };
    send_presence(&mut host, 0, sample);
    host.tick();
    let mut buf = [0u8; 4096];
    let n = host.build_frame(1, &mut buf);
    host.seal();
    let first_ops = presence_entries(&buf[..n]).expect("first relay must carry a Sample");
    let (first_age, first_sample) = sample_of(&first_ops, a).expect("a's own sample");
    assert_eq!(first_sample, sample);

    // For several ticks, nothing changed and < 1 s has passed: no re-relay.
    for _ in 0..5 {
        host.tick();
        let mut buf = [0u8; 4096];
        let n = host.build_frame(1, &mut buf);
        host.seal();
        let ops = presence_entries(&buf[..n]);
        assert!(
            ops.is_none_or(|ops| sample_of(&ops, a).is_none()),
            "no re-relay before 1 s has passed"
        );
    }

    // Run past the 1 Hz floor (20 ticks at this fixture's 20 Hz default `TICK_RATE`).
    let mut second_hit = None;
    for _ in 0..20 {
        host.tick();
        let mut buf = [0u8; 4096];
        let n = host.build_frame(1, &mut buf);
        host.seal();
        if let Some(ops) = presence_entries(&buf[..n])
            && let Some(hit) = sample_of(&ops, a)
        {
            second_hit = Some(hit);
            break;
        }
    }
    let (second_age, second_sample) = second_hit.expect(">= 1 Hz re-relay must eventually fire");
    assert_eq!(second_sample, sample, "the re-relayed sample is unchanged");
    assert!(
        second_age > first_age,
        "age_ticks must grow across a re-relay: first {first_age}, second {second_age}"
    );

    // Disconnect: the very next frame for the other connection carries `Gone`.
    host.disconnect(0);
    host.tick();
    let mut buf = [0u8; 4096];
    let n = host.build_frame(1, &mut buf);
    let ops =
        presence_entries(&buf[..n]).expect("the disconnect frame must carry a Presence section");
    assert!(
        is_gone(&ops, a),
        "disconnect must produce Gone in the next frame"
    );
}
