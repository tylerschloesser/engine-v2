// Shared constants for the SPSC ring. ctrl is an Int32Array over its own small SAB.
export const SLOT_BYTES = 1024
export const SLOTS = 256 // power of two
export const MASK = SLOTS - 1
export const HEAD = 0 // written only by the producer (worker)
export const TAIL = 1 // written only by the consumer (main)
export const DROPS = 2 // producer increments when the ring is full
export const PER_TICK = 10 // 10 x 1024 B ~= 10 KB per 16 ms tick
export const TICK_MS = 16
