//! Mechanical proof of the rules of `docs/decisions/0008-chunk-generation.md` §1 that a fixed
//! `(seed, params, dims)` can check without a live ABI instance: [`assert_worldgen_contract`].

use crate::world::{ChunkCoord, ChunkDims, Tile};
use crate::worldgen::Worldgen;

/// Chunk coordinates spanning quadrants and the far range (0008 §6), shared by every check here.
fn sample_chunks() -> [ChunkCoord; 6] {
    [
        ChunkCoord::new(0, 0),
        ChunkCoord::new(1, 0),
        ChunkCoord::new(-1, 3),
        ChunkCoord::new(250_000, -250_000),
        ChunkCoord::new(-250_000, 250_000),
        ChunkCoord::new(17, -9),
    ]
}

/// Runs the rules of 0008 §1 a fixed `(seed, params, dims)` can check mechanically: `W::generate`
/// writes every element of its output slab regardless of what was there before, and its result
/// depends only on `(seed, params, chunk)` -- never on call order or repetition. Panics (via
/// `assert_eq!`) on the first violation.
pub fn assert_worldgen_contract<W: Worldgen>(seed: u64, params: &W::Params, dims: ChunkDims) {
    let area = dims.area() as usize;
    let chunks = sample_chunks();

    // "Must write every element of out": two different poison fills before `generate` must not
    // survive into the result. If any element were left unwritten it would still carry its own
    // poison pattern, and the two runs (different poison) would then differ there.
    for &chunk in &chunks {
        let mut a = vec![Tile(0x1111_1111); area];
        let mut b = vec![Tile(0xEEEE_EEEE); area];
        W::generate(seed, params, chunk, &mut a);
        W::generate(seed, params, chunk, &mut b);
        assert_eq!(
            a, b,
            "generate({chunk:?}) left a poison tile in place: not every element of out was written"
        );
    }

    // Chunk order and repetition never change output: the same set of chunks, generated forwards
    // then backwards, gives the same result per coordinate every time.
    let mut forward = Vec::with_capacity(chunks.len());
    for &chunk in &chunks {
        let mut out = vec![Tile::VOID; area];
        W::generate(seed, params, chunk, &mut out);
        forward.push(out);
    }
    for (i, &chunk) in chunks.iter().enumerate().rev() {
        let mut out = vec![Tile::VOID; area];
        W::generate(seed, params, chunk, &mut out);
        assert_eq!(
            out, forward[i],
            "generate({chunk:?}) changed when the chunk order was reversed"
        );
    }

    // Repetition: generating the same chunk again gives the same bytes.
    let mut repeat = vec![Tile::VOID; area];
    W::generate(seed, params, chunks[0], &mut repeat);
    assert_eq!(
        repeat, forward[0],
        "generate({:?}) changed on repetition",
        chunks[0]
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize, serde::Deserialize)]
    struct Params;

    struct Honest;
    impl Worldgen for Honest {
        type Params = Params;
        const WORLDGEN_VERSION: u32 = 1;
        fn generate(seed: u64, _params: &Params, chunk: ChunkCoord, out: &mut [Tile]) {
            for (i, t) in out.iter_mut().enumerate() {
                let h = crate::worldgen::hash2(seed, chunk.x, chunk.y).wrapping_add(i as u64);
                *t = Tile::new(h as u8, (h >> 8) as u8, (h >> 16) as u16);
            }
        }
    }

    struct LeavesLastTileAlone;
    impl Worldgen for LeavesLastTileAlone {
        type Params = Params;
        const WORLDGEN_VERSION: u32 = 1;
        fn generate(seed: u64, _params: &Params, chunk: ChunkCoord, out: &mut [Tile]) {
            let n = out.len();
            for (i, t) in out.iter_mut().take(n - 1).enumerate() {
                let h = crate::worldgen::hash2(seed, chunk.x, chunk.y).wrapping_add(i as u64);
                *t = Tile::new(h as u8, 0, 0);
            }
        }
    }

    #[test]
    fn assert_worldgen_contract_passes_an_honest_impl() {
        assert_worldgen_contract::<Honest>(42, &Params, ChunkDims::new(4));
    }

    #[test]
    #[should_panic(expected = "poison tile")]
    fn assert_worldgen_contract_catches_an_unwritten_tile() {
        assert_worldgen_contract::<LeavesLastTileAlone>(42, &Params, ChunkDims::new(4));
    }
}
