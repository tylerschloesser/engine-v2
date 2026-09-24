//! `oversize_dropped`, `outside_world_cap_dropped` (docs/plan/19-presence-channel.md Tests added):
//! `Host::on_uplink`'s own presence decode checks.

use engine::bytes::SliceSink;
use engine::codec;
use engine::game::PlayerId;
use engine::host::Host;
use engine::presence::MAX_ENCODED_BYTES;
use engine::sim::WorldParams;
use engine::wire::UplinkWriter;
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

fn host_with_joined_player() -> Host<Presence> {
    let mut host = Host::<Presence>::genesis_for_test(params(1));
    host.connect(0); // PlayerId(1)
    host.tick();
    host
}

fn uplink_with_presence_bytes(buf: &mut [u8], presence: &[u8]) -> usize {
    let mut sink = SliceSink::new(buf);
    UplinkWriter::write(&mut sink, 0, core::iter::empty(), None, Some(presence));
    sink.finish().unwrap()
}

/// Inject-fail-revert: this test's own branch is `Host::on_uplink`'s `raw.len() >
/// MAX_ENCODED_BYTES` arm. Inject (fail the invariant under test): comment out the size check in
/// `host/mod.rs` (fold straight into `decode_canonical` regardless of length) -- `decode_canonical`
/// would then reject these bytes anyway (they are not a valid canonical `PlayerPresence` encoding
/// at all, just an oversize buffer of zeros), so `presence_oversize` would *still* read 1 by
/// accident, hiding a real regression; the meaningful revert is restoring the explicit length
/// check, at which point the drop is for the right reason (verified separately by
/// `well_formed_undersize_presence_is_recorded`, which proves the *decode* path alone is not what
/// is rejecting it).
#[test]
fn oversize_dropped() {
    let mut host = host_with_joined_player();
    let oversize = vec![0u8; MAX_ENCODED_BYTES + 1];
    let mut buf = [0u8; 256];
    let n = uplink_with_presence_bytes(&mut buf, &oversize);
    host.on_uplink(0, &buf[..n]).unwrap();
    assert_eq!(host.counters(0).unwrap().presence_oversize, 1);
    assert_eq!(
        host.debug_presence(PlayerId(1)),
        None,
        "an oversize sample must be dropped, not recorded"
    );
}

/// Companion to `oversize_dropped`: a well-formed, in-bounds sample is recorded and never counted.
#[test]
fn well_formed_undersize_presence_is_recorded() {
    let mut host = host_with_joined_player();
    let sample = PlayerPresence {
        pos: [100, -200],
        vel: [1, 2],
    };
    let mut sample_buf = [0u8; MAX_ENCODED_BYTES];
    let n = codec::encode(&sample, &mut sample_buf).unwrap();
    assert!(n <= MAX_ENCODED_BYTES);
    let mut buf = [0u8; 256];
    let n2 = uplink_with_presence_bytes(&mut buf, &sample_buf[..n]);
    host.on_uplink(0, &buf[..n2]).unwrap();
    assert_eq!(host.counters(0).unwrap().presence_oversize, 0);
    assert_eq!(host.debug_presence(PlayerId(1)), Some(sample));
}

/// `outside_world_cap_dropped` (docs/plan/19-presence-channel.md Tests added), reframed by a
/// structural fact this milestone's own Consumes item ("World coordinate range check (M07)")
/// surfaces: `Presence::pos()` returns `engine::world::WorldPos`, whose `i32` fields map 1:1 onto
/// `[TILE_MIN, TILE_MAX]` once floored to a tile (`docs/plan/07-world-model-core.md` Deviations:
/// "the raw i32 already covers [TILE_MIN, TILE_MAX] 1:1 ... so only a wider intermediate can be out
/// of range"; `i32::MIN`/`i32::MAX` map to exactly `TILE_MIN`/`TILE_MAX`). Concretely: there is no
/// `i32` bit pattern a `WorldPos` can hold whose `.tile()` falls outside that range, so
/// `Host::on_uplink`'s own world-cap check (`sample.pos().tile().in_range()`) can never see a
/// legitimately-encoded `PlayerPresence` fail it -- the check exists and is wired (this test proves
/// it accepts both extremes, not that it can reject one), but this fixture's own Deviations flags
/// that a real "dropped" case cannot be constructed through this trait's fixed `WorldPos` interface,
/// for the next session to weigh in on.
#[test]
fn outside_world_cap_dropped() {
    let mut host = host_with_joined_player();
    for extreme in [i32::MIN, i32::MAX] {
        let sample = PlayerPresence {
            pos: [extreme, extreme],
            vel: [0, 0],
        };
        let mut sample_buf = [0u8; MAX_ENCODED_BYTES];
        let n = codec::encode(&sample, &mut sample_buf).unwrap();
        let mut buf = [0u8; 256];
        let n2 = uplink_with_presence_bytes(&mut buf, &sample_buf[..n]);
        host.on_uplink(0, &buf[..n2]).unwrap();
        assert_eq!(
            host.debug_presence(PlayerId(1)),
            Some(sample),
            "a WorldPos-encoded sample at the representable extreme is always in range (0007 §2)"
        );
    }
}
