//! `ActionResults` (section 1, Planning decisions "ActionResults"): `n varint` x `(seq varint, tag
//! u8)`, `tag` 0 = `Applied` (no payload, 0022 §6), 1 = `Rejected::Game` + `Codec` reject, 2 =
//! `Rejected::Engine` + `u8` code in [`EngineReject`] declaration order. `Ack.tick` is the frame
//! header's own `tick` and is never repeated here.

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::{self, encode_to};
use crate::game::Game;
use crate::sim::{Applied, EngineReject, Outcome, Rejected};

use super::{WireError, varint_u32};

fn engine_reject_code(e: EngineReject) -> u8 {
    match e {
        EngineReject::RateLimited => 0,
        EngineReject::StateBudgetFull => 1,
        EngineReject::EngineFault => 2,
    }
}

fn engine_reject_from_code(c: u8) -> Result<EngineReject, WireError> {
    Ok(match c {
        0 => EngineReject::RateLimited,
        1 => EngineReject::StateBudgetFull,
        2 => EngineReject::EngineFault,
        _ => return Err(WireError::Malformed),
    })
}

pub struct ActionResultsWriter;

impl ActionResultsWriter {
    /// Writes `n varint` (from `results.clone().count()`) then every result in order.
    pub fn write<'a, G: Game>(
        sink: &mut (impl ByteSink + ?Sized),
        results: impl Iterator<Item = &'a Outcome<G>> + Clone,
    ) {
        let n = results.clone().count() as u64;
        sink.put_varint(n);
        for o in results {
            sink.put_varint(o.seq as u64);
            match &o.result {
                Ok(Applied) => sink.put_u8(0),
                Err(Rejected::Game(reject)) => {
                    sink.put_u8(1);
                    encode_to(reject, sink).expect("encoding a Reject into a ByteSink cannot fail");
                }
                Err(Rejected::Engine(code)) => {
                    sink.put_u8(2);
                    sink.put_u8(engine_reject_code(*code));
                }
            }
        }
    }
}

pub struct ActionResultsReader;

impl ActionResultsReader {
    pub fn read<G: Game>(
        r: &mut ByteReader,
        mut on_result: impl FnMut(u32, Result<Applied, Rejected<G>>),
    ) -> Result<(), WireError> {
        let n = varint_u32(r)?;
        for _ in 0..n {
            let seq = varint_u32(r)?;
            let tag = r.u8().map_err(WireError::from)?;
            let result = match tag {
                0 => Ok(Applied),
                1 => {
                    let bytes = r.rest();
                    let (reject, rest) =
                        codec::decode::<G::Reject>(bytes).map_err(WireError::from)?;
                    let consumed = bytes.len() - rest.len();
                    r.bytes(consumed).map_err(WireError::from)?;
                    Err(Rejected::Game(reject))
                }
                2 => {
                    let code = r.u8().map_err(WireError::from)?;
                    Err(Rejected::Engine(engine_reject_from_code(code)?))
                }
                _ => return Err(WireError::Malformed),
            };
            on_result(seq, result);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;
    use crate::game::{PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
    use crate::world::{ChunkCoord, PrototypeId, Registry, Tile, TilePos};
    use crate::worldgen::Worldgen;

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct RPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct RGlobal;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct REntity;
    #[derive(
        Clone,
        Copy,
        PartialEq,
        Eq,
        Debug,
        PartialOrd,
        Ord,
        serde::Serialize,
        serde::Deserialize,
        ts_rs::TS,
    )]
    enum RReject {
        Bad,
        NotFound,
    }
    impl From<Unknown> for RReject {
        fn from(_: Unknown) -> Self {
            RReject::NotFound
        }
    }
    struct RGen;
    impl Worldgen for RGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    struct RGame;
    impl Game for RGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = RGen;
        type Action = ();
        type Reject = RReject;
        type Entity = REntity;
        type Player = RPlayer;
        type Global = RGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &REntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &REntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), RReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn outcomes() -> Vec<Outcome<RGame>> {
        vec![
            Outcome {
                seq: 1,
                result: Ok(Applied),
            },
            Outcome {
                seq: 2,
                result: Err(Rejected::Game(RReject::Bad)),
            },
            Outcome {
                seq: 3,
                result: Err(Rejected::Engine(EngineReject::StateBudgetFull)),
            },
        ]
    }

    #[test]
    fn roundtrip_all_tags() {
        let os = outcomes();
        let mut buf = vec![0u8; 1024];
        let mut sink = SliceSink::new(&mut buf);
        ActionResultsWriter::write(&mut sink, os.iter());
        let n = sink.finish().unwrap();

        let mut r = ByteReader::new(&buf[..n]);
        let mut got = Vec::new();
        ActionResultsReader::read::<RGame>(&mut r, |seq, res| got.push((seq, res))).unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].0, 1);
        assert!(matches!(got[0].1, Ok(Applied)));
        assert_eq!(got[1].0, 2);
        assert!(matches!(&got[1].1, Err(Rejected::Game(RReject::Bad))));
        assert_eq!(got[2].0, 3);
        assert!(matches!(
            &got[2].1,
            Err(Rejected::Engine(EngineReject::StateBudgetFull))
        ));
    }

    #[test]
    fn golden_action_results_all_tags() {
        let os = outcomes();
        let mut buf = vec![0u8; 1024];
        let mut sink = SliceSink::new(&mut buf);
        ActionResultsWriter::write(&mut sink, os.iter());
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("wire_action_results_all_tags", &buf[..n]);
    }

    #[test]
    fn decoder_rejects_unknown_tag_and_engine_code() {
        let mut buf = vec![0u8; 32];
        let mut sink = SliceSink::new(&mut buf);
        sink.put_varint(1); // n = 1
        sink.put_varint(1); // seq
        sink.put_u8(9); // unknown tag
        let n = sink.finish().unwrap();
        let mut r = ByteReader::new(&buf[..n]);
        assert_eq!(
            ActionResultsReader::read::<RGame>(&mut r, |_, _| {}),
            Err(WireError::Malformed)
        );

        let mut buf2 = vec![0u8; 32];
        let mut sink2 = SliceSink::new(&mut buf2);
        sink2.put_varint(1);
        sink2.put_varint(1);
        sink2.put_u8(2); // Engine tag
        sink2.put_u8(200); // unknown engine code
        let n2 = sink2.finish().unwrap();
        let mut r2 = ByteReader::new(&buf2[..n2]);
        assert_eq!(
            ActionResultsReader::read::<RGame>(&mut r2, |_, _| {}),
            Err(WireError::Malformed)
        );
    }
}
