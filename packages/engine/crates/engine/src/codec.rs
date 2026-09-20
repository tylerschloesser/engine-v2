//! `Codec`: postcard with NaN canonicalisation (docs/decisions/0002 §3, 0003, 0011). Every game-
//! typed value on the wire, in the log and in a snapshot is these bytes.
//!
//! Canonicalisation wraps the `serde::Serializer`, not the bytes: [`CanonSerializer`] intercepts
//! `serialize_f32`/`serialize_f64` and re-wraps every nested value so a NaN at any depth becomes
//! the canonical bit pattern (Planning decisions 2 of docs/plan/05-codec-and-state-hash.md).
//! Decoding is plain postcard; untrusted bytes go through [`decode_canonical`], which decodes,
//! re-encodes canonically into a scratch buffer and rejects any difference (a NaN payload, an
//! overlong varint, or trailing bytes all show up as a mismatch).

use serde::de::DeserializeOwned;
use serde::ser::{
    Serialize, SerializeMap, SerializeSeq, SerializeStruct, SerializeStructVariant, SerializeTuple,
    SerializeTupleStruct, SerializeTupleVariant,
};

use crate::bytes::{ByteSink, CountSink, SliceSink};

/// Plain data: encodable and decodable by `Codec` free functions. A blanket impl over every
/// `Serialize + DeserializeOwned` type, matching 0003's bound on `Action`/`Entity`/`Player`/
/// `Global`.
pub trait Codec: Serialize + DeserializeOwned {}
impl<T: Serialize + DeserializeOwned> Codec for T {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodecError {
    /// A [`SliceSink`] ran out of room.
    Overflow,
    /// Bytes ran out, or postcard could not decode the shape it found.
    Malformed,
    /// [`decode_canonical`]: the decoded value does not re-encode to the same bytes it came from
    /// (a non-canonical NaN payload, or an overlong varint).
    NonCanonical,
    /// [`decode_canonical`]: bytes remained after the one value it expects.
    Trailing,
}

/// Canonical bits for an `f32`: any NaN becomes the quiet NaN 0002 §3 names; every other value's
/// bits are deterministic across CPUs (only NaN sign and payload are not), so reading them here is
/// safe.
#[allow(clippy::disallowed_methods)]
pub fn canon_f32_bits(v: f32) -> u32 {
    if v.is_nan() { 0x7fc0_0000 } else { v.to_bits() }
}

/// Canonical bits for an `f64`: see [`canon_f32_bits`].
#[allow(clippy::disallowed_methods)]
pub fn canon_f64_bits(v: f64) -> u64 {
    if v.is_nan() {
        0x7ff8_0000_0000_0000
    } else {
        v.to_bits()
    }
}

/// Wraps any `serde::Serialize` value so it serializes through a [`CanonSerializer`] with the
/// same `strict` flag, however deep the wrapping compound (seq/map/struct/...) re-wraps it.
struct Canon<'a, T: ?Sized> {
    value: &'a T,
    strict: bool,
}

impl<T: ?Sized + Serialize> Serialize for Canon<'_, T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.value.serialize(CanonSerializer {
            inner: serializer,
            strict: self.strict,
        })
    }
}

/// A delegating `serde::Serializer`: every method forwards to `inner`, except `serialize_f32`/
/// `serialize_f64`, which canonicalise first, and the methods that carry a nested value or return
/// a compound serializer, which re-wrap so nesting canonicalises at every depth (Planning
/// decisions 2).
struct CanonSerializer<S> {
    inner: S,
    strict: bool,
}

/// Wraps a `serde` compound serializer (`SerializeSeq`, `SerializeStruct`, ...) so each element,
/// field, key or value it accepts passes through [`Canon`] on its way in.
struct CanonCompound<C> {
    inner: C,
    strict: bool,
}

impl<S: serde::Serializer> serde::Serializer for CanonSerializer<S> {
    type Ok = S::Ok;
    type Error = S::Error;
    type SerializeSeq = CanonCompound<S::SerializeSeq>;
    type SerializeTuple = CanonCompound<S::SerializeTuple>;
    type SerializeTupleStruct = CanonCompound<S::SerializeTupleStruct>;
    type SerializeTupleVariant = CanonCompound<S::SerializeTupleVariant>;
    type SerializeMap = CanonCompound<S::SerializeMap>;
    type SerializeStruct = CanonCompound<S::SerializeStruct>;
    type SerializeStructVariant = CanonCompound<S::SerializeStructVariant>;

    fn serialize_bool(self, v: bool) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_bool(v)
    }
    fn serialize_i8(self, v: i8) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_i8(v)
    }
    fn serialize_i16(self, v: i16) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_i16(v)
    }
    fn serialize_i32(self, v: i32) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_i32(v)
    }
    fn serialize_i64(self, v: i64) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_i64(v)
    }
    fn serialize_i128(self, v: i128) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_i128(v)
    }
    fn serialize_u8(self, v: u8) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_u8(v)
    }
    fn serialize_u16(self, v: u16) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_u16(v)
    }
    fn serialize_u32(self, v: u32) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_u32(v)
    }
    fn serialize_u64(self, v: u64) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_u64(v)
    }
    fn serialize_u128(self, v: u128) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_u128(v)
    }

    fn serialize_f32(self, v: f32) -> Result<Self::Ok, Self::Error> {
        if self.strict {
            debug_assert!(v.is_finite(), "non-finite f32 in encoded state (0002 §3)");
        }
        self.inner.serialize_f32(f32::from_bits(canon_f32_bits(v)))
    }
    fn serialize_f64(self, v: f64) -> Result<Self::Ok, Self::Error> {
        if self.strict {
            debug_assert!(v.is_finite(), "non-finite f64 in encoded state (0002 §3)");
        }
        self.inner.serialize_f64(f64::from_bits(canon_f64_bits(v)))
    }

    fn serialize_char(self, v: char) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_char(v)
    }
    fn serialize_str(self, v: &str) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_str(v)
    }
    fn serialize_bytes(self, v: &[u8]) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_bytes(v)
    }
    fn serialize_none(self) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_none()
    }
    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_some(&Canon {
            value,
            strict: self.strict,
        })
    }
    fn serialize_unit(self) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_unit()
    }
    fn serialize_unit_struct(self, name: &'static str) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_unit_struct(name)
    }
    fn serialize_unit_variant(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
    ) -> Result<Self::Ok, Self::Error> {
        self.inner
            .serialize_unit_variant(name, variant_index, variant)
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(
        self,
        name: &'static str,
        value: &T,
    ) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_newtype_struct(
            name,
            &Canon {
                value,
                strict: self.strict,
            },
        )
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<Self::Ok, Self::Error> {
        self.inner.serialize_newtype_variant(
            name,
            variant_index,
            variant,
            &Canon {
                value,
                strict: self.strict,
            },
        )
    }

    fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> {
        Ok(CanonCompound {
            inner: self.inner.serialize_seq(len)?,
            strict: self.strict,
        })
    }
    fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple, Self::Error> {
        Ok(CanonCompound {
            inner: self.inner.serialize_tuple(len)?,
            strict: self.strict,
        })
    }
    fn serialize_tuple_struct(
        self,
        name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleStruct, Self::Error> {
        Ok(CanonCompound {
            inner: self.inner.serialize_tuple_struct(name, len)?,
            strict: self.strict,
        })
    }
    fn serialize_tuple_variant(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleVariant, Self::Error> {
        Ok(CanonCompound {
            inner: self
                .inner
                .serialize_tuple_variant(name, variant_index, variant, len)?,
            strict: self.strict,
        })
    }
    fn serialize_map(self, len: Option<usize>) -> Result<Self::SerializeMap, Self::Error> {
        Ok(CanonCompound {
            inner: self.inner.serialize_map(len)?,
            strict: self.strict,
        })
    }
    fn serialize_struct(
        self,
        name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeStruct, Self::Error> {
        Ok(CanonCompound {
            inner: self.inner.serialize_struct(name, len)?,
            strict: self.strict,
        })
    }
    fn serialize_struct_variant(
        self,
        name: &'static str,
        variant_index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Self::SerializeStructVariant, Self::Error> {
        Ok(CanonCompound {
            inner: self
                .inner
                .serialize_struct_variant(name, variant_index, variant, len)?,
            strict: self.strict,
        })
    }

    fn is_human_readable(&self) -> bool {
        self.inner.is_human_readable()
    }
}

impl<C: SerializeSeq> SerializeSeq for CanonCompound<C> {
    type Ok = C::Ok;
    type Error = C::Error;
    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        self.inner.serialize_element(&Canon {
            value,
            strict: self.strict,
        })
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        self.inner.end()
    }
}

impl<C: SerializeTuple> SerializeTuple for CanonCompound<C> {
    type Ok = C::Ok;
    type Error = C::Error;
    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        self.inner.serialize_element(&Canon {
            value,
            strict: self.strict,
        })
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        self.inner.end()
    }
}

impl<C: SerializeTupleStruct> SerializeTupleStruct for CanonCompound<C> {
    type Ok = C::Ok;
    type Error = C::Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        self.inner.serialize_field(&Canon {
            value,
            strict: self.strict,
        })
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        self.inner.end()
    }
}

impl<C: SerializeTupleVariant> SerializeTupleVariant for CanonCompound<C> {
    type Ok = C::Ok;
    type Error = C::Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        self.inner.serialize_field(&Canon {
            value,
            strict: self.strict,
        })
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        self.inner.end()
    }
}

impl<C: SerializeMap> SerializeMap for CanonCompound<C> {
    type Ok = C::Ok;
    type Error = C::Error;
    fn serialize_key<T: ?Sized + Serialize>(&mut self, key: &T) -> Result<(), Self::Error> {
        self.inner.serialize_key(&Canon {
            value: key,
            strict: self.strict,
        })
    }
    fn serialize_value<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        self.inner.serialize_value(&Canon {
            value,
            strict: self.strict,
        })
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        self.inner.end()
    }
}

impl<C: SerializeStruct> SerializeStruct for CanonCompound<C> {
    type Ok = C::Ok;
    type Error = C::Error;
    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Self::Error> {
        self.inner.serialize_field(
            key,
            &Canon {
                value,
                strict: self.strict,
            },
        )
    }
    fn skip_field(&mut self, key: &'static str) -> Result<(), Self::Error> {
        self.inner.skip_field(key)
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        self.inner.end()
    }
}

impl<C: SerializeStructVariant> SerializeStructVariant for CanonCompound<C> {
    type Ok = C::Ok;
    type Error = C::Error;
    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Self::Error> {
        self.inner.serialize_field(
            key,
            &Canon {
                value,
                strict: self.strict,
            },
        )
    }
    fn skip_field(&mut self, key: &'static str) -> Result<(), Self::Error> {
        self.inner.skip_field(key)
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        self.inner.end()
    }
}

/// The postcard `Flavor` that is glue, not policy: it hands every byte postcard produces to a
/// caller's [`ByteSink`] as it is produced, so hashing needs no intermediate buffer (Planning
/// decisions 4) and writing needs no second copy. Canonicalisation lives in [`CanonSerializer`],
/// above it; a `Flavor` only sees bytes (Planning decisions 2).
struct SinkFlavor<'a, S: ByteSink + ?Sized> {
    sink: &'a mut S,
}

impl<S: ByteSink + ?Sized> postcard::ser_flavors::Flavor for SinkFlavor<'_, S> {
    type Output = ();

    fn try_push(&mut self, data: u8) -> postcard::Result<()> {
        self.sink.put(&[data]);
        Ok(())
    }

    fn try_extend(&mut self, data: &[u8]) -> postcard::Result<()> {
        self.sink.put(data);
        Ok(())
    }

    fn finalize(self) -> postcard::Result<()> {
        Ok(())
    }
}

/// Encodes into `sink`, canonicalising with `strict`. Crate-private: production code always wants
/// `strict = cfg!(debug_assertions)` ([`encode_to`]); tests use this directly to drive NaN through
/// nested types without tripping the debug assert (Planning decisions 3).
pub(crate) fn encode_to_with<T: Codec>(
    strict: bool,
    value: &T,
    sink: &mut impl ByteSink,
) -> Result<(), CodecError> {
    let mut ser = postcard::Serializer {
        output: SinkFlavor { sink },
    };
    value
        .serialize(CanonSerializer {
            inner: &mut ser,
            strict,
        })
        .map_err(|_| CodecError::Malformed)?;
    Ok(())
}

/// Encodes `value` into any [`ByteSink`] — a [`SliceSink`] for snapshot bytes, an
/// [`crate::hash::Fnv64`] to hash without a buffer (Planning decisions 4).
pub fn encode_to<T: Codec>(value: &T, sink: &mut impl ByteSink) -> Result<(), CodecError> {
    encode_to_with(cfg!(debug_assertions), value, sink)
}

/// Encodes `value` into `buf`, returning the number of bytes written.
pub fn encode<T: Codec>(value: &T, buf: &mut [u8]) -> Result<usize, CodecError> {
    let mut sink = SliceSink::new(buf);
    encode_to(value, &mut sink)?;
    sink.finish()
}

/// The number of bytes `encode` would write for `value`, without writing them.
pub fn encoded_len<T: Codec>(value: &T) -> usize {
    let mut sink = CountSink::default();
    encode_to(value, &mut sink).expect("counting into a CountSink cannot fail");
    sink.0
}

/// Decodes a `T` as a prefix of `bytes`, returning it and whatever follows. Plain postcard: not
/// canonicalising (Planning decisions 2 of docs/plan/05-codec-and-state-hash.md says why).
pub fn decode<T: Codec>(bytes: &[u8]) -> Result<(T, &[u8]), CodecError> {
    postcard::take_from_bytes(bytes).map_err(|_| CodecError::Malformed)
}

/// Decodes `bytes` as exactly one `T` and nothing else, and rejects it unless it is the unique
/// canonical encoding of the value it decodes to: re-encodes the decoded value and requires a
/// byte-for-byte match. This is the only entry point untrusted bytes (uplink actions, M16) should
/// go through, so anything ever logged or hashed is canonical by construction.
pub fn decode_canonical<T: Codec>(bytes: &[u8]) -> Result<T, CodecError> {
    let (value, rest) = decode::<T>(bytes)?;
    if !rest.is_empty() {
        return Err(CodecError::Trailing);
    }
    // Non-strict: untrusted bytes may decode to a NaN, which is exactly the non-canonical case
    // this function exists to reject as an ordinary `Err`, not the debug assert `encode` would
    // hit on a NaN it was handed to *write* (Planning decisions 3).
    let mut scratch = vec![0u8; bytes.len()];
    let mut sink = SliceSink::new(&mut scratch);
    match encode_to_with(false, &value, &mut sink).and_then(|()| sink.finish()) {
        Ok(n) if scratch[..n] == *bytes => Ok(value),
        _ => Err(CodecError::NonCanonical),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize, serde::Deserialize)]
    struct Inner {
        v: f32,
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    struct Outer {
        inner: Inner,
        list: [f64; 2],
        maybe: Option<f32>,
    }

    fn contains_le_u32(buf: &[u8], v: u32) -> bool {
        buf.windows(4).any(|w| w == v.to_le_bytes())
    }
    fn contains_le_u64(buf: &[u8], v: u64) -> bool {
        buf.windows(8).any(|w| w == v.to_le_bytes())
    }

    /// A NaN nested inside a struct field, an array element and an `Option` all canonicalise,
    /// proving `CanonSerializer` re-wraps through every compound it returns (Planning decisions
    /// 2). Uses `encode_to_with(false, ..)` so it runs the same in debug and release.
    #[test]
    fn codec_nested_nan_canonical() {
        let value = Outer {
            inner: Inner {
                v: f32::from_bits(0x7fc0_1234),
            }, // payload NaN
            list: [0.0, f64::from_bits(0xfff8_0000_0000_0001)], // negative signalling-ish NaN
            maybe: Some(f32::from_bits(0xffc0_0001)),           // negative payload NaN
        };
        let mut buf = [0u8; 64];
        let mut sink = SliceSink::new(&mut buf);
        encode_to_with(false, &value, &mut sink).unwrap();
        let n = sink.finish().unwrap();
        let out = &buf[..n];

        assert!(
            contains_le_u32(out, 0x7fc0_0000),
            "canonical f32 NaN missing: {out:02x?}"
        );
        assert!(
            contains_le_u64(out, 0x7ff8_0000_0000_0000),
            "canonical f64 NaN missing: {out:02x?}"
        );
        assert!(
            !contains_le_u32(out, 0x7fc0_1234),
            "non-canonical f32 payload leaked"
        );
        assert!(
            !contains_le_u32(out, 0xffc0_0001),
            "non-canonical f32 sign/payload leaked"
        );
        assert!(
            !contains_le_u64(out, 0xfff8_0000_0000_0001),
            "non-canonical f64 payload leaked"
        );
    }
}
