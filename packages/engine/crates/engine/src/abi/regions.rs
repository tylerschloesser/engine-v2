//! The region table: fixed blocks of linear memory that bytes cross the boundary through
//! (0014 §4). Regions are declared once during `engine_init`, leaked, and never move or resize,
//! so the loader reads each `(ptr, len)` once.

use std::alloc::{Layout, alloc_zeroed, handle_alloc_error};

use super::registry::{REGION_COUNT, RegionId};

/// Every region is 8-aligned so the host may read it through any typed-array view.
const ALIGN: usize = 8;

#[derive(Clone, Copy)]
struct Region {
    ptr: *mut u8,
    len: u32,
}

const ABSENT: Region = Region {
    ptr: core::ptr::null_mut(),
    len: 0,
};

/// Filled by `engine_init` and [`Instance::init`](super::Instance::init); read-only afterwards.
pub struct RegionLayout {
    regions: [Region; REGION_COUNT],
}

impl RegionLayout {
    pub const fn new() -> Self {
        RegionLayout {
            regions: [ABSENT; REGION_COUNT],
        }
    }

    /// Declare region `id` with a capacity of `bytes`, zero-filled.
    ///
    /// Panics when `bytes` is 0 or the region is already declared: both are bugs in `init`.
    pub fn region(&mut self, id: RegionId, bytes: u32) {
        let slot = &mut self.regions[id as usize];
        assert!(bytes > 0, "region {id:?}: zero bytes");
        assert!(slot.ptr.is_null(), "region {id:?}: declared twice");
        let layout = Layout::from_size_align(bytes as usize, ALIGN).expect("region layout");
        // SAFETY: `layout` has a non-zero size. The block is never freed: that is the contract.
        let ptr = unsafe { alloc_zeroed(layout) };
        if ptr.is_null() {
            handle_alloc_error(layout);
        }
        *slot = Region { ptr, len: bytes };
    }

    /// Address of region `id`; null when this instance has no such region.
    pub fn ptr(&self, id: RegionId) -> *mut u8 {
        self.regions[id as usize].ptr
    }

    /// Capacity of region `id` in bytes; 0 when absent.
    pub fn len(&self, id: RegionId) -> u32 {
        self.regions[id as usize].len
    }

    pub fn is_empty(&self) -> bool {
        self.regions.iter().all(|r| r.ptr.is_null())
    }

    /// The whole region; empty when absent.
    pub fn bytes(&self, id: RegionId) -> &[u8] {
        let r = self.regions[id as usize];
        if r.ptr.is_null() {
            return &[];
        }
        // SAFETY: `ptr` came from `alloc_zeroed(len)` and is never freed or moved; the host
        // writes only between export calls.
        unsafe { core::slice::from_raw_parts(r.ptr, r.len as usize) }
    }

    /// The whole region, writable; empty when absent.
    pub fn bytes_mut(&mut self, id: RegionId) -> &mut [u8] {
        let r = self.regions[id as usize];
        if r.ptr.is_null() {
            return &mut [];
        }
        // SAFETY: as `bytes`; `&mut self` makes this the only live slice of the region.
        unsafe { core::slice::from_raw_parts_mut(r.ptr, r.len as usize) }
    }
}

impl Default for RegionLayout {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_table_declares_and_reads_back() {
        let mut layout = RegionLayout::new();
        assert!(layout.is_empty());
        layout.region(RegionId::Rx, 24);
        assert_eq!(layout.len(RegionId::Rx), 24);
        assert_eq!(layout.ptr(RegionId::Rx) as usize % ALIGN, 0);
        assert!(layout.bytes(RegionId::Rx).iter().all(|&b| b == 0));
        layout.bytes_mut(RegionId::Rx)[23] = 7;
        assert_eq!(layout.bytes(RegionId::Rx)[23], 7);
    }

    #[test]
    fn region_table_absent_region_is_null_and_empty() {
        let layout = RegionLayout::new();
        assert!(layout.ptr(RegionId::Tx).is_null());
        assert_eq!(layout.len(RegionId::Tx), 0);
        assert!(layout.bytes(RegionId::Tx).is_empty());
    }

    #[test]
    #[should_panic(expected = "declared twice")]
    fn region_table_rejects_a_second_declaration() {
        let mut layout = RegionLayout::new();
        layout.region(RegionId::Result, 64);
        layout.region(RegionId::Result, 64);
    }
}
