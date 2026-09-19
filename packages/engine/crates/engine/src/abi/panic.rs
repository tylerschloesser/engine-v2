//! The module's only two imports, both output-only (0014 §3), and everything that calls them:
//! `log`, the panic hook, and `fatal` for failures that must not touch the allocator.

use core::fmt::{self, Write};

use super::boot;
use super::registry::LogLevel;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "engine")]
unsafe extern "C" {
    /// UTF-8 message; returns, then the instance traps (0014 §6).
    #[link_name = "panic"]
    fn host_panic(ptr: *const u8, len: usize);
    /// Diagnostics; decoding allocates a JS string, so never call it in a measured window.
    #[link_name = "log"]
    fn host_log(level: u32, ptr: *const u8, len: usize);
}

/// Send one line of diagnostics to the host. Release builds drop everything below `Warn`.
pub fn log(level: LogLevel, text: &str) {
    if !cfg!(debug_assertions) && level > LogLevel::Warn {
        return;
    }
    #[cfg(target_arch = "wasm32")]
    // SAFETY: the host reads `len` bytes at `ptr` before returning and keeps neither.
    unsafe {
        host_log(level as u32, text.as_ptr(), text.len())
    }
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("[{level:?}] {text}");
}

/// `fmt::Write` over a fixed buffer: keeps what fits, cut at a character boundary.
struct Truncating<'a> {
    buf: &'a mut [u8],
    len: usize,
}

impl Write for Truncating<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let mut n = s.len().min(self.buf.len() - self.len);
        while !s.is_char_boundary(n) {
            n -= 1;
        }
        self.buf[self.len..self.len + n].copy_from_slice(&s.as_bytes()[..n]);
        self.len += n;
        Ok(())
    }
}

/// Format `args` into the boot-region tail without allocating and hand the text to the host.
fn report(args: fmt::Arguments) {
    // SAFETY: only the panic path calls this, and it never returns to a second caller.
    let mut out = Truncating {
        buf: unsafe { boot::text_tail() },
        len: 0,
    };
    let _ = out.write_fmt(args);
    #[cfg(target_arch = "wasm32")]
    // SAFETY: as `log`.
    unsafe {
        host_panic(out.buf.as_ptr(), out.len)
    }
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{}", String::from_utf8_lossy(&out.buf[..out.len]));
}

/// Called by `engine_init`. Natively nothing is installed: tests unwind and print as usual.
pub(crate) fn install_hook() {
    #[cfg(target_arch = "wasm32")]
    // A closure without captures is zero-sized, so the `Box` does not allocate.
    std::panic::set_hook(Box::new(|info| report(format_args!("{info}"))));
}

/// Report `args` as a panic and trap, touching neither the allocator nor std's panic machinery
/// (which formats the message into a `String` before the hook runs).
pub(crate) fn fatal(args: fmt::Arguments) -> ! {
    report(args);
    #[cfg(target_arch = "wasm32")]
    core::arch::wasm32::unreachable();
    #[cfg(not(target_arch = "wasm32"))]
    std::process::abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_text_is_truncated_at_a_char_boundary() {
        let mut buf = [0u8; 5];
        let mut out = Truncating {
            buf: &mut buf,
            len: 0,
        };
        write!(out, "ab").unwrap();
        write!(out, "cé€").unwrap(); // c (1) + é (2) fit; € (3) does not
        write!(out, "z").unwrap();
        assert_eq!(out.len, 5);
        assert_eq!(&buf, "abcé".as_bytes());
    }
}
