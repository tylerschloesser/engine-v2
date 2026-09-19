//! Fake engine crate. Ships inside the npm package; consumed as a cargo path dep.
use core::cell::UnsafeCell;

pub const ABI_VERSION: u32 = 1;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "engine")]
unsafe extern "C" {
    #[link_name = "panic"]
    fn host_panic(ptr: *const u8, len: usize);
    #[link_name = "log"]
    fn host_log(level: u32, ptr: *const u8, len: usize);
}

pub fn log(level: u32, msg: &str) {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        host_log(level, msg.as_ptr(), msg.len())
    }
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("[{level}] {msg}");
}

pub fn install_panic_hook() {
    #[cfg(target_arch = "wasm32")]
    std::panic::set_hook(Box::new(|info| {
        let s = info.to_string();
        unsafe { host_panic(s.as_ptr(), s.len()) }
    }));
}

/// What a game implements. JS never sees any of this.
pub trait Game: Sized + 'static {
    fn new(seed: u32) -> Self;
    fn tick(&mut self);
    fn state_hash(&self) -> u32;
    /// Round-trip probe for the spike.
    fn add(&self, a: i32, b: i32) -> i32;
}

/// Single-threaded global slot (wasm32-unknown-unknown has no threads here).
pub struct Slot<T>(UnsafeCell<Option<T>>);
unsafe impl<T> Sync for Slot<T> {}
impl<T> Slot<T> {
    pub const fn new() -> Self {
        Slot(UnsafeCell::new(None))
    }
    #[allow(clippy::mut_from_ref)]
    pub fn get(&self) -> &mut Option<T> {
        unsafe { &mut *self.0.get() }
    }
}

#[macro_export]
macro_rules! export_game {
    ($game:ty) => {
        static __ENGINE_GAME: $crate::Slot<$game> = $crate::Slot::new();

        #[unsafe(no_mangle)]
        pub extern "C" fn engine_abi_version() -> u32 {
            $crate::ABI_VERSION
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn engine_init(seed: u32) -> u32 {
            $crate::install_panic_hook();
            *__ENGINE_GAME.get() = Some(<$game as $crate::Game>::new(seed));
            $crate::log(1, "engine_init ok");
            0
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn engine_tick() {
            $crate::Game::tick(__ENGINE_GAME.get().as_mut().expect("engine_init not called"));
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn engine_state_hash() -> u32 {
            $crate::Game::state_hash(__ENGINE_GAME.get().as_ref().expect("engine_init not called"))
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn engine_add(a: i32, b: i32) -> i32 {
            $crate::Game::add(__ENGINE_GAME.get().as_ref().expect("engine_init not called"), a, b)
        }
    };
}
