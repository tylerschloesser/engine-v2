//! `UplinkBatch` (client -> host, Planning decisions "Uplink batch"): `type · flags u8 (bit 0
//! camera, bit 1 presence) · last_received_tick u32 · n varint x (seq varint, len varint, Codec
//! action bytes) · camera report (16 B fixed) · presence (len varint + opaque)`. Flag bits 2-7 are
//! free for a future typed action stream (Planning decisions: "decided: not built and not
//! scheduled") -- read but not rejected here, unlike a `Frame`'s strict all-reserved flags, since
//! this milestone deliberately leaves that door open.
//!
//! Actions are handed back as raw `(seq, action_bytes)` pairs rather than decoded: the length
//! prefix exists so the host can copy those bytes straight into the log record (0004) without
//! re-encoding, and [`UplinkReader`] does not need to know the game's `Action` type to do that.

use crate::bytes::{ByteReader, ByteSink};

use super::{MsgType, WireError, varint_u32};

const FLAG_CAMERA: u8 = 0b0000_0001;
const FLAG_PRESENCE: u8 = 0b0000_0010;

/// 0010 "Camera report": 16 bytes, `latest-wins`, never seen by the sim.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CameraReport {
    pub center_x: i32,
    pub center_y: i32,
    pub half_w: u16,
    pub half_h: u16,
    pub vel_x: i16,
    pub vel_y: i16,
}

impl CameraReport {
    pub const LEN: usize = 16;

    pub fn write(&self, sink: &mut impl ByteSink) {
        sink.put_i32(self.center_x);
        sink.put_i32(self.center_y);
        sink.put_u16(self.half_w);
        sink.put_u16(self.half_h);
        sink.put(&self.vel_x.to_le_bytes());
        sink.put(&self.vel_y.to_le_bytes());
    }

    pub fn read(r: &mut ByteReader) -> Result<Self, WireError> {
        let center_x = r.i32().map_err(WireError::from)?;
        let center_y = r.i32().map_err(WireError::from)?;
        let half_w = r.u16().map_err(WireError::from)?;
        let half_h = r.u16().map_err(WireError::from)?;
        let vel_x = i16::from_le_bytes(r.bytes(2).map_err(WireError::from)?.try_into().unwrap());
        let vel_y = i16::from_le_bytes(r.bytes(2).map_err(WireError::from)?.try_into().unwrap());
        Ok(CameraReport {
            center_x,
            center_y,
            half_w,
            half_h,
            vel_x,
            vel_y,
        })
    }
}

/// A decoded uplink batch, minus its actions (delivered via [`UplinkReader::read`]'s callback).
pub struct UplinkBatch<'a> {
    pub last_received_tick: u32,
    pub camera: Option<CameraReport>,
    pub presence: Option<&'a [u8]>,
}

pub struct UplinkWriter;

impl UplinkWriter {
    /// `actions`: `(seq, already-encoded action bytes)` pairs, in send order.
    pub fn write<'a>(
        sink: &mut impl ByteSink,
        last_received_tick: u32,
        actions: impl Iterator<Item = (u32, &'a [u8])> + Clone,
        camera: Option<CameraReport>,
        presence: Option<&[u8]>,
    ) {
        sink.put_u8(MsgType::UplinkBatch as u8);
        let mut flags = 0u8;
        if camera.is_some() {
            flags |= FLAG_CAMERA;
        }
        if presence.is_some() {
            flags |= FLAG_PRESENCE;
        }
        sink.put_u8(flags);
        sink.put_u32(last_received_tick);
        let n = actions.clone().count() as u64;
        sink.put_varint(n);
        for (seq, bytes) in actions {
            sink.put_varint(seq as u64);
            sink.put_varint(bytes.len() as u64);
            sink.put(bytes);
        }
        if let Some(c) = camera {
            c.write(sink);
        }
        if let Some(p) = presence {
            sink.put_varint(p.len() as u64);
            sink.put(p);
        }
    }
}

pub struct UplinkReader;

impl UplinkReader {
    /// `on_action(seq, action_bytes)` for every queued action in order.
    pub fn read<'a>(
        buf: &'a [u8],
        mut on_action: impl FnMut(u32, &'a [u8]),
    ) -> Result<UplinkBatch<'a>, WireError> {
        let mut r = ByteReader::new(buf);
        let msg_type = r.u8().map_err(WireError::from)?;
        if msg_type != MsgType::UplinkBatch as u8 {
            return Err(WireError::Malformed);
        }
        let flags = r.u8().map_err(WireError::from)?;
        let last_received_tick = r.u32().map_err(WireError::from)?;
        let n = varint_u32(&mut r)?;
        for _ in 0..n {
            let seq = varint_u32(&mut r)?;
            let len = varint_u32(&mut r)? as usize;
            let bytes = r.bytes(len).map_err(WireError::from)?;
            on_action(seq, bytes);
        }
        let camera = if flags & FLAG_CAMERA != 0 {
            Some(CameraReport::read(&mut r)?)
        } else {
            None
        };
        let presence = if flags & FLAG_PRESENCE != 0 {
            let len = varint_u32(&mut r)? as usize;
            Some(r.bytes(len).map_err(WireError::from)?)
        } else {
            None
        };
        Ok(UplinkBatch {
            last_received_tick,
            camera,
            presence,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;

    fn camera() -> CameraReport {
        CameraReport {
            center_x: 100,
            center_y: -50,
            half_w: 128,
            half_h: 72,
            vel_x: -3,
            vel_y: 7,
        }
    }

    #[test]
    fn camera_report_is_16_bytes() {
        let mut buf = [0u8; 32];
        let mut sink = SliceSink::new(&mut buf);
        camera().write(&mut sink);
        let n = sink.finish().unwrap();
        assert_eq!(n, CameraReport::LEN);
        let mut r = ByteReader::new(&buf[..n]);
        assert_eq!(CameraReport::read(&mut r).unwrap(), camera());
    }

    #[test]
    fn roundtrip_actions_camera_and_presence() {
        let a0 = [1u8, 2, 3];
        let a1 = [9u8];
        let actions = [(10u32, a0.as_slice()), (11u32, a1.as_slice())];
        let presence = [7u8, 8, 9, 10];
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        UplinkWriter::write(
            &mut sink,
            42,
            actions.iter().copied(),
            Some(camera()),
            Some(&presence),
        );
        let n = sink.finish().unwrap();

        let mut got = Vec::new();
        let batch =
            UplinkReader::read(&buf[..n], |seq, bytes| got.push((seq, bytes.to_vec()))).unwrap();
        assert_eq!(batch.last_received_tick, 42);
        assert_eq!(batch.camera, Some(camera()));
        assert_eq!(batch.presence, Some(presence.as_slice()));
        assert_eq!(got, vec![(10, a0.to_vec()), (11, a1.to_vec())]);
    }

    #[test]
    fn roundtrip_no_camera_no_presence() {
        let mut buf = vec![0u8; 64];
        let mut sink = SliceSink::new(&mut buf);
        UplinkWriter::write(&mut sink, 5, core::iter::empty(), None, None);
        let n = sink.finish().unwrap();
        let batch = UplinkReader::read(&buf[..n], |_, _| panic!("no actions")).unwrap();
        assert_eq!(batch.last_received_tick, 5);
        assert_eq!(batch.camera, None);
        assert_eq!(batch.presence, None);
    }

    #[test]
    fn golden_uplink_batch() {
        let a0 = [1u8, 2, 3];
        let actions = [(1u32, a0.as_slice())];
        let mut buf = vec![0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        UplinkWriter::write(&mut sink, 3, actions.iter().copied(), Some(camera()), None);
        let n = sink.finish().unwrap();
        crate::assert_golden_bytes!("wire_uplink_batch", &buf[..n]);
    }

    #[test]
    fn decoder_rejects_truncated_camera() {
        let mut buf = vec![0u8; 32];
        let mut sink = SliceSink::new(&mut buf);
        UplinkWriter::write(&mut sink, 0, core::iter::empty(), Some(camera()), None);
        let n = sink.finish().unwrap();
        let truncated = &buf[..n - 1]; // drop the last byte of the camera report
        assert_eq!(
            UplinkReader::read(truncated, |_, _| {}).map(|_| ()),
            Err(WireError::Malformed)
        );
    }
}
