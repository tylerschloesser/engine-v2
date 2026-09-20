//! Little-endian byte sinks and a reader, plus the one varint form the engine uses everywhere:
//! unsigned LEB128, byte-identical to postcard's (`varint_matches_postcard`). Used both by
//! [`crate::codec`] (through [`Fnv64`](crate::hash::Fnv64) and [`SliceSink`]) and by the
//! hand-written framing of 0011 and the containers of 0005.

use crate::codec::CodecError;

/// A destination for encoded bytes. `put` never panics or reports failure directly: an
/// implementation that can run out of room (like [`SliceSink`]) remembers it and reports through
/// its own `finish`, so a caller never has to check every `put_*` call.
pub trait ByteSink {
    fn put(&mut self, bytes: &[u8]);

    #[inline]
    fn put_u8(&mut self, v: u8) {
        self.put(&[v]);
    }

    #[inline]
    fn put_u16(&mut self, v: u16) {
        self.put(&v.to_le_bytes());
    }

    #[inline]
    fn put_u32(&mut self, v: u32) {
        self.put(&v.to_le_bytes());
    }

    #[inline]
    fn put_u64(&mut self, v: u64) {
        self.put(&v.to_le_bytes());
    }

    #[inline]
    fn put_i32(&mut self, v: i32) {
        self.put(&v.to_le_bytes());
    }

    /// Unsigned LEB128: 7 payload bits per byte, high bit set on every byte but the last. Byte-
    /// identical to how postcard encodes a `u64` (`varint_matches_postcard`).
    #[inline]
    fn put_varint(&mut self, mut v: u64) {
        loop {
            let byte = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                self.put(&[byte]);
                return;
            }
            self.put(&[byte | 0x80]);
        }
    }
}

/// Writes into a caller-owned slice. Running out of room is an error state read by [`finish`],
/// never a panic: every `put` after overflow is a no-op.
///
/// [`finish`]: SliceSink::finish
pub struct SliceSink<'a> {
    buf: &'a mut [u8],
    pos: usize,
    overflowed: bool,
}

impl<'a> SliceSink<'a> {
    pub fn new(buf: &'a mut [u8]) -> Self {
        SliceSink {
            buf,
            pos: 0,
            overflowed: false,
        }
    }

    /// The number of bytes written, or [`CodecError::Overflow`] if any `put` ran past the end of
    /// the slice.
    pub fn finish(self) -> Result<usize, CodecError> {
        if self.overflowed {
            Err(CodecError::Overflow)
        } else {
            Ok(self.pos)
        }
    }
}

impl ByteSink for SliceSink<'_> {
    fn put(&mut self, bytes: &[u8]) {
        if self.overflowed {
            return;
        }
        let Some(end) = self.pos.checked_add(bytes.len()) else {
            self.overflowed = true;
            return;
        };
        let Some(dst) = self.buf.get_mut(self.pos..end) else {
            self.overflowed = true;
            return;
        };
        dst.copy_from_slice(bytes);
        self.pos = end;
    }
}

/// Counts bytes without storing them: [`crate::codec::encoded_len`]'s sink.
#[derive(Default)]
pub struct CountSink(pub usize);

impl ByteSink for CountSink {
    fn put(&mut self, bytes: &[u8]) {
        self.0 += bytes.len();
    }
}

/// Reads little-endian fixed-width values and the engine varint back out of a borrowed slice.
/// Every accessor is a `Result`: running past the end is [`CodecError::Malformed`], never a panic.
pub struct ByteReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> ByteReader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        ByteReader { buf, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], CodecError> {
        let end = self.pos.checked_add(n).ok_or(CodecError::Malformed)?;
        let slice = self.buf.get(self.pos..end).ok_or(CodecError::Malformed)?;
        self.pos = end;
        Ok(slice)
    }

    pub fn u8(&mut self) -> Result<u8, CodecError> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16, CodecError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    pub fn u32(&mut self) -> Result<u32, CodecError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    pub fn u64(&mut self) -> Result<u64, CodecError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    pub fn i32(&mut self) -> Result<i32, CodecError> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    /// Same shape postcard decodes for a `u64`: up to 10 continuation bytes. A reader alone
    /// cannot tell a canonical varint from an overlong one (both decode to the same value); only
    /// [`crate::codec::decode_canonical`]'s re-encode-and-compare catches that.
    pub fn varint(&mut self) -> Result<u64, CodecError> {
        let mut out: u64 = 0;
        for i in 0..10 {
            let byte = self.u8()?;
            let carry = (byte & 0x7f) as u64;
            if i == 9 && carry > 1 {
                // A u64 needs at most 10 bytes of 7 bits; the 10th byte carries only bit 63.
                return Err(CodecError::Malformed);
            }
            out |= carry << (7 * i);
            if byte & 0x80 == 0 {
                return Ok(out);
            }
        }
        Err(CodecError::Malformed)
    }

    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8], CodecError> {
        self.take(n)
    }

    /// Every byte not yet consumed. Cannot fail: an empty tail is a valid tail.
    pub fn rest(&self) -> &'a [u8] {
        &self.buf[self.pos..]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct VecSink(Vec<u8>);
    impl ByteSink for VecSink {
        fn put(&mut self, bytes: &[u8]) {
            self.0.extend_from_slice(bytes);
        }
    }

    fn varint_bytes(v: u64) -> Vec<u8> {
        let mut sink = VecSink(Vec::new());
        sink.put_varint(v);
        sink.0
    }

    #[test]
    fn varint_matches_postcard() {
        for v in [
            0u64,
            1,
            126,
            127,
            128,
            129,
            16_383,
            16_384,
            16_385,
            u32::MAX as u64 - 1,
            u32::MAX as u64,
            u32::MAX as u64 + 1,
            u64::MAX / 2,
            u64::MAX - 1,
            u64::MAX,
        ] {
            let ours = varint_bytes(v);
            let theirs = postcard::to_allocvec(&v).unwrap();
            assert_eq!(ours, theirs, "varint({v})");
        }
    }

    #[test]
    fn slice_sink_overflow_is_error() {
        let mut buf = [0u8; 2];
        let mut sink = SliceSink::new(&mut buf);
        sink.put(&[1]);
        sink.put(&[2, 3]); // does not fit: 1 byte written, 2 more requested, capacity 2
        assert_eq!(sink.finish(), Err(CodecError::Overflow));

        let mut buf = [0u8; 2];
        let mut sink = SliceSink::new(&mut buf);
        sink.put(&[1, 2]);
        assert_eq!(sink.finish(), Ok(2));
    }

    #[test]
    fn reader_truncation_is_error() {
        let buf = [1u8, 2, 3];
        let mut r = ByteReader::new(&buf);
        assert_eq!(r.u32(), Err(CodecError::Malformed));

        let mut r = ByteReader::new(&buf);
        assert_eq!(r.u16(), Ok(0x0201));
        assert_eq!(r.u16(), Err(CodecError::Malformed));

        let mut r = ByteReader::new(&[0x80]); // continuation with nothing after it
        assert_eq!(r.varint(), Err(CodecError::Malformed));
    }

    #[test]
    fn reader_reads_what_the_sink_wrote() {
        let mut buf = [0u8; 32];
        let mut sink = SliceSink::new(&mut buf);
        sink.put_u8(7);
        sink.put_u16(0x1234);
        sink.put_u32(0x89ab_cdef);
        sink.put_u64(0x0102_0304_0506_0708);
        sink.put_i32(-5);
        sink.put_varint(300);
        let n = sink.finish().unwrap();

        let mut r = ByteReader::new(&buf[..n]);
        assert_eq!(r.u8(), Ok(7));
        assert_eq!(r.u16(), Ok(0x1234));
        assert_eq!(r.u32(), Ok(0x89ab_cdef));
        assert_eq!(r.u64(), Ok(0x0102_0304_0506_0708));
        assert_eq!(r.i32(), Ok(-5));
        assert_eq!(r.varint(), Ok(300));
        assert_eq!(r.rest(), &[] as &[u8]);
    }
}
