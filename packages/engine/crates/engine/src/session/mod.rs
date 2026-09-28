//! Handshake codecs (docs/decisions/0013-sessions-and-integrity.md "Handshake";
//! docs/plan/28-sessions-and-reconnect.md steps 1-2): `Hello`, `Welcome`, `Reject`, `Bye`.
//!
//! `Hello`/`Reject` open with a **frozen prefix** (`magic u32 · protocol_version u16 · build_hash
//! [u8; 32]`, 38 bytes, layout never changes) whose first wire byte (`magic`'s low byte, since
//! every multi-byte field here is little-endian like the rest of `wire/`) is `>= 0x80` (0024 §8),
//! so it can never collide with a post-handshake [`crate::wire::MsgType`] byte (`0x01..=0x05`
//! reserved, `0x06..=0x7F` free). `Welcome`/`Bye` are ordinary post-handshake messages and open
//! with their own reserved `MsgType` byte (`Welcome = 0x03`, `Bye = 0x05`, both reserved by M14).
//!
//! Byte layouts (single home, like `wire/CLAUDE.md`):
//! - `Hello = magic·protocol_version·build_hash · join_key (varint len + utf8) ·
//!   player_secret [u8; 16] · CameraReport (16 B) · resume_present u8 · resume?{epoch u32 ·
//!   last_tick u32 · n varint x (dx i16, dy i16, version u32)}`.
//! - `Welcome = MsgType::Welcome · player_id varint · epoch u32 · tick u32 · tick_rate_hz u32 ·
//!   seed u64 · params (varint len + `Codec`-encoded `Worldgen::Params`) · view_max_tiles_per_axis
//!   u16 · view_max_chunks u16 · last_processed_action_seq varint · presence_present u8 ·
//!   presence?{Codec G::Presence, no length prefix: the last field, so the codec's own decode
//!   boundary is exact, same convention `wire::global::read_own_player` uses}`.
//! - `Reject = magic·protocol_version · reason u8 (0 VersionMismatch, 1 BadKey, 2 Full) ·
//!   server build_hash [u8; 32]` -- frozen, exactly 0013's own layout.
//! - `Bye = MsgType::Bye · reason u8 (0 Leave, 1 Superseded)`.

use crate::bytes::{ByteReader, ByteSink};
use crate::codec;
use crate::game::{Game, PlayerId};
use crate::wire::{CameraReport, MsgType, WireError};
use crate::worldgen::Worldgen;

mod resume;
pub use resume::{HintDiff, build_resume_hint, diff_resume_hint};

/// `PROTOCOL_VERSION = 1` (Scope): covers only the frozen prefixes (0013 "Build-hash handshake").
pub const PROTOCOL_VERSION: u16 = 1;

/// Spells `\x80ENG` in wire (little-endian) order: `u32::from_le_bytes([0x80, b'E', b'N', b'G'])`.
/// Low byte `0x80` satisfies 0024 §8's "first wire byte is `>= 0x80`" constraint.
pub const MAGIC: u32 = 0x474E_4580;

pub const BUILD_HASH_LEN: usize = 32;
pub const SECRET_LEN: usize = 16;
/// 0013 "Reconnect is the same path plus the resume hint": at most 128 chunk hints.
pub const MAX_RESUME_CHUNKS: usize = 128;

/// [`Reject`]'s reason byte (0013's own three: `VersionMismatch | BadKey | Full`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum RejectReason {
    VersionMismatch = 0,
    BadKey = 1,
    Full = 2,
}

impl RejectReason {
    fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::VersionMismatch,
            1 => Self::BadKey,
            2 => Self::Full,
            _ => return None,
        })
    }
}

/// [`Bye`]'s reason byte (Scope: `Bye { reason: Leave | Superseded }`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum ByeReason {
    Leave = 0,
    Superseded = 1,
}

impl ByeReason {
    fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::Leave,
            1 => Self::Superseded,
            _ => return None,
        })
    }
}

/// One resume hint entry (0013): a chunk coordinate relative to the view centre, plus the
/// version the client already holds for it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ResumeChunkHint {
    pub dx: i16,
    pub dy: i16,
    pub version: u32,
}

/// 0013's `resume?` block: absent on a plain join.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResumeHint {
    pub epoch: u32,
    pub last_tick: u32,
    pub chunks: Vec<ResumeChunkHint>,
}

/// The full `Hello` payload. `join_key`/`player_secret` are borrowed (the writer's own bytes);
/// `resume` is `None` on a plain join.
pub struct Hello<'a> {
    pub protocol_version: u16,
    pub build_hash: [u8; BUILD_HASH_LEN],
    pub join_key: &'a [u8],
    pub player_secret: [u8; SECRET_LEN],
    pub camera: CameraReport,
    pub resume: Option<&'a ResumeHint>,
}

/// [`Hello`] decoded back out: `resume`, if present, is owned (a `Vec`, decode-side only -- this
/// milestone ignores it, see the Seam note on `sim_attach`'s own input region; M28b is the first
/// real reader).
#[derive(Debug, PartialEq)]
pub struct HelloOwned {
    pub protocol_version: u16,
    pub build_hash: [u8; BUILD_HASH_LEN],
    pub join_key: Vec<u8>,
    pub player_secret: [u8; SECRET_LEN],
    pub camera: CameraReport,
    pub resume: Option<ResumeHint>,
}

/// `CameraReport::write` takes `&mut impl ByteSink` (not `?Sized`, `wire/uplink.rs`), so it cannot
/// be called with the `&mut dyn ByteSink` this module's own `?Sized`-widened writers pass around
/// (`wire/mod.rs` Deviations: "every writer function's sink parameter is `&mut (impl ByteSink +
/// ?Sized)`"). Inlined here rather than widening `CameraReport::write` itself (outside this
/// milestone's Scope, and `wire::CameraReport`'s own six-field `put_i32`/`put_u16`/`put` sequence
/// is small enough to duplicate once).
fn write_camera_report(sink: &mut (impl ByteSink + ?Sized), c: &CameraReport) {
    sink.put_i32(c.center_x);
    sink.put_i32(c.center_y);
    sink.put_u16(c.half_w);
    sink.put_u16(c.half_h);
    sink.put(&c.vel_x.to_le_bytes());
    sink.put(&c.vel_y.to_le_bytes());
}

fn read_varint_len(r: &mut ByteReader<'_>) -> Result<usize, WireError> {
    let v = r.varint().map_err(WireError::from)?;
    usize::try_from(v).map_err(|_| WireError::Malformed)
}

pub fn write_hello(sink: &mut (impl ByteSink + ?Sized), hello: &Hello<'_>) {
    sink.put_u32(MAGIC);
    sink.put_u16(hello.protocol_version);
    sink.put(&hello.build_hash);
    sink.put_varint(hello.join_key.len() as u64);
    sink.put(hello.join_key);
    sink.put(&hello.player_secret);
    write_camera_report(sink, &hello.camera);
    match hello.resume {
        None => sink.put_u8(0),
        Some(resume) => {
            sink.put_u8(1);
            sink.put_u32(resume.epoch);
            sink.put_u32(resume.last_tick);
            sink.put_varint(resume.chunks.len() as u64);
            for c in &resume.chunks {
                sink.put(&c.dx.to_le_bytes());
                sink.put(&c.dy.to_le_bytes());
                sink.put_u32(c.version);
            }
        }
    }
}

pub fn read_hello(buf: &[u8]) -> Result<HelloOwned, WireError> {
    let mut r = ByteReader::new(buf);
    let magic = r.u32().map_err(WireError::from)?;
    if magic != MAGIC {
        return Err(WireError::Malformed);
    }
    let protocol_version = r.u16().map_err(WireError::from)?;
    let build_hash: [u8; BUILD_HASH_LEN] = r
        .bytes(BUILD_HASH_LEN)
        .map_err(WireError::from)?
        .try_into()
        .map_err(|_| WireError::Malformed)?;
    let join_key_len = read_varint_len(&mut r)?;
    let join_key = r.bytes(join_key_len).map_err(WireError::from)?.to_vec();
    let player_secret: [u8; SECRET_LEN] = r
        .bytes(SECRET_LEN)
        .map_err(WireError::from)?
        .try_into()
        .map_err(|_| WireError::Malformed)?;
    let camera = CameraReport::read(&mut r)?;
    let resume_present = r.u8().map_err(WireError::from)?;
    let resume = match resume_present {
        0 => None,
        1 => {
            let epoch = r.u32().map_err(WireError::from)?;
            let last_tick = r.u32().map_err(WireError::from)?;
            let n = read_varint_len(&mut r)?;
            if n > MAX_RESUME_CHUNKS {
                return Err(WireError::Malformed);
            }
            let mut chunks = Vec::with_capacity(n);
            for _ in 0..n {
                let dx = i16::from_le_bytes(
                    r.bytes(2)
                        .map_err(WireError::from)?
                        .try_into()
                        .map_err(|_| WireError::Malformed)?,
                );
                let dy = i16::from_le_bytes(
                    r.bytes(2)
                        .map_err(WireError::from)?
                        .try_into()
                        .map_err(|_| WireError::Malformed)?,
                );
                let version = r.u32().map_err(WireError::from)?;
                chunks.push(ResumeChunkHint { dx, dy, version });
            }
            Some(ResumeHint {
                epoch,
                last_tick,
                chunks,
            })
        }
        _ => return Err(WireError::Malformed),
    };
    Ok(HelloOwned {
        protocol_version,
        build_hash,
        join_key,
        player_secret,
        camera,
        resume,
    })
}

/// `Reject` (0013, frozen: "layout never changes"). Built in TS ([`crate::session`]'s own Scope
/// note: "it must not depend on the instance"); this Rust side exists so the golden-byte test can
/// prove TS builder and Rust parser agree byte for byte.
#[derive(Debug, PartialEq)]
pub struct Reject {
    pub protocol_version: u16,
    pub reason: RejectReason,
    pub build_hash: [u8; BUILD_HASH_LEN],
}

pub fn write_reject(sink: &mut (impl ByteSink + ?Sized), reject: &Reject) {
    sink.put_u32(MAGIC);
    sink.put_u16(reject.protocol_version);
    sink.put_u8(reject.reason as u8);
    sink.put(&reject.build_hash);
}

pub fn read_reject(buf: &[u8]) -> Result<Reject, WireError> {
    let mut r = ByteReader::new(buf);
    let magic = r.u32().map_err(WireError::from)?;
    if magic != MAGIC {
        return Err(WireError::Malformed);
    }
    let protocol_version = r.u16().map_err(WireError::from)?;
    let reason =
        RejectReason::from_u8(r.u8().map_err(WireError::from)?).ok_or(WireError::Malformed)?;
    let build_hash: [u8; BUILD_HASH_LEN] = r
        .bytes(BUILD_HASH_LEN)
        .map_err(WireError::from)?
        .try_into()
        .map_err(|_| WireError::Malformed)?;
    Ok(Reject {
        protocol_version,
        reason,
        build_hash,
    })
}

/// `Bye { reason: Leave | Superseded }` (Scope). Opens with the already-reserved
/// [`MsgType::Bye`] byte, unlike `Hello`/`Reject`'s own frozen-magic framing.
#[derive(Debug, PartialEq)]
pub struct Bye {
    pub reason: ByeReason,
}

pub fn write_bye(sink: &mut (impl ByteSink + ?Sized), bye: &Bye) {
    sink.put_u8(MsgType::Bye as u8);
    sink.put_u8(bye.reason as u8);
}

pub fn read_bye(buf: &[u8]) -> Result<Bye, WireError> {
    let mut r = ByteReader::new(buf);
    let msg_type = r.u8().map_err(WireError::from)?;
    if msg_type != MsgType::Bye as u8 {
        return Err(WireError::Malformed);
    }
    let reason =
        ByeReason::from_u8(r.u8().map_err(WireError::from)?).ok_or(WireError::Malformed)?;
    Ok(Bye { reason })
}

/// `Welcome` (0013): `{ player_id, epoch, tick, tick_rate, world seed + params, view clamps,
/// last_processed_action_seq, last presence sample }`. Generic over `G` for `G::Worldgen::Params`
/// and `G::Presence`, the same way every other game-typed wire codec here is.
pub struct Welcome<'a, G: Game> {
    pub player_id: PlayerId,
    pub epoch: u32,
    pub tick: u32,
    pub tick_rate_hz: u32,
    pub seed: u64,
    pub params: &'a <G::Worldgen as Worldgen>::Params,
    pub view_max_tiles_per_axis: u16,
    pub view_max_chunks: u16,
    pub last_processed_action_seq: u32,
    pub presence: Option<&'a G::Presence>,
}

/// No `derive(Debug, PartialEq)`: `G::Worldgen::Params`/`G::Presence` are only guaranteed
/// `Serialize + DeserializeOwned` (`Worldgen::Params`'s own bound), not `Debug`/`PartialEq` --
/// tests compare individual fields instead.
pub struct WelcomeOwned<G: Game> {
    pub player_id: PlayerId,
    pub epoch: u32,
    pub tick: u32,
    pub tick_rate_hz: u32,
    pub seed: u64,
    pub params: <G::Worldgen as Worldgen>::Params,
    pub view_max_tiles_per_axis: u16,
    pub view_max_chunks: u16,
    pub last_processed_action_seq: u32,
    pub presence: Option<G::Presence>,
}

pub fn write_welcome<G: Game>(sink: &mut (impl ByteSink + ?Sized), welcome: &Welcome<'_, G>) {
    sink.put_u8(MsgType::Welcome as u8);
    sink.put_varint(welcome.player_id.0 as u64);
    sink.put_u32(welcome.epoch);
    sink.put_u32(welcome.tick);
    sink.put_u32(welcome.tick_rate_hz);
    sink.put_u64(welcome.seed);
    let params_len = codec::encoded_len(welcome.params);
    sink.put_varint(params_len as u64);
    codec::encode_to(welcome.params, sink)
        .expect("Welcome params encode is infallible for a ?Sized sink");
    sink.put_u16(welcome.view_max_tiles_per_axis);
    sink.put_u16(welcome.view_max_chunks);
    sink.put_varint(welcome.last_processed_action_seq as u64);
    match welcome.presence {
        None => sink.put_u8(0),
        Some(p) => {
            sink.put_u8(1);
            codec::encode_to(p, sink)
                .expect("Welcome presence encode is infallible for a ?Sized sink");
        }
    }
}

pub fn read_welcome<G: Game>(buf: &[u8]) -> Result<WelcomeOwned<G>, WireError> {
    let mut r = ByteReader::new(buf);
    let msg_type = r.u8().map_err(WireError::from)?;
    if msg_type != MsgType::Welcome as u8 {
        return Err(WireError::Malformed);
    }
    let player_id = PlayerId(
        u32::try_from(r.varint().map_err(WireError::from)?).map_err(|_| WireError::Malformed)?,
    );
    let epoch = r.u32().map_err(WireError::from)?;
    let tick = r.u32().map_err(WireError::from)?;
    let tick_rate_hz = r.u32().map_err(WireError::from)?;
    let seed = r.u64().map_err(WireError::from)?;
    let params_len = read_varint_len(&mut r)?;
    let params_bytes = r.bytes(params_len).map_err(WireError::from)?;
    let params = codec::decode::<<G::Worldgen as Worldgen>::Params>(params_bytes)
        .map_err(|_| WireError::Malformed)?
        .0;
    let view_max_tiles_per_axis = r.u16().map_err(WireError::from)?;
    let view_max_chunks = r.u16().map_err(WireError::from)?;
    let last_processed_action_seq =
        u32::try_from(r.varint().map_err(WireError::from)?).map_err(|_| WireError::Malformed)?;
    let presence_present = r.u8().map_err(WireError::from)?;
    let presence = match presence_present {
        0 => None,
        1 => Some(
            codec::decode::<G::Presence>(r.rest())
                .map_err(|_| WireError::Malformed)?
                .0,
        ),
        _ => return Err(WireError::Malformed),
    };
    Ok(WelcomeOwned {
        player_id,
        epoch,
        tick,
        tick_rate_hz,
        seed,
        params,
        view_max_tiles_per_axis,
        view_max_chunks,
        last_processed_action_seq,
        presence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;
    use crate::game::{PlayerEvent, TickCx, Unknown, WorldWrite};
    use crate::world::{ChunkCoord, PrototypeId, Registry, Tile, TilePos, WorldPos};

    #[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct SPresence {
        x: i32,
        y: i32,
    }
    impl crate::presence::Presence for SPresence {
        fn pos(&self) -> WorldPos {
            WorldPos {
                x: self.x,
                y: self.y,
            }
        }
        fn vel(&self) -> [i32; 2] {
            [0, 0]
        }
    }

    struct SGen;
    impl Worldgen for SGen {
        type Params = u32;
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &u32, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct SReject;
    impl From<Unknown> for SReject {
        fn from(_: Unknown) -> Self {
            SReject
        }
    }
    struct SGame;
    impl Game for SGame {
        const SCHEMA_VERSION: u32 = 0;
        type Worldgen = SGen;
        type Action = ();
        type Reject = SReject;
        type Entity = ();
        type Player = ();
        type Global = ();
        type Presence = SPresence;
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &()) -> PrototypeId {
            unimplemented!()
        }
        fn anchor(_e: &()) -> TilePos {
            unimplemented!()
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), SReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn camera() -> CameraReport {
        CameraReport {
            center_x: 100,
            center_y: -200,
            half_w: 16,
            half_h: 9,
            vel_x: 1,
            vel_y: -1,
        }
    }

    #[test]
    fn hello_roundtrips_with_resume() {
        let resume = ResumeHint {
            epoch: 4,
            last_tick: 9000,
            chunks: vec![
                ResumeChunkHint {
                    dx: -1,
                    dy: 2,
                    version: 7,
                },
                ResumeChunkHint {
                    dx: 0,
                    dy: 0,
                    version: 1,
                },
            ],
        };
        let hello = Hello {
            protocol_version: PROTOCOL_VERSION,
            build_hash: [7u8; BUILD_HASH_LEN],
            join_key: b"open-sesame",
            player_secret: [9u8; SECRET_LEN],
            camera: camera(),
            resume: Some(&resume),
        };
        let mut buf = vec![0u8; 512];
        let mut sink = SliceSink::new(&mut buf);
        write_hello(&mut sink, &hello);
        let n = sink.finish().unwrap();
        let got = read_hello(&buf[..n]).unwrap();
        assert_eq!(got.protocol_version, PROTOCOL_VERSION);
        assert_eq!(got.build_hash, [7u8; BUILD_HASH_LEN]);
        assert_eq!(got.join_key, b"open-sesame");
        assert_eq!(got.player_secret, [9u8; SECRET_LEN]);
        assert_eq!(got.camera, camera());
        assert_eq!(got.resume, Some(resume));
    }

    #[test]
    fn hello_roundtrips_without_resume() {
        let hello = Hello {
            protocol_version: PROTOCOL_VERSION,
            build_hash: [1u8; BUILD_HASH_LEN],
            join_key: b"",
            player_secret: [0u8; SECRET_LEN],
            camera: camera(),
            resume: None,
        };
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        write_hello(&mut sink, &hello);
        let n = sink.finish().unwrap();
        let got = read_hello(&buf[..n]).unwrap();
        assert_eq!(got.resume, None);
        assert_eq!(got.join_key, Vec::<u8>::new());
    }

    #[test]
    fn hello_rejects_bad_magic() {
        let buf = [0u8; 64];
        assert_eq!(read_hello(&buf), Err(WireError::Malformed));
    }

    #[test]
    fn golden_hello() {
        let resume = ResumeHint {
            epoch: 2,
            last_tick: 555,
            chunks: vec![ResumeChunkHint {
                dx: 3,
                dy: -4,
                version: 11,
            }],
        };
        let hello = Hello {
            protocol_version: PROTOCOL_VERSION,
            build_hash: {
                let mut h = [0u8; BUILD_HASH_LEN];
                for (i, b) in h.iter_mut().enumerate() {
                    *b = i as u8;
                }
                h
            },
            join_key: b"k",
            player_secret: [3u8; SECRET_LEN],
            camera: camera(),
            resume: Some(&resume),
        };
        let mut buf = vec![0u8; 512];
        let mut sink = SliceSink::new(&mut buf);
        write_hello(&mut sink, &hello);
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("session_hello", &buf[..n]);
    }

    #[test]
    fn reject_roundtrips() {
        let reject = Reject {
            protocol_version: PROTOCOL_VERSION,
            reason: RejectReason::BadKey,
            build_hash: [5u8; BUILD_HASH_LEN],
        };
        let mut buf = vec![0u8; 64];
        let mut sink = SliceSink::new(&mut buf);
        write_reject(&mut sink, &reject);
        let n = sink.finish().unwrap();
        let got = read_reject(&buf[..n]).unwrap();
        assert_eq!(got.protocol_version, PROTOCOL_VERSION);
        assert_eq!(got.reason, RejectReason::BadKey);
        assert_eq!(got.build_hash, [5u8; BUILD_HASH_LEN]);
    }

    #[test]
    fn reject_rejects_bad_magic() {
        let buf = [0u8; 64];
        assert_eq!(read_reject(&buf), Err(WireError::Malformed));
    }

    /// `golden-reject`: this exact byte sequence is also produced by the TS builder
    /// (`src/host/handshake.ts`'s `buildReject`) and checked byte-identical against the same
    /// `.hex` file in `handshake.test.ts` (`reject bytes match the Rust golden`) -- the milestone's
    /// own "Reject golden bytes are identical from the TS builder and the Rust parser" criterion.
    #[test]
    fn golden_reject() {
        let reject = Reject {
            protocol_version: PROTOCOL_VERSION,
            reason: RejectReason::VersionMismatch,
            build_hash: {
                let mut h = [0u8; BUILD_HASH_LEN];
                for (i, b) in h.iter_mut().enumerate() {
                    *b = (i * 3) as u8;
                }
                h
            },
        };
        let mut buf = vec![0u8; 64];
        let mut sink = SliceSink::new(&mut buf);
        write_reject(&mut sink, &reject);
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("session_reject", &buf[..n]);
    }

    #[test]
    fn bye_roundtrips() {
        let mut buf = vec![0u8; 8];
        let mut sink = SliceSink::new(&mut buf);
        write_bye(
            &mut sink,
            &Bye {
                reason: ByeReason::Superseded,
            },
        );
        let n = sink.finish().unwrap();
        let got = read_bye(&buf[..n]).unwrap();
        assert_eq!(got.reason, ByeReason::Superseded);
    }

    #[test]
    fn golden_bye() {
        let mut buf = vec![0u8; 8];
        let mut sink = SliceSink::new(&mut buf);
        write_bye(
            &mut sink,
            &Bye {
                reason: ByeReason::Leave,
            },
        );
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("session_bye", &buf[..n]);
    }

    #[test]
    fn welcome_roundtrips_with_presence() {
        let presence = SPresence { x: 42, y: -7 };
        let params: u32 = 12345;
        let welcome = Welcome::<SGame> {
            player_id: PlayerId(3),
            epoch: 2,
            tick: 900,
            tick_rate_hz: 20,
            seed: 0xDEAD_BEEF_0000_0001,
            params: &params,
            view_max_tiles_per_axis: 256,
            view_max_chunks: 128,
            last_processed_action_seq: 77,
            presence: Some(&presence),
        };
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        write_welcome::<SGame>(&mut sink, &welcome);
        let n = sink.finish().unwrap();
        let got = read_welcome::<SGame>(&buf[..n]).unwrap();
        assert_eq!(got.player_id, PlayerId(3));
        assert_eq!(got.epoch, 2);
        assert_eq!(got.tick, 900);
        assert_eq!(got.tick_rate_hz, 20);
        assert_eq!(got.seed, 0xDEAD_BEEF_0000_0001);
        assert_eq!(got.params, 12345);
        assert_eq!(got.view_max_tiles_per_axis, 256);
        assert_eq!(got.view_max_chunks, 128);
        assert_eq!(got.last_processed_action_seq, 77);
        assert_eq!(got.presence, Some(presence));
    }

    #[test]
    fn welcome_roundtrips_without_presence() {
        let params: u32 = 1;
        let welcome = Welcome::<SGame> {
            player_id: PlayerId(1),
            epoch: 0,
            tick: 0,
            tick_rate_hz: 20,
            seed: 1,
            params: &params,
            view_max_tiles_per_axis: 256,
            view_max_chunks: 128,
            last_processed_action_seq: 0,
            presence: None,
        };
        let mut buf = vec![0u8; 128];
        let mut sink = SliceSink::new(&mut buf);
        write_welcome::<SGame>(&mut sink, &welcome);
        let n = sink.finish().unwrap();
        let got = read_welcome::<SGame>(&buf[..n]).unwrap();
        assert_eq!(got.presence, None);
    }

    #[test]
    fn golden_welcome() {
        let presence = SPresence { x: 1, y: 2 };
        let params: u32 = 99;
        let welcome = Welcome::<SGame> {
            player_id: PlayerId(5),
            epoch: 1,
            tick: 123,
            tick_rate_hz: 20,
            seed: 7,
            params: &params,
            view_max_tiles_per_axis: 256,
            view_max_chunks: 128,
            last_processed_action_seq: 4,
            presence: Some(&presence),
        };
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        write_welcome::<SGame>(&mut sink, &welcome);
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("session_welcome", &buf[..n]);
    }
}
