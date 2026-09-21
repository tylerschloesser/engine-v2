//! Semantic input events (docs/decisions/0019-camera-input-and-overlay.md §4; docs/plan/
//! 11-camera-and-input.md Seams): the wire record `packages/engine/src/input/record.ts` writes
//! into `inputRing`, decoded here after the client worker drains that ring into `Rx` and calls
//! `on_input(len)` (`abi::on_input`). `InputQueue` is the fixed-64 holding area a `client`-role
//! `Instance` owns beside its own state; nothing reads it for game logic yet (`FrameCx::input` is
//! M18, Non-scope of the delegating brief) -- this milestone proves the whole
//! ring -> `Rx` -> decode -> queue path end to end (`fixtures/terrain`'s own `on_input`).

/// Wire `kind` byte values (docs/plan/11-camera-and-input.md Seams, `inputRing` record layout).
pub mod kind {
    pub const TAP: u8 = 1;
    pub const HOVER: u8 = 2;
    pub const LONGPRESS: u8 = 3;
    pub const DRAGSTART: u8 = 4;
    pub const DRAG: u8 = 5;
    pub const DRAGEND: u8 = 6;
}

/// One decoded `inputRing` record (docs/plan/11-camera-and-input.md Seams: 32 bytes, little-
/// endian). `#[repr(C)]` mirrors the wire layout field for field, but [`InputEvent::decode`] reads
/// explicit `from_le_bytes` (`.claude/rules/determinism.md`: no reliance on a pointer cast agreeing
/// with the wire's own byte order) rather than a raw transmute; a golden test exists precisely to
/// catch an offset/order slip here.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InputEvent {
    pub kind: u8,
    pub button: u8,
    pub modifiers: u8,
    pub pointer: u8,
    pub seq: u32,
    pub tile: [i32; 2],
    pub frac: [f32; 2],
    pub pick_id: u32,
    pub time_ms: u32,
}

impl InputEvent {
    pub const BYTES: usize = 32;

    pub fn decode(bytes: &[u8; Self::BYTES]) -> InputEvent {
        InputEvent {
            kind: bytes[0],
            button: bytes[1],
            modifiers: bytes[2],
            pointer: bytes[3],
            seq: u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
            tile: [
                i32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
                i32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]),
            ],
            frac: [
                f32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]),
                f32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]),
            ],
            pick_id: u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]),
            time_ms: u32::from_le_bytes([bytes[28], bytes[29], bytes[30], bytes[31]]),
        }
    }

    /// World position: tile plus its fractional offset (docs/plan/11-camera-and-input.md Seams,
    /// `inputRing` record: "frac ... position inside the tile, so world position is exact over
    /// +/-2^23"). `as`/`+` only (`.claude/rules/determinism.md`).
    pub fn world_pos(&self) -> (f64, f64) {
        (
            self.tile[0] as f64 + self.frac[0] as f64,
            self.tile[1] as f64 + self.frac[1] as f64,
        )
    }
}

/// Fixed-capacity holding area for decoded events, cleared once per `frame` (Seams). On overflow,
/// the *oldest* `hover` or `drag` record is dropped to make room -- the two kinds a later,
/// in-progress gesture makes stale -- before any other kind; if none exists (every queued event is
/// some other kind), the incoming event is dropped instead of displacing something the Seams call
/// more important.
pub struct InputQueue {
    events: [InputEvent; Self::CAPACITY],
    len: usize,
}

impl InputQueue {
    pub const CAPACITY: usize = 64;

    pub fn new() -> Self {
        InputQueue {
            events: [InputEvent::default(); Self::CAPACITY],
            len: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn events(&self) -> &[InputEvent] {
        &self.events[..self.len]
    }

    pub fn last(&self) -> Option<&InputEvent> {
        self.events[..self.len].last()
    }

    /// Decodes and pushes every whole [`InputEvent::BYTES`]-sized record in `bytes` (Seams:
    /// "`on_input` ... decodes whole records from `RegionId::Rx`"). Ignores a trailing partial
    /// record rather than panicking: the producer only ever pushes whole records (`sab/ring.ts`'s
    /// own slot-level API), so this should not happen in practice.
    pub fn decode_and_push_all(&mut self, bytes: &[u8]) {
        let mut offset = 0;
        while offset + InputEvent::BYTES <= bytes.len() {
            let chunk: &[u8; InputEvent::BYTES] = bytes[offset..offset + InputEvent::BYTES]
                .try_into()
                .expect("checked length above");
            self.push(InputEvent::decode(chunk));
            offset += InputEvent::BYTES;
        }
    }

    pub fn push(&mut self, event: InputEvent) {
        if self.len == Self::CAPACITY && !self.drop_oldest_hover_or_drag() {
            return; // full of "important" events: drop the incoming one instead
        }
        self.events[self.len] = event;
        self.len += 1;
    }

    fn drop_oldest_hover_or_drag(&mut self) -> bool {
        for i in 0..self.len {
            let k = self.events[i].kind;
            if k == kind::HOVER || k == kind::DRAG {
                for j in i..self.len - 1 {
                    self.events[j] = self.events[j + 1];
                }
                self.len -= 1;
                return true;
            }
        }
        false
    }

    /// Cleared at the end of each `frame` (Seams).
    pub fn clear(&mut self) {
        self.len = 0;
    }
}

impl Default for InputQueue {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_record_golden() {
        // Field values chosen to catch a swapped field, a wrong offset, a sign error on the `i32`
        // tile pair, or a little/big-endian mistake (docs/plan/11-camera-and-input.md's own
        // warning): every byte distinct, a negative tile axis, a large positive one, and frac
        // values (0.25/0.75) whose IEEE-754 bit patterns are neither all-zero nor palindromic --
        // the same bytes `packages/engine/src/input/record.test.ts`'s own golden writes.
        #[rustfmt::skip]
        let bytes: [u8; InputEvent::BYTES] = [
            0x05, 0x02, 0x0b, 0x01, // kind=5 (drag), button=2, modifiers=0b1011, pointer=1 (touch)
            0x04, 0x03, 0x02, 0x01, // seq = 0x0102_0304
            0xf9, 0xff, 0xff, 0xff, // tile.x = -7
            0x40, 0x42, 0x0f, 0x00, // tile.y = 1_000_000
            0x00, 0x00, 0x80, 0x3e, // frac.x = 0.25f
            0x00, 0x00, 0x40, 0x3f, // frac.y = 0.75f
            0x0d, 0x0c, 0x0b, 0x0a, // pick_id = 0x0a0b_0c0d
            0x44, 0x33, 0x22, 0x11, // time_ms = 0x1122_3344
        ];
        let event = InputEvent::decode(&bytes);
        assert_eq!(event.kind, kind::DRAG);
        assert_eq!(event.button, 2);
        assert_eq!(event.modifiers, 0b1011);
        assert_eq!(event.pointer, 1);
        assert_eq!(event.seq, 0x0102_0304);
        assert_eq!(event.tile, [-7, 1_000_000]);
        assert_eq!(event.frac, [0.25, 0.75]);
        assert_eq!(event.pick_id, 0x0a0b_0c0d);
        assert_eq!(event.time_ms, 0x1122_3344);
        assert_eq!(event.world_pos(), (-7.0 + 0.25, 1_000_000.0 + 0.75));
    }

    fn made(kind: u8, seq: u32) -> InputEvent {
        InputEvent {
            kind,
            seq,
            ..Default::default()
        }
    }

    #[test]
    fn queue_overflow_drops_hover_first() {
        let mut q = InputQueue::new();
        q.push(made(kind::HOVER, 0)); // the oldest record, and the only hover/drag kind present
        for i in 1..InputQueue::CAPACITY as u32 {
            q.push(made(kind::TAP, i));
        }
        assert_eq!(q.len(), InputQueue::CAPACITY);

        q.push(made(kind::TAP, 999));
        assert_eq!(q.len(), InputQueue::CAPACITY);
        assert!(q.events().iter().all(|e| e.kind == kind::TAP));
        // The hover (seq 0) is gone; the next-oldest tap (seq 1) is now first.
        assert_eq!(q.events()[0].seq, 1);
        assert_eq!(q.last().unwrap().seq, 999);
    }

    #[test]
    fn queue_overflow_drops_incoming_when_nothing_droppable() {
        // Every slot holds a kind other than hover/drag: the incoming event is dropped instead,
        // never displacing something the Seams call more important.
        let mut q = InputQueue::new();
        for i in 0..InputQueue::CAPACITY as u32 {
            q.push(made(kind::TAP, i));
        }
        q.push(made(kind::LONGPRESS, 999));
        assert_eq!(q.len(), InputQueue::CAPACITY);
        assert!(q.events().iter().all(|e| e.kind == kind::TAP));
    }

    #[test]
    fn decode_and_push_all_ignores_a_trailing_partial_record() {
        let mut q = InputQueue::new();
        let mut bytes = vec![0u8; InputEvent::BYTES + 5];
        bytes[0] = kind::TAP;
        q.decode_and_push_all(&bytes);
        assert_eq!(q.len(), 1);
    }
}
