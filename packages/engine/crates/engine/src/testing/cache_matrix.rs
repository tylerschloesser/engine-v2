//! Mechanical proof that the dense cache is invisible (0007 Consequences, 0020 §3 Rust native
//! row): [`assert_cache_invisible`] replays the same script at cache capacity 1, the default, and
//! unlimited, crossed with three generation-prewarm orders, and requires every run to produce the
//! same checkpoints. [`TestTerrain`] and [`CountingSource`] are the seeded `PristineSource`s a
//! script drives; `M12b`, `M21` and `M22` rerun real logs through this same assertion.

use std::cell::RefCell;
use std::rc::Rc;

use crate::hash::mix64;
use crate::world::{ChunkCoord, PristineSource, Tile};

/// Cache capacity and generation order for one leg of [`assert_cache_invisible`].
#[derive(Clone, Copy, Debug)]
pub struct CacheConfig {
    pub capacity: crate::world::CacheCapacity,
    pub prewarm: Prewarm,
}

/// How chunks are pre-generated before a script runs, crossed with capacity in the matrix.
#[derive(Clone, Copy, Debug)]
pub enum Prewarm {
    /// Nothing pre-generated: every chunk materializes lazily as the script touches it.
    None,
    /// Every chunk materialized up front, in a fixed order.
    All,
    /// Every chunk materialized up front, in a `mix64`-seeded shuffled order.
    Shuffled(u64),
}

/// The "default" leg of the matrix: 0007 §8's host cache budget (1,024 chunks = 4 MiB at the
/// default 32x32 chunk size).
pub const DEFAULT_CACHE_CHUNKS: u32 = 1024;

/// Runs `run` under cache capacity 1, [`DEFAULT_CACHE_CHUNKS`] and `Unlimited`, crossed with the
/// three [`Prewarm`] modes (9 legs), and asserts every returned checkpoint vector is identical.
/// `run` builds its own store from `cfg` (capacity and prewarm order), executes a script against
/// it, and returns whatever checkpoints (state hashes, read results, ...) the caller wants compared
/// -- this mechanically proves the cache never changes an observable result (0007 Consequences).
pub fn assert_cache_invisible(run: impl Fn(&CacheConfig) -> Vec<u64>) {
    use crate::world::CacheCapacity;

    let capacities = [
        CacheCapacity::Chunks(1),
        CacheCapacity::Chunks(DEFAULT_CACHE_CHUNKS),
        CacheCapacity::Unlimited,
    ];
    let prewarms = [
        Prewarm::None,
        Prewarm::All,
        Prewarm::Shuffled(0xC0FF_EE00_1234_5678),
    ];

    let mut baseline: Option<(Vec<u64>, CacheConfig)> = None;
    for &capacity in &capacities {
        for &prewarm in &prewarms {
            let cfg = CacheConfig { capacity, prewarm };
            let got = run(&cfg);
            match &baseline {
                None => baseline = Some((got, cfg)),
                Some((want, base_cfg)) => {
                    assert_eq!(
                        &got, want,
                        "cache-invisibility violated: {cfg:?} differs from baseline {base_cfg:?}"
                    );
                }
            }
        }
    }
}

/// Materializes every chunk in `chunks` through `source`, in `prewarm`'s order.
pub fn prewarm_chunks(store: &crate::world::TerrainStore, chunks: &[ChunkCoord], prewarm: Prewarm) {
    match prewarm {
        Prewarm::None => {}
        Prewarm::All => {
            for &c in chunks {
                store.materialize(c);
            }
        }
        Prewarm::Shuffled(seed) => {
            let mut order: Vec<usize> = (0..chunks.len()).collect();
            shuffle(&mut order, seed);
            for &i in &order {
                store.materialize(chunks[i]);
            }
        }
    }
}

/// Deterministic Fisher-Yates shuffle over `mix64` (no ambient randomness, 0002 §2).
fn shuffle(items: &mut [usize], seed: u64) {
    let mut state = seed;
    let mut i = items.len();
    while i > 1 {
        state = mix64(state.wrapping_add(0x9E37_79B9_7F4A_7C15));
        let j = (state as usize) % i;
        i -= 1;
        items.swap(i, j);
    }
}

/// A deterministic [`PristineSource`] built on `mix64`, for tests. Never intentionally produces
/// [`Tile::VOID`], though the astronomically unlikely all-ones bit pattern is not specifically
/// excluded.
pub struct TestTerrain {
    seed: u64,
}

impl TestTerrain {
    pub fn new(seed: u64) -> Self {
        TestTerrain { seed }
    }
}

impl PristineSource for TestTerrain {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        let base = mix64(self.seed ^ chunk.key());
        for (i, slot) in out.iter_mut().enumerate() {
            let v = mix64(base.wrapping_add(i as u64));
            *slot = Tile::new(
                (v & 0xff) as u8,
                ((v >> 8) & 0xff) as u8,
                ((v >> 16) & 0xffff) as u16,
            );
        }
    }
}

/// A handle to inspect a [`CountingSource`]'s call log after it has been moved into a
/// `Box<dyn PristineSource>` (shared via `Rc<RefCell<_>>`; the engine's instance is single-threaded,
/// 0015 §1, so no atomics are needed).
#[derive(Clone)]
pub struct CountingHandle(Rc<RefCell<Vec<ChunkCoord>>>);

impl CountingHandle {
    pub fn call_count(&self) -> usize {
        self.0.borrow().len()
    }

    pub fn calls(&self) -> Vec<ChunkCoord> {
        self.0.borrow().clone()
    }
}

/// Wraps a [`PristineSource`], recording every `generate` call's chunk in order. `new` returns a
/// [`CountingHandle`] alongside `Self` because the source is typically moved into
/// `TerrainStore::new`'s `Box<dyn PristineSource>` right away.
pub struct CountingSource<S> {
    inner: S,
    calls: Rc<RefCell<Vec<ChunkCoord>>>,
}

impl<S: PristineSource> CountingSource<S> {
    pub fn new(inner: S) -> (Self, CountingHandle) {
        let calls = Rc::new(RefCell::new(Vec::new()));
        (
            CountingSource {
                inner,
                calls: calls.clone(),
            },
            CountingHandle(calls),
        )
    }
}

impl<S: PristineSource> PristineSource for CountingSource<S> {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        self.calls.borrow_mut().push(chunk);
        self.inner.generate(chunk, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shuffle_is_a_permutation_and_deterministic() {
        let mut a: Vec<usize> = (0..50).collect();
        let mut b: Vec<usize> = (0..50).collect();
        shuffle(&mut a, 7);
        shuffle(&mut b, 7);
        assert_eq!(a, b, "same seed must shuffle identically");
        let mut sorted = a.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..50).collect::<Vec<_>>());

        let mut c: Vec<usize> = (0..50).collect();
        shuffle(&mut c, 8);
        assert_ne!(a, c, "different seeds should (almost always) differ");
    }

    #[test]
    fn assert_cache_invisible_runs_nine_legs() {
        let count = RefCell::new(0);
        assert_cache_invisible(|_cfg| {
            *count.borrow_mut() += 1;
            vec![42]
        });
        assert_eq!(*count.borrow(), 9);
    }

    #[test]
    #[should_panic(expected = "cache-invisibility violated")]
    fn assert_cache_invisible_catches_a_mismatch() {
        let count = RefCell::new(0u64);
        assert_cache_invisible(|_cfg| {
            let mut c = count.borrow_mut();
            *c += 1;
            vec![*c] // differs on every leg
        });
    }
}
