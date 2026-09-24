//! `Presence` section (id 8, `wire/CLAUDE.md`; docs/plan/19-presence-channel.md Provides): a flat
//! list of entries running to the section body's own end -- no leading count, the same convention
//! `deltas.rs`'s own entity-op list uses (the section's own length, from `FrameReader`, bounds it).
//! Entries are in ascending `PlayerId` (the caller's own responsibility: `host::mod`'s
//! `Host::build_frame` merges the relay and `Gone` sets before writing). Each entry: `who varint`
//! · `tag u8` (`0` = `Sample`, `1` = `Gone`); a `Sample` continues with `age_ticks varint` then a
//! `Codec G::Presence` payload with no length prefix of its own (`wire/mod.rs`'s own module doc
//! comment: a `Codec` value's decode boundary is exact, so a reader advances past exactly the
//! bytes `codec::decode` consumed).
//!
//! `host::mod` does not call [`write_presence`] directly on its own hot path: `Host::build_frame`
//! writes the identical byte shape from its own flat, already-sorted scratch buffer through a
//! hand-written `write_presence_flat` (that module's own Deviations, mirroring `write_chunk_
//! deltas_flat`'s existing precedent) to avoid building a temporary `Vec<PresenceOp>` every tick.
//! [`write_presence`]/[`read_presence`] are the shared, tested definition of that byte shape --
//! exercised directly by this module's own roundtrip and golden tests, and by the client's real
//! decode path ([`read_presence`], `client::core::ClientCore::apply`).

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::{self, encode_to};
use crate::game::{Game, PlayerId};

use super::{WireError, varint_u32};

/// One relayed presence entry to write (borrowed: the writer never needs ownership).
pub enum PresenceOp<'a, G: Game> {
    Sample {
        who: PlayerId,
        age_ticks: u32,
        sample: &'a G::Presence,
    },
    Gone {
        who: PlayerId,
    },
}

/// One presence entry as decoded (owned: `codec::decode` produces an owned value).
pub enum PresenceDeltaOp<G: Game> {
    Sample {
        who: PlayerId,
        age_ticks: u32,
        sample: G::Presence,
    },
    Gone {
        who: PlayerId,
    },
}

/// `ops`: entries in ascending `PlayerId`, the caller's own invariant (not checked here, the same
/// trust level `write_chunk_deltas` extends its own caller for chunk-group ordering).
pub fn write_presence<G: Game>(sink: &mut (impl ByteSink + ?Sized), ops: &[PresenceOp<'_, G>]) {
    for op in ops {
        match op {
            PresenceOp::Sample {
                who,
                age_ticks,
                sample,
            } => {
                sink.put_varint(who.0 as u64);
                sink.put_u8(0);
                sink.put_varint(*age_ticks as u64);
                encode_to(*sample, sink)
                    .expect("encoding a presence sample into a ByteSink cannot fail");
            }
            PresenceOp::Gone { who } => {
                sink.put_varint(who.0 as u64);
                sink.put_u8(1);
            }
        }
    }
}

/// Reads a `Presence` section body written by [`write_presence`] (or `host::mod`'s byte-identical
/// `write_presence_flat`). `on_op` fires once per entry, in wire order.
pub fn read_presence<G: Game>(
    r: &mut ByteReader,
    mut on_op: impl FnMut(PresenceDeltaOp<G>),
) -> Result<(), WireError> {
    while !r.rest().is_empty() {
        let who = PlayerId(varint_u32(r)?);
        let tag = r.u8().map_err(WireError::from)?;
        match tag {
            0 => {
                let age_ticks = varint_u32(r)?;
                let bytes = r.rest();
                let (sample, rest) =
                    codec::decode::<G::Presence>(bytes).map_err(WireError::from)?;
                let consumed = bytes.len() - rest.len();
                r.bytes(consumed).map_err(WireError::from)?;
                on_op(PresenceDeltaOp::Sample {
                    who,
                    age_ticks,
                    sample,
                });
            }
            1 => on_op(PresenceDeltaOp::Gone { who }),
            _ => return Err(WireError::Malformed),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;
    use crate::game::{PlayerEvent, TickCx, Unknown, WorldWrite};
    use crate::world::{ChunkCoord, PrototypeId, Registry, Tile, TilePos, WorldPos};
    use crate::worldgen::Worldgen;

    #[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct PPresence {
        x: i32,
        y: i32,
    }
    impl crate::presence::Presence for PPresence {
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

    struct PGen;
    impl Worldgen for PGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct PReject;
    impl From<Unknown> for PReject {
        fn from(_: Unknown) -> Self {
            PReject
        }
    }
    struct PGame;
    impl Game for PGame {
        const SCHEMA_VERSION: u32 = 0;
        type Worldgen = PGen;
        type Action = ();
        type Reject = PReject;
        type Entity = ();
        type Player = ();
        type Global = ();
        type Presence = PPresence;
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
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: crate::game::PlayerId, _ev: PlayerEvent) {
        }
        fn apply(
            _w: &mut dyn WorldWrite<Self>,
            _who: crate::game::PlayerId,
            _a: &(),
        ) -> Result<(), PReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn encode(ops: &[PresenceOp<'_, PGame>]) -> Vec<u8> {
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        write_presence::<PGame>(&mut sink, ops);
        let n = sink.finish().unwrap();
        buf.truncate(n);
        buf
    }

    #[test]
    fn roundtrip_sample_and_gone_ascending_player_id() {
        let s1 = PPresence { x: 10, y: -5 };
        let ops = [
            PresenceOp::Sample::<PGame> {
                who: PlayerId(1),
                age_ticks: 0,
                sample: &s1,
            },
            PresenceOp::Gone { who: PlayerId(2) },
        ];
        let bytes = encode(&ops);
        let mut r = ByteReader::new(&bytes);
        let mut got = Vec::new();
        read_presence::<PGame>(&mut r, |op| got.push(op)).unwrap();
        assert_eq!(got.len(), 2);
        assert!(matches!(
            &got[0],
            PresenceDeltaOp::Sample { who, age_ticks: 0, sample }
                if *who == PlayerId(1) && *sample == s1
        ));
        assert!(matches!(&got[1], PresenceDeltaOp::Gone { who } if *who == PlayerId(2)));
    }

    #[test]
    fn age_ticks_round_trips() {
        let s1 = PPresence { x: 1, y: 2 };
        let ops = [PresenceOp::Sample::<PGame> {
            who: PlayerId(5),
            age_ticks: 37,
            sample: &s1,
        }];
        let bytes = encode(&ops);
        let mut r = ByteReader::new(&bytes);
        let mut got_age = None;
        read_presence::<PGame>(&mut r, |op| {
            if let PresenceDeltaOp::Sample { age_ticks, .. } = op {
                got_age = Some(age_ticks);
            }
        })
        .unwrap();
        assert_eq!(got_age, Some(37));
    }

    #[test]
    fn decoder_rejects_unknown_tag() {
        let mut buf = vec![0u8; 16];
        let mut sink = SliceSink::new(&mut buf);
        sink.put_varint(1); // who = 1
        sink.put_u8(9); // unknown tag
        let n = sink.finish().unwrap();
        let mut r = ByteReader::new(&buf[..n]);
        assert_eq!(
            read_presence::<PGame>(&mut r, |_| {}),
            Err(WireError::Malformed)
        );
    }

    /// `presence_section_golden` (Tests added): one `Sample` and one `Gone` entry, blessed with
    /// `pnpm golden:bytes`.
    #[test]
    fn presence_section_golden() {
        let s1 = PPresence { x: 256, y: -512 };
        let ops = [
            PresenceOp::Sample::<PGame> {
                who: PlayerId(1),
                age_ticks: 3,
                sample: &s1,
            },
            PresenceOp::Gone { who: PlayerId(2) },
        ];
        let bytes = encode(&ops);
        crate::assert_golden_bytes!("presence_section_golden", &bytes);
    }
}
