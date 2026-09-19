//! The boot region: one fixed static block whose address is known before `engine_init` has run
//! (0014 §4). Config JSON comes in at offset 0; the panic hook writes its text into the tail, so a
//! panic can be reported even when the allocator is what failed.

use core::cell::UnsafeCell;

use super::registry::{BOOT_BYTES, BOOT_TEXT_BYTES};

const BYTES: usize = BOOT_BYTES as usize;
const TEXT_BYTES: usize = BOOT_TEXT_BYTES as usize;
/// Longest config the boot region can carry.
pub const CONFIG_MAX: usize = BYTES - TEXT_BYTES;

struct Boot(UnsafeCell<[u8; BYTES]>);
// SAFETY: an instance is single-threaded (0015); natively only `ptr()` is reachable from tests.
unsafe impl Sync for Boot {}

static BOOT: Boot = Boot(UnsafeCell::new([0; BYTES]));

pub fn ptr() -> *mut u8 {
    BOOT.0.get().cast()
}

/// The first `len` bytes, where the loader wrote the config. `None` when `len` does not fit.
pub(crate) fn config(len: u32) -> Option<&'static [u8]> {
    let len = len as usize;
    if len > CONFIG_MAX {
        return None;
    }
    // SAFETY: in bounds; the host writes only between export calls and nothing in the module
    // writes here.
    Some(unsafe { core::slice::from_raw_parts(ptr(), len) })
}

/// The tail the panic hook formats into.
///
/// # Safety
/// The caller must be the only user of the tail: the panic path, which never returns.
pub(crate) unsafe fn text_tail() -> &'static mut [u8] {
    // SAFETY: in bounds and disjoint from `config`; exclusivity is the caller's contract.
    unsafe { core::slice::from_raw_parts_mut(ptr().add(CONFIG_MAX), TEXT_BYTES) }
}
