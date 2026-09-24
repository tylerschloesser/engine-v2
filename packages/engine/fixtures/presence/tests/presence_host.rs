//! `oversize_dropped`, `world_cap_check_accepts_representable_extremes` (docs/plan/
//! 19-presence-channel.md Tests added, step 3, gate round 1 fix): `Host::on_uplink`'s own presence
//! decode checks.

use engine::bytes::SliceSink;
use engine::codec;
use engine::game::{Game, PlayerEvent, PlayerId, Presence as PresenceTrait, TickCx, Unknown};
use engine::host::Host;
use engine::presence::MAX_ENCODED_BYTES;
use engine::sim::WorldParams;
use engine::wire::UplinkWriter;
use engine::world::{PrototypeId, Registry, Tile, TilePos, WorldPos};
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

/// A `Presence` whose *genuinely valid, no-trailing-bytes* canonical encoding is always well over
/// [`MAX_ENCODED_BYTES`] (32): `pos`/`vel` cost at least 4 bytes even at zero (one-byte zigzag
/// varint each), `padding` is a fixed `[u8; 32]` array -- `serde`'s derive only implements
/// `Serialize`/`Deserialize` for array lengths up to 32 without an extra crate, the ceiling this
/// picks -- which postcard serializes as 32 raw bytes with no length prefix (a statically sized
/// element, unlike a `Vec`), so the whole thing is always >= 36 bytes. `fx_presence::
/// PlayerPresence` cannot play this role itself: its own worst-case encoding (extreme `i32`/`i16`
/// zigzag varints) tops out at 16 bytes, so no genuine encoding of it can ever reach 32 -- the
/// original `oversize_dropped` used 33 zero bytes that were never a valid `PlayerPresence` encoding
/// at all, so `decode_canonical`'s own "trailing bytes" rejection caught them independently of
/// `Host::on_uplink`'s explicit size gate, and removing that gate did not fail the test (found
/// during this gate round's own inject-fail-revert pass -- see this milestone's Deviations).
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
struct WidePresence {
    pos: [i32; 2],
    vel: [i16; 2],
    padding: [u8; 32],
}

impl PresenceTrait for WidePresence {
    fn pos(&self) -> WorldPos {
        WorldPos {
            x: self.pos[0],
            y: self.pos[1],
        }
    }
    fn vel(&self) -> [i32; 2] {
        [self.vel[0] as i32, self.vel[1] as i32]
    }
}

// A minimal `Game` shim, `Host<Self>`'s own generic parameter for `oversize_dropped` alone (never
// driven beyond `on_player`/`genesis`: no `apply`/`tick`/`admit` call in this file), the same
// pattern `crates/engine/src/presence.rs`'s and `client/texel.rs`'s own test modules use for the
// same reason -- `type Presence = WidePresence` is the only thing this file needs from it.
struct WideGen;
impl engine::worldgen::Worldgen for WideGen {
    type Params = ();
    const WORLDGEN_VERSION: u32 = 0;
    fn generate(_seed: u64, _params: &(), _chunk: engine::world::ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct WideReject;
impl From<Unknown> for WideReject {
    fn from(_: Unknown) -> Self {
        WideReject
    }
}
struct WideGame;
impl Game for WideGame {
    const SCHEMA_VERSION: u32 = 0;
    type Worldgen = WideGen;
    type Action = ();
    type Reject = WideReject;
    type Entity = ();
    type Player = ();
    type Global = ();
    type Presence = WidePresence;
    type Ui = ();
    type Client = ();
    fn register(_r: &mut Registry) {}
    fn prototype(_e: &()) -> PrototypeId {
        unimplemented!()
    }
    fn anchor(_e: &()) -> TilePos {
        unimplemented!()
    }
    fn genesis(_w: &mut dyn engine::game::WorldWrite<Self>) {}
    fn on_player(_w: &mut dyn engine::game::WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
    fn apply(
        _w: &mut dyn engine::game::WorldWrite<Self>,
        _who: PlayerId,
        _a: &(),
    ) -> Result<(), WideReject> {
        Ok(())
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

fn wide_host_with_joined_player() -> Host<WideGame> {
    let mut host = Host::<WideGame>::genesis_for_test(WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 262_144,
        max_modified_tiles: 1_048_576,
        max_action_growth: 4_096,
    });
    host.connect(0); // PlayerId(1)
    host.tick();
    host
}

/// Inject-fail-revert: this test's own branch is `Host::on_uplink`'s `raw.len() >
/// MAX_ENCODED_BYTES` arm. Inject: delete that check and call `decode_canonical` on `raw`
/// unconditionally. `wide` below is a *genuinely valid* 44-byte `WidePresence` encoding (no
/// trailing bytes), so with the check gone `decode_canonical` succeeds -- `presence_oversize` reads
/// 0 instead of 1 and `debug_presence` returns `Some` instead of `None`, failing both assertions.
/// Revert: restore the explicit `raw.len() > MAX_ENCODED_BYTES` gate.
#[test]
fn oversize_dropped() {
    let mut host = wide_host_with_joined_player();
    let wide = WidePresence {
        pos: [0, 0],
        vel: [0, 0],
        padding: [0u8; 32],
    };
    let mut sample_buf = [0u8; 64];
    let n = codec::encode(&wide, &mut sample_buf).unwrap();
    assert!(
        n > MAX_ENCODED_BYTES,
        "this proof needs a genuinely oversize encoding, got {n} bytes"
    );
    let mut buf = [0u8; 256];
    let n2 = uplink_with_presence_bytes(&mut buf, &sample_buf[..n]);
    host.on_uplink(0, &buf[..n2]).unwrap();
    assert_eq!(host.counters(0).unwrap().presence_oversize, 1);
    assert_eq!(
        host.debug_presence(PlayerId(1)),
        None,
        "an oversize sample must be dropped, not recorded"
    );
}

/// Companion to `oversize_dropped`: a well-formed, in-bounds sample is recorded and never counted.
/// Inject-fail-revert: change `<=` to `<` in `assert!(n <= MAX_ENCODED_BYTES)` below -- doesn't
/// fail (this sample is well under the cap either way); the real branch this test covers is
/// `Host::on_uplink`'s `else` arm (`decode_canonical` runs and succeeds): inject by swapping
/// `decode_canonical::<G::Presence>(raw).ok()` for `None` unconditionally in `host/mod.rs` --
/// `debug_presence` then reads `None` instead of `Some(sample)`, failing the last assertion; revert
/// restores the real decode call.
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

/// Was `outside_world_cap_dropped`; renamed (gate round 1 fix) to match what it actually asserts.
/// `Presence::pos()` returns `engine::world::WorldPos`, whose `i32` fields map 1:1 onto
/// `[TILE_MIN, TILE_MAX]` once floored to a tile (`docs/plan/07-world-model-core.md` Deviations:
/// "the raw i32 already covers [TILE_MIN, TILE_MAX] 1:1 ... so only a wider intermediate can be out
/// of range"; `i32::MIN`/`i32::MAX` map to exactly `TILE_MIN`/`TILE_MAX`). There is no `i32` bit
/// pattern a `WorldPos` can hold whose `.tile()` fails `in_range()`, so `Host::on_uplink`'s own
/// world-cap check (`sample.pos().tile().in_range()`) cannot reject any legitimately-encoded
/// sample -- this test cannot fail on a drop path by construction (no inject-fail-revert is
/// possible for the reject arm: there is no byte pattern that reaches it). It instead proves the
/// check accepts both representable extremes without falsely rejecting them; a real inject-fail
/// check on the *accept* arm: temporarily change `.in_range()` to `false` unconditionally --
/// `debug_presence` then reads `None` for both extremes instead of `Some(sample)`, failing;
/// reverting restores `.tile().in_range()`.
#[test]
fn world_cap_check_accepts_representable_extremes() {
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
