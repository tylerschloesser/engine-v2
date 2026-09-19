//! The arena (0015 §5) without owning an allocator: [`Arena`] wraps std's allocator and counts
//! bytes; `engine_init` reserves the arena by allocating and freeing one block of `arenaBytes`,
//! which makes std's allocator perform the single `memory.grow`. Growth after that is tolerated
//! but counted ([`mem_grows`]); dev builds treat live bytes past the reservation as a bug.

use core::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::alloc::{GlobalAlloc, Layout, System};

/// Installed as the `#[global_allocator]` by `export_instance!`.
pub struct Arena;

// Plain loads and stores on wasm32 (no `atomics` feature); relaxed is enough natively because
// the counters are diagnostics.
static LIVE: AtomicUsize = AtomicUsize::new(0);
static HIGH_WATER: AtomicUsize = AtomicUsize::new(0);
static RESERVED: AtomicUsize = AtomicUsize::new(0);
static PAGES_AT_INIT: AtomicUsize = AtomicUsize::new(0);

/// Bytes currently allocated through [`Arena`].
pub fn live_bytes() -> usize {
    LIVE.load(Relaxed)
}

/// Largest value [`live_bytes`] has had.
pub fn high_water_bytes() -> usize {
    HIGH_WATER.load(Relaxed)
}

/// WASM pages grown since `engine_init` reserved the arena. 0 in steady state (asserted by 0016).
pub fn mem_grows() -> u32 {
    (pages() - PAGES_AT_INIT.load(Relaxed)) as u32
}

#[cfg(target_arch = "wasm32")]
fn pages() -> usize {
    core::arch::wasm32::memory_size(0)
}

#[cfg(not(target_arch = "wasm32"))]
fn pages() -> usize {
    0
}

/// Make the allocator grow memory once, now. False when the block cannot be had.
pub(crate) fn reserve(bytes: u32) -> bool {
    let Ok(layout) = Layout::from_size_align(bytes as usize, 8) else {
        return false;
    };
    if layout.size() > 0 {
        // SAFETY: non-zero size; freed with the same layout. Goes around the counters: the block
        // is never live.
        unsafe {
            let ptr = System.alloc(layout);
            if ptr.is_null() {
                return false;
            }
            System.dealloc(ptr, layout);
        }
    }
    RESERVED.store(bytes as usize, Relaxed);
    PAGES_AT_INIT.store(pages(), Relaxed);
    true
}

/// True when allocating `size` more bytes would take live bytes past the reservation.
/// `reserved == 0` means nothing was reserved (native tests, before `engine_init`).
const fn exceeds(live: usize, size: usize, reserved: usize) -> bool {
    reserved != 0 && live.saturating_add(size) > reserved
}

#[inline]
fn grow_live(size: usize) {
    let live = LIVE.load(Relaxed);
    if cfg!(debug_assertions) {
        let reserved = RESERVED.load(Relaxed);
        if exceeds(live, size, reserved) {
            // Not `panic!`: std formats a panic message into a `String`, and this is the allocator.
            super::panic::fatal(format_args!(
                "arena exhausted: requested {size} bytes with {live} live, reserved {reserved} bytes (arenaBytes)"
            ));
        }
    }
    let live = live + size;
    LIVE.store(live, Relaxed);
    if live > HIGH_WATER.load(Relaxed) {
        HIGH_WATER.store(live, Relaxed);
    }
}

#[inline]
fn shrink_live(size: usize) {
    LIVE.store(LIVE.load(Relaxed).saturating_sub(size), Relaxed);
}

// SAFETY: every call forwards to `System` with the caller's layout; the counters never touch the
// returned memory.
unsafe impl GlobalAlloc for Arena {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        grow_live(layout.size());
        let ptr = unsafe { System.alloc(layout) };
        if ptr.is_null() {
            shrink_live(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        grow_live(layout.size());
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if ptr.is_null() {
            shrink_live(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        shrink_live(layout.size());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let old = layout.size();
        if new_size > old {
            grow_live(new_size - old);
        }
        let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
        if new_ptr.is_null() {
            if new_size > old {
                shrink_live(new_size - old);
            }
        } else if new_size < old {
            shrink_live(old - new_size);
        }
        new_ptr
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arena_exceeds_only_past_a_reservation() {
        assert!(!exceeds(10, 1_000_000, 0));
        assert!(!exceeds(10, 90, 100));
        assert!(exceeds(10, 91, 100));
        assert!(exceeds(usize::MAX, 1, 100));
    }
}
