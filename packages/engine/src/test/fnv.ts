// 64-bit FNV-1a, byte-identical to `engine::hash::Fnv64` (docs/decisions/0002 §3;
// crates/engine/src/hash.rs). Test-only: reads bytes out of a region and checks them against a
// hash computed elsewhere (native, or `engine::hash::hash_value`), so BigInt's cost does not
// matter (docs/plan/05-codec-and-state-hash.md).

const OFFSET = 0xcbf2_9ce4_8422_2325n
const PRIME = 0x100_0000_01b3n
const MASK64 = (1n << 64n) - 1n

/** 16 lower-case hex digits, the hash string convention `readU64Hex` and `golden.json` use. */
export function fnv1a64Hex(bytes: Uint8Array): string {
  let h = OFFSET
  for (const b of bytes) {
    h = ((h ^ BigInt(b)) * PRIME) & MASK64
  }
  return h.toString(16).padStart(16, '0')
}
