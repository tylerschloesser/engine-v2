//! Config crosses once, as UTF-8 JSON in the boot region (0014 §4). The engine reads its own keys
//! and hands the `game` value on as JSON text. Keys are camelCase; later milestones add keys, so
//! unknown ones are ignored.

use core::fmt;

use serde::de::{self, Deserialize, Deserializer, Visitor};
use serde::ser::{Serialize, Serializer};

use super::registry::Status;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    arena_bytes: u32,
    #[serde(default)]
    game: serde_json::Value,
}

pub(crate) struct Config {
    pub arena_bytes: u32,
    /// The `game` value, re-serialised; `null` when the key is missing.
    pub game_json: String,
}

pub(crate) fn parse(bytes: &[u8]) -> Result<Config, Status> {
    let raw: Raw = serde_json::from_slice(bytes).map_err(|_| Status::BadConfig)?;
    let game_json = serde_json::to_string(&raw.game).map_err(|_| Status::BadConfig)?;
    Ok(Config {
        arena_bytes: raw.arena_bytes,
        game_json,
    })
}

/// A `u64` in config JSON: a `"0x…"` string of 1 to 16 hex digits, because a JS number cannot
/// carry 64 bits. Serialises as `0x` plus 16 lowercase digits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct HexU64(pub u64);

impl HexU64 {
    fn parse(s: &str) -> Option<u64> {
        let digits = s.strip_prefix("0x")?;
        if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return None;
        }
        u64::from_str_radix(digits, 16).ok()
    }
}

impl Serialize for HexU64 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&format_args!("0x{:016x}", self.0))
    }
}

impl<'de> Deserialize<'de> for HexU64 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct HexVisitor;
        impl Visitor<'_> for HexVisitor {
            type Value = HexU64;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a string of the form \"0x…\" with 1 to 16 hex digits")
            }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<HexU64, E> {
                HexU64::parse(s)
                    .map(HexU64)
                    .ok_or_else(|| E::invalid_value(de::Unexpected::Str(s), &self))
            }
        }
        d.deserialize_str(HexVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_reads_engine_keys_and_passes_game_on() {
        let cfg = parse(br#"{"arenaBytes":4096,"game":{"seed":"0x2a"},"later":true}"#).unwrap();
        assert_eq!(cfg.arena_bytes, 4096);
        assert_eq!(cfg.game_json, r#"{"seed":"0x2a"}"#);
    }

    #[test]
    fn config_missing_game_is_null() {
        assert_eq!(parse(br#"{"arenaBytes":1}"#).unwrap().game_json, "null");
    }

    #[test]
    fn config_errors_are_bad_config() {
        for bad in [
            &b""[..],
            b"{",
            b"[]",
            br#"{"game":{}}"#,
            br#"{"arenaBytes":-1}"#,
            b"\xff",
        ] {
            assert_eq!(parse(bad).err(), Some(Status::BadConfig), "{bad:?}");
        }
    }

    #[test]
    fn config_hex_u64_round_trips() {
        let v: HexU64 = serde_json::from_str(r#""0xFFFFffffFFFFffff""#).unwrap();
        assert_eq!(v, HexU64(u64::MAX));
        assert_eq!(
            serde_json::to_string(&HexU64(42)).unwrap(),
            r#""0x000000000000002a""#
        );
        for bad in [
            r#""2a""#,
            r#""0x""#,
            r#""0x10000000000000000""#,
            r#""0x+1""#,
            "42",
        ] {
            assert!(serde_json::from_str::<HexU64>(bad).is_err(), "{bad}");
        }
    }
}
