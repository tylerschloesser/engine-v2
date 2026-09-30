//! `FrameBundle` (docs/plan/31-rates-and-integrity.md step 4, 0010 Rates "Degrade": "frames
//! concatenate"): several whole [`super::MsgType::Frame`] messages in one message.
//!
//! A frame is not self-delimiting (its last section runs to the end of the message), and an
//! end-of-frame marker would change every existing frame's bytes, the 10-byte heartbeat golden
//! included. A bundle therefore length-prefixes its frames and leaves a lone frame exactly as it
//! was: `[0x06][n varint]` then `n` x `[len varint][frame bytes]`. Each frame inside is a whole,
//! ordinary `Frame` message, applied one by one, in order.

use crate::bytes::{ByteReader, ByteSink};

use super::{MsgType, WireError, varint_u32};

/// Bytes a bundle adds around `frame_lens`' frames: the type byte, the count, one length varint per
/// frame (each at most 5 bytes for a `u32`, 3 for anything under 2 MiB).
pub fn bundle_overhead(frames: usize) -> usize {
    1 + 5 + frames * 5
}

/// Writes one bundle of `frames` (at least two make a bundle worth sending; one is legal).
pub fn write_bundle<'a>(
    sink: &mut impl ByteSink,
    frames: impl ExactSizeIterator<Item = &'a [u8]> + Clone,
) {
    sink.put_u8(MsgType::FrameBundle as u8);
    sink.put_varint(frames.len() as u64);
    for f in frames {
        sink.put_varint(f.len() as u64);
        sink.put(f);
    }
}

/// Reads a bundle's frames one at a time.
pub struct BundleReader<'a> {
    reader: ByteReader<'a>,
    remaining: u32,
}

impl<'a> BundleReader<'a> {
    /// Rejects a message that is not a [`MsgType::FrameBundle`], or a count of zero.
    pub fn new(buf: &'a [u8]) -> Result<Self, WireError> {
        let mut reader = ByteReader::new(buf);
        if reader.u8().map_err(WireError::from)? != MsgType::FrameBundle as u8 {
            return Err(WireError::Malformed);
        }
        let remaining = varint_u32(&mut reader)?;
        if remaining == 0 {
            return Err(WireError::Malformed);
        }
        Ok(BundleReader { reader, remaining })
    }

    pub fn len(&self) -> u32 {
        self.remaining
    }

    pub fn is_empty(&self) -> bool {
        self.remaining == 0
    }

    /// The next whole frame's bytes, or `Ok(None)` once all `n` were read; trailing bytes after the
    /// last frame are `Malformed`.
    pub fn next_frame(&mut self) -> Result<Option<&'a [u8]>, WireError> {
        if self.remaining == 0 {
            return if self.reader.rest().is_empty() {
                Ok(None)
            } else {
                Err(WireError::Malformed)
            };
        }
        let len = varint_u32(&mut self.reader)? as usize;
        let frame = self.reader.bytes(len).map_err(WireError::from)?;
        self.remaining -= 1;
        Ok(Some(frame))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;
    use crate::wire::{FrameHeader, FrameWriter, SectionId};

    fn frame(tick: u32, with_section: bool) -> Vec<u8> {
        let mut buf = [0u8; 64];
        let mut sink = SliceSink::new(&mut buf);
        let mut fw = FrameWriter::new(&mut sink, FrameHeader { tick, ack_seq: 1 });
        if with_section {
            fw.section(SectionId::Global, |s| s.put_u8(7));
        }
        let _ = fw;
        let n = sink.finish().unwrap();
        buf[..n].to_vec()
    }

    #[test]
    fn golden_bundle_of_two_frames() {
        let a = frame(9, true);
        let b = frame(10, false);
        let frames: [&[u8]; 2] = [&a, &b];
        let mut buf = [0u8; 64];
        let mut sink = SliceSink::new(&mut buf);
        write_bundle(&mut sink, frames.iter().copied());
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("wire_frame_bundle", &buf[..n]);

        let mut r = BundleReader::new(&buf[..n]).unwrap();
        assert_eq!(r.next_frame().unwrap(), Some(&a[..]));
        assert_eq!(r.next_frame().unwrap(), Some(&b[..]));
        assert_eq!(r.next_frame().unwrap(), None);
    }

    #[test]
    fn a_lone_frame_is_unchanged_by_this_module() {
        // The heartbeat golden (`golden_heartbeat_is_10_bytes`) is why bundles length-prefix
        // instead of terminating frames.
        assert_eq!(frame(0, false).len(), 10);
    }

    #[test]
    fn malformed_bundles_are_rejected() {
        assert!(BundleReader::new(&[0x01, 0x00]).is_err(), "not a bundle");
        assert!(BundleReader::new(&[0x06, 0x00]).is_err(), "zero frames");
        let mut r = BundleReader::new(&[0x06, 0x01, 0x05, 1, 2]).unwrap();
        assert!(r.next_frame().is_err(), "length past the end");
        let mut r = BundleReader::new(&[0x06, 0x01, 0x01, 9, 9]).unwrap();
        assert_eq!(r.next_frame().unwrap(), Some(&[9u8][..]));
        assert!(r.next_frame().is_err(), "trailing bytes");
    }
}
