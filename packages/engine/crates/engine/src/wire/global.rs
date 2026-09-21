//! `Global` (section 2) and `OwnPlayer` (section 3) bodies (Planning decisions "Global"/
//! "OwnPlayer"). Plain functions, not stateful writer/reader types: each body is one shot, with no
//! per-entry cursor to thread across calls (unlike the coordinate-list-based sections).
//!
//! `Global`: `mask u8` (bit 0 roster, bit 1 game value) · roster `n varint` x `(PlayerId varint,
//! online u8)` · `Codec` `G::Global`. Either half may be absent (the mask says which), so a
//! roster-only or value-only frame need not resend the other. `OwnPlayer`: `PlayerId varint` ·
//! `Codec` `G::Player`.

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::{self, encode_to};
use crate::game::{Game, PlayerId};

use super::{WireError, varint_u32};

/// `roster`/`global` are each `None` when that half is unchanged and should be omitted (mask bit
/// clear).
pub fn write_global<G: Game>(
    sink: &mut impl ByteSink,
    roster: Option<impl Iterator<Item = (PlayerId, bool)> + Clone>,
    global: Option<&G::Global>,
) {
    let mut mask = 0u8;
    if roster.is_some() {
        mask |= 1;
    }
    if global.is_some() {
        mask |= 2;
    }
    sink.put_u8(mask);
    if let Some(r) = roster {
        let n = r.clone().count() as u64;
        sink.put_varint(n);
        for (who, online) in r {
            sink.put_varint(who.0 as u64);
            sink.put_u8(u8::from(online));
        }
    }
    if let Some(g) = global {
        encode_to(g, sink).expect("encoding G::Global into a ByteSink cannot fail");
    }
}

/// `on_roster` fires for every roster entry present (mask bit 0); the return value is the game
/// value, if present (mask bit 1).
pub fn read_global<G: Game>(
    r: &mut ByteReader,
    mut on_roster: impl FnMut(PlayerId, bool),
) -> Result<Option<G::Global>, WireError> {
    let mask = r.u8().map_err(WireError::from)?;
    if mask & !0b11 != 0 {
        return Err(WireError::Malformed);
    }
    if mask & 1 != 0 {
        let n = varint_u32(r)?;
        for _ in 0..n {
            let who = PlayerId(varint_u32(r)?);
            let online = r.u8().map_err(WireError::from)? != 0;
            on_roster(who, online);
        }
    }
    if mask & 2 != 0 {
        let bytes = r.rest();
        let (g, rest) = codec::decode::<G::Global>(bytes).map_err(WireError::from)?;
        let consumed = bytes.len() - rest.len();
        r.bytes(consumed).map_err(WireError::from)?;
        Ok(Some(g))
    } else {
        Ok(None)
    }
}

pub fn write_own_player<G: Game>(sink: &mut impl ByteSink, who: PlayerId, state: &G::Player) {
    sink.put_varint(who.0 as u64);
    encode_to(state, sink).expect("encoding G::Player into a ByteSink cannot fail");
}

pub fn read_own_player<G: Game>(r: &mut ByteReader) -> Result<(PlayerId, G::Player), WireError> {
    let who = PlayerId(varint_u32(r)?);
    let bytes = r.rest();
    let (state, rest) = codec::decode::<G::Player>(bytes).map_err(WireError::from)?;
    let consumed = bytes.len() - rest.len();
    r.bytes(consumed).map_err(WireError::from)?;
    Ok((who, state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;
    use crate::game::{PlayerEvent, TickCx, Unknown, WorldWrite};
    use crate::world::{ChunkCoord, PrototypeId, Registry, Tile, TilePos};
    use crate::worldgen::Worldgen;

    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct GPlayer {
        score: u32,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct GGlobal {
        day: u32,
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct GEntity;
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct GReject;
    impl From<Unknown> for GReject {
        fn from(_: Unknown) -> Self {
            GReject
        }
    }
    struct GGen;
    impl Worldgen for GGen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }
    struct GGame;
    impl Game for GGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = GGen;
        type Action = ();
        type Reject = GReject;
        type Entity = GEntity;
        type Player = GPlayer;
        type Global = GGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &GEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &GEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), GReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    #[test]
    fn roundtrip_roster_and_value_both_present() {
        let roster = vec![(PlayerId(1), true), (PlayerId(2), false)];
        let global = GGlobal { day: 9 };
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        write_global::<GGame>(&mut sink, Some(roster.iter().copied()), Some(&global));
        let n = sink.finish().unwrap();

        let mut r = ByteReader::new(&buf[..n]);
        let mut got_roster = Vec::new();
        let got_global =
            read_global::<GGame>(&mut r, |who, online| got_roster.push((who, online))).unwrap();
        assert_eq!(got_roster, roster);
        assert_eq!(got_global, Some(global));
    }

    #[test]
    fn roster_only_omits_the_mask_bit_for_global() {
        let roster = vec![(PlayerId(3), true)];
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        write_global::<GGame>(&mut sink, Some(roster.iter().copied()), None);
        let n = sink.finish().unwrap();
        assert_eq!(buf[0], 1, "mask should have only bit 0 set");

        let mut r = ByteReader::new(&buf[..n]);
        let mut got_roster = Vec::new();
        let got_global =
            read_global::<GGame>(&mut r, |who, online| got_roster.push((who, online))).unwrap();
        assert_eq!(got_roster, roster);
        assert_eq!(got_global, None);
    }

    #[test]
    fn value_only_omits_the_mask_bit_for_roster() {
        let global = GGlobal { day: 3 };
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        write_global::<GGame>(
            &mut sink,
            None::<std::iter::Empty<(PlayerId, bool)>>,
            Some(&global),
        );
        let n = sink.finish().unwrap();
        assert_eq!(buf[0], 2, "mask should have only bit 1 set");

        let mut r = ByteReader::new(&buf[..n]);
        let mut on_roster_called = false;
        let got_global = read_global::<GGame>(&mut r, |_, _| on_roster_called = true).unwrap();
        assert!(!on_roster_called);
        assert_eq!(got_global, Some(global));
    }

    #[test]
    fn golden_global_and_own_player() {
        let roster = vec![(PlayerId(1), true), (PlayerId(2), false)];
        let global = GGlobal { day: 9 };
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        write_global::<GGame>(&mut sink, Some(roster.iter().copied()), Some(&global));
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("wire_global", &buf[..n]);

        let mut buf2 = vec![0u8; 256];
        let mut sink2 = SliceSink::new(&mut buf2);
        write_own_player::<GGame>(&mut sink2, PlayerId(7), &GPlayer { score: 42 });
        let n2 = sink2.finish().unwrap();
        crate::assert_golden_bytes!("wire_own_player", &buf2[..n2]);

        let mut r2 = ByteReader::new(&buf2[..n2]);
        assert_eq!(
            read_own_player::<GGame>(&mut r2).unwrap(),
            (PlayerId(7), GPlayer { score: 42 })
        );
    }

    #[test]
    fn decoder_rejects_reserved_mask_bits() {
        let bytes = [0b1000_0000u8];
        let mut r = ByteReader::new(&bytes);
        assert_eq!(
            read_global::<GGame>(&mut r, |_, _| {}),
            Err(WireError::Malformed)
        );
    }
}
