//! Structure replication's transport side (M46, 0078 §1, §6): the structure version and change
//! list the host routes from, the per-chunk lookups it routes and hashes with, and the replica's
//! [`Transport::apply_structure`]. Module doc of `mod.rs` for the rules; `wire::lines` for the
//! bytes; `host::lines` for the routing.
//!
//! A chunk's *anchored* lines are found through the tile index: the anchor is the chunk of the
//! front point (position 0), and the one index entry a line has at offset 0 is the tile of that
//! point, so the anchored lines of a chunk are its tiles' offset-0 entries, each line once, in
//! index order `(tile y, tile x, line)`. That order (not ascending `LineId`) is the order
//! [`crate::integrity::chunk_hash`] covers them in: both sides derive it from the same segments,
//! and it needs no scratch to sort.

use super::geometry::{check_segments, count_tiles};
use super::line::{Line, NIL};
use super::{LineId, MAX_LEN, MAX_LINE_TILES, Transport, TransportError};
use crate::game::Unknown;
use crate::wire::lines::{Put, Record};
use crate::world::{ChunkCoord, ChunkDims};

impl Transport {
    /// The tick structure changes are stamped with from now on (`Authority::begin_tick` sets it
    /// before `G::tick`; genesis and migrate stamp 0 or the restored tick).
    pub fn set_now(&mut self, tick: u32) {
        self.now = tick;
    }

    /// The tick of the line's last structure change (module doc of `mod.rs`): derived, never
    /// encoded; 0 for a decoded line until it changes.
    pub fn structure_version(&self, line: LineId) -> Result<u32, Unknown> {
        let l = self.slot(line).ok_or(Unknown)?;
        Ok(self.struct_ver[l as usize])
    }

    /// The lines whose structure changed or that were destroyed since the last
    /// [`Transport::drain_structure_changes`], each once, in change order, and whether the list
    /// overflowed (some change is missing from it: the reader must reconcile every line).
    pub fn structure_changes(&self) -> (&[LineId], bool) {
        (&self.struct_changes, self.struct_overflow)
    }

    /// Empties the change list (the host's `seal`, after every connection's frame read it).
    pub fn drain_structure_changes(&mut self) {
        for i in 0..self.struct_changes.len() {
            if let Some(l) = self.slot(self.struct_changes[i]) {
                self.lines[l as usize].struct_queued = false;
            }
        }
        self.struct_changes.clear();
        self.struct_overflow = false;
    }

    /// Puts the store in replica mode (module doc of `mod.rs`): a client's, from construction.
    pub fn set_replica(&mut self) {
        self.replica = true;
    }

    pub fn is_replica(&self) -> bool {
        self.replica
    }

    /// `Unknown` for the item reads a replica's forecasts do not answer (`sunk`, `toggle`).
    pub(super) fn items_known(&self) -> Result<(), Unknown> {
        if self.replica { Err(Unknown) } else { Ok(()) }
    }

    /// The line's structure as a `LineStructs` put (`wire::lines`): `len`, `speed`, `out` and its
    /// segments (none until `set_segments`; such a line is never replicated).
    pub fn structure(&self, line: LineId) -> Result<Put, Unknown> {
        let l = self.slot(line).ok_or(Unknown)?;
        let rec = &self.lines[l as usize];
        let mut put = Put::empty(line);
        put.len = rec.len;
        put.speed = rec.speed;
        put.out = rec.out;
        for (k, r) in self.seg_slice(l).iter().enumerate() {
            put.segs[k] = r.seg;
        }
        put.seg_count = rec.seg_count;
        Ok(put)
    }

    /// The line's store slot (`< max_lines` for a store within its caps): the host's routing
    /// deduplicates candidates by it.
    pub fn slot_of(&self, line: LineId) -> Option<u32> {
        self.slot(line)
    }

    /// Every line's id, ascending.
    pub fn line_ids(&self, f: &mut dyn FnMut(LineId)) {
        for &(id, _) in &self.index {
            f(id);
        }
    }

    /// Whether the line has registered segments (an anchor and a chunk set).
    pub fn has_segments(&self, line: LineId) -> bool {
        self.slot(line)
            .is_some_and(|l| self.lines[l as usize].seg_count > 0)
    }

    /// Every line anchored in `chunk` (module doc: tile-index order), `f(line)`.
    pub fn anchored_in(&self, chunk: ChunkCoord, dims: ChunkDims, f: &mut dyn FnMut(LineId)) {
        self.scan_chunk(chunk, dims, &mut |line, offset| {
            if offset == 0 {
                f(line);
            }
            true
        });
    }

    /// Whether any line is anchored in `chunk`.
    pub fn has_anchored(&self, chunk: ChunkCoord, dims: ChunkDims) -> bool {
        let mut found = false;
        self.scan_chunk(chunk, dims, &mut |_, offset| {
            found = offset == 0;
            !found
        });
        found
    }

    /// Every line whose path enters a tile of `chunk`, `f(line)` once per tile it enters (a
    /// caller deduplicates). A line's chunk set (`chunks_of`, tile boxes) can name a chunk its
    /// path never enters (a diagonal or a wide arc): such a line is not reported here.
    pub fn lines_entering(&self, chunk: ChunkCoord, dims: ChunkDims, f: &mut dyn FnMut(LineId)) {
        self.scan_chunk(chunk, dims, &mut |line, _| {
            f(line);
            true
        });
    }

    /// The tile index's entries inside `chunk`, row by row (`f` returns whether to go on).
    fn scan_chunk(
        &self,
        chunk: ChunkCoord,
        dims: ChunkDims,
        f: &mut dyn FnMut(LineId, u32) -> bool,
    ) {
        if self.tiles.is_empty() {
            return;
        }
        let origin = dims.tile_at(chunk, 0);
        let edge = dims.edge() as i32;
        for y in origin.y..origin.y + edge {
            let lo = (y, origin.x);
            let mut k = self.tiles.partition_point(|e| (e.y, e.x) < lo);
            while let Some(e) = self.tiles.get(k) {
                if e.y != y || e.x >= origin.x + edge {
                    break;
                }
                if !f(LineId(e.line), e.offset) {
                    return;
                }
                k += 1;
            }
        }
    }

    /// The replica's write (M46, 0078 §1): a `Put` creates the line with no items or replaces its
    /// `len`, `speed`, `out` (its fork toggle stays `false`: item state) and segments, and
    /// re-indexes its tiles; a `Gone` removes it (an unknown id is a no-op). Feeders are never
    /// redirected here: the host sends their own puts. `Full` at `max_lines` or out of geometry
    /// room (the replica reserves the world's caps), `BadSpeed`/`BadSegments`/`TooLong` for a put
    /// the host could not have sent; on any error the store is unchanged.
    pub fn apply_structure(&mut self, rec: Record<'_>) -> Result<(), TransportError> {
        let put: &Put = match rec {
            Record::Gone(g) => {
                if let Some(slot) = self.slot(g.id) {
                    self.clear_geometry(slot);
                    self.remove_slot(g.id, slot);
                }
                return Ok(());
            }
            Record::Put(p) => p,
        };
        if put.len > MAX_LEN {
            return Err(TransportError::TooLong);
        }
        if put.speed == 0 || u32::from(put.speed) >= put.len || put.id == LineId::NONE {
            return Err(TransportError::BadSpeed);
        }
        let segs = put.segments();
        if segs.is_empty() || !check_segments(put.len, segs) || count_tiles(segs) > MAX_LINE_TILES {
            return Err(TransportError::BadSegments);
        }
        let (slot, old) = match self.slot(put.id) {
            Some(slot) => (slot, Some(self.lines[slot as usize])),
            None => {
                if !self.reserved || self.index.len() as u32 >= self.max_lines {
                    return Err(TransportError::Full);
                }
                let slot = self.alloc_line(Line::new(put.id, put.len, put.speed));
                let k = self.index.partition_point(|(i, _)| *i < put.id);
                self.index.insert(k, (put.id, slot));
                self.next_id = self.next_id.max(put.id.0.saturating_add(1));
                (slot, None)
            }
        };
        let rec = &mut self.lines[slot as usize];
        rec.len = put.len;
        rec.speed = put.speed;
        rec.out = put.out;
        rec.next_slot = NIL;
        rec.alt_slot = NIL;
        rec.toggle = false;
        if let Err(e) = self.set_segments_line(put.id, segs) {
            match old {
                Some(o) => {
                    let rec = &mut self.lines[slot as usize];
                    rec.len = o.len;
                    rec.speed = o.speed;
                    rec.out = o.out;
                }
                None => self.remove_slot(put.id, slot),
            }
            return Err(e);
        }
        Ok(())
    }

    /// Drops every line (a replica at `Welcome`: the new connection sends what it routes),
    /// keeping every arena's capacity.
    pub fn clear_structures(&mut self) {
        self.lines.clear();
        self.struct_ver.clear();
        self.index.clear();
        self.segs.clear();
        self.seg_live = 0;
        self.tiles.clear();
        self.free_line = NIL;
        self.struct_changes.clear();
        self.struct_overflow = false;
        self.graph_dirty = true;
        self.fl.clear();
    }

    /// Removes a replica line's record (geometry already cleared): no redirect, no change-list
    /// entry.
    fn remove_slot(&mut self, line: LineId, slot: u32) {
        let k = self
            .index
            .binary_search_by(|(i, _)| i.cmp(&line))
            .expect("a held line is indexed");
        self.index.remove(k);
        self.lines[slot as usize] = Line::free(self.free_line);
        self.free_line = slot;
        // M47: a line no longer held takes its items with it.
        self.fl.drop_line(slot);
    }

    /// The anchor chunk of a put's segments (its front point's chunk), without holding it: the
    /// replica reports a put it could not hold against this chunk.
    pub fn anchor_of(put: &Put, dims: ChunkDims) -> Option<ChunkCoord> {
        let seg = put.segments().first()?;
        Some(dims.chunk_of(super::geometry::point_of(seg, 0).tile()))
    }
}
