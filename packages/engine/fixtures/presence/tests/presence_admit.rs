//! `admit_witness`, `presence_is_not_state` (docs/plan/19-presence-channel.md Tests added, step
//! 3): goes through the real pipeline (`Host::on_uplink` -> decode presence -> `G::admit`) rather
//! than calling `fx_presence::Presence::admit` directly, so "an admit rejection leaves the sealed
//! frame's records unchanged" is a real end-to-end property, not an assumption about `Sim::step`
//! (which never calls `admit` at all -- only `Host::on_uplink` does, 0001 Decision "Witness-carrying
//! actions" step 1: "host only, not replayed"). `apply_range_is_replayable`, step 1's own test that
//! needs no `Host` at all, lives in `tests/presence_apply.rs`.

use engine::bytes::SliceSink;
use engine::codec;
use engine::game::{PlayerId, WorldRead as _};
use engine::host::Host;
use engine::sim::WorldParams;
use engine::wire::UplinkWriter;
use fx_presence::{Action, PlayerPresence, Presence, TileXY, WorldXY};

fn params(seed: u64) -> WorldParams<Presence> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities: 262_144,
        max_modified_tiles: 1_048_576,
        max_action_growth: 4_096,
    }
}

/// One uplink batch: `seq` 1, optionally a presence sample, always the same `Poke` witness
/// (`tile`/`from` both the origin -- inside `apply`'s own `POKE_RANGE_TILES`, so the only thing
/// under test is whether `admit` lets it through at all).
fn uplink_bytes(buf: &mut [u8], presence: Option<PlayerPresence>) -> usize {
    let action = Action::Poke {
        tile: TileXY { x: 0, y: 0 },
        from: WorldXY { x: 0, y: 0 },
    };
    let mut action_buf = [0u8; 64];
    let n = codec::encode(&action, &mut action_buf).unwrap();
    let mut presence_buf = [0u8; 32];
    let presence_bytes = presence.map(|p| {
        let n = codec::encode(&p, &mut presence_buf).unwrap();
        &presence_buf[..n]
    });
    let mut sink = SliceSink::new(buf);
    UplinkWriter::write(
        &mut sink,
        0,
        core::iter::once((1u32, action_buf[..n].as_ref())),
        None,
        presence_bytes,
    );
    sink.finish().unwrap()
}

fn host_with_joined_player() -> Host<Presence> {
    let mut host = Host::<Presence>::genesis_for_test(params(1));
    host.connect(0); // PlayerId(1)
    host.tick(); // delivers `Joined` -> `Presence::on_player` puts a default `Player`
    host
}

#[test]
fn admit_witness_no_sample_is_rejected() {
    let mut host = host_with_joined_player();
    let mut buf = [0u8; 256];
    let n = uplink_bytes(&mut buf, None); // no presence at all: `PresenceTable::get` -> `None`
    host.on_uplink(0, &buf[..n]).unwrap();
    host.tick();
    // Rejected at admission: never reached `pending_records`, so `apply` never ran and the
    // player's `poke_count` is still the `Default` value, 0 (the sealed frame's records are
    // unchanged).
    let sim = host.sim().unwrap();
    assert_eq!(sim.authority().player(PlayerId(1)).unwrap().poke_count, 0);
}

#[test]
fn admit_witness_beyond_tolerance_is_rejected() {
    let mut host = host_with_joined_player();
    let mut buf = [0u8; 256];
    // 20 tiles away on one axis: beyond `ADMIT_TOLERANCE_TILES` (16).
    let n = uplink_bytes(
        &mut buf,
        Some(PlayerPresence {
            pos: [20 * 256, 0],
            vel: [0, 0],
        }),
    );
    host.on_uplink(0, &buf[..n]).unwrap();
    host.tick();
    let sim = host.sim().unwrap();
    assert_eq!(sim.authority().player(PlayerId(1)).unwrap().poke_count, 0);
}

#[test]
fn admit_witness_inside_tolerance_is_recorded_and_applied() {
    let mut host = host_with_joined_player();
    let mut buf = [0u8; 256];
    // At the origin, same as the witness `from`: trivially inside tolerance.
    let n = uplink_bytes(
        &mut buf,
        Some(PlayerPresence {
            pos: [0, 0],
            vel: [0, 0],
        }),
    );
    host.on_uplink(0, &buf[..n]).unwrap();
    host.tick();
    let sim = host.sim().unwrap();
    assert_eq!(sim.authority().player(PlayerId(1)).unwrap().poke_count, 1);
}

/// `presence_is_not_state`: two `Host`s tick the same number of times and admit the same one
/// witness-carrying action; only one of them also receives an ongoing stream of presence-only
/// uplinks (no actions) afterward. Equal `state_hash()` at the end proves presence traffic beyond
/// what a witness check needs leaves no trace in `Store` (0001 Consequences; the type system
/// argument is `apply`/`tick`'s own signatures, proven structurally by the compile-fail doc test on
/// `PresenceTable`, `crates/engine/src/presence.rs`).
#[test]
fn presence_is_not_state() {
    fn seed_and_poke(host: &mut Host<Presence>) {
        let mut buf = [0u8; 256];
        let n = uplink_bytes(
            &mut buf,
            Some(PlayerPresence {
                pos: [0, 0],
                vel: [0, 0],
            }),
        );
        host.on_uplink(0, &buf[..n]).unwrap();
        host.tick();
    }

    let mut with_presence = host_with_joined_player();
    let mut without_presence = host_with_joined_player();
    seed_and_poke(&mut with_presence);
    seed_and_poke(&mut without_presence);
    assert_eq!(
        with_presence
            .sim()
            .unwrap()
            .authority()
            .player(PlayerId(1))
            .unwrap()
            .poke_count,
        1,
        "both hosts must have actually admitted and applied the witness action identically"
    );

    // Only `with_presence` keeps receiving presence-only uplinks (no actions); both hosts tick the
    // same number of times regardless, so the tick counter itself cannot be the source of any
    // difference.
    for i in 0..20u32 {
        let mut buf = [0u8; 256];
        let n = uplink_bytes(
            &mut buf,
            Some(PlayerPresence {
                pos: [(i as i32) * 256, i as i32],
                vel: [1, -1],
            }),
        );
        // `uplink_bytes` always attaches the same `seq: 1` witness action too, which every call
        // after the first must dedup (`highest_admitted_seq`) rather than re-apply -- proving
        // presence churn alone cannot change `poke_count` a second time either.
        with_presence.on_uplink(0, &buf[..n]).unwrap();
        with_presence.tick();
        without_presence.tick();
    }

    assert_eq!(
        with_presence.sim().unwrap().state_hash(),
        without_presence.sim().unwrap().state_hash(),
        "presence traffic must never change the state hash"
    );
}
