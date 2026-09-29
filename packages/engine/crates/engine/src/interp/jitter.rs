//! [`JitterStats`]: p95 of the last [`WINDOW`] jitter samples from a fixed [`BINS`]-bin histogram
//! (Planning decisions: "no allocation, no sort").

/// Samples remembered (Planning decisions: "the last 128 samples").
pub const WINDOW: usize = 128;
/// Histogram bins (Planning decisions: "a fixed 32-bin histogram").
pub const BINS: usize = 32;
/// Width of one bin, ms. 32 bins x 16 ms cover 0..512 ms (the last bin saturates), enough to
/// reach 0010's 400 ms delay cap (needs p95 up to 350 ms). Reported p95 is the bin's upper edge,
/// so it over-reads by less than one bin width.
pub const BIN_MS: f32 = 16.0;

pub struct JitterStats {
    ring: [u8; WINDOW],
    counts: [u16; BINS],
    head: usize,
    len: usize,
}

impl Default for JitterStats {
    fn default() -> Self {
        Self::new()
    }
}

impl JitterStats {
    pub const fn new() -> Self {
        JitterStats {
            ring: [0; WINDOW],
            counts: [0; BINS],
            head: 0,
            len: 0,
        }
    }

    /// Samples currently held (at most [`WINDOW`]).
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn clear(&mut self) {
        *self = Self::new();
    }

    /// Records one non-negative jitter sample in ms (NaN and negatives count as 0).
    pub fn record(&mut self, ms: f32) {
        let ms = if ms > 0.0 { ms } else { 0.0 };
        let bin = ((ms / BIN_MS) as usize).min(BINS - 1);
        if self.len == WINDOW {
            let old = self.ring[self.head] as usize;
            self.counts[old] -= 1;
        } else {
            self.len += 1;
        }
        self.ring[self.head] = bin as u8;
        self.counts[bin] += 1;
        self.head = (self.head + 1) % WINDOW;
    }

    /// 95th percentile in ms: the upper edge of the bin holding the `ceil(0.95 n)`-th smallest
    /// sample; 0 when empty.
    pub fn p95_ms(&self) -> f32 {
        if self.len == 0 {
            return 0.0;
        }
        let need = (self.len * 95).div_ceil(100);
        let mut seen = 0usize;
        for (i, &c) in self.counts.iter().enumerate() {
            seen += c as usize;
            if seen >= need {
                return (i + 1) as f32 * BIN_MS;
            }
        }
        BINS as f32 * BIN_MS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p95_of_constant_and_window_eviction() {
        let mut j = JitterStats::new();
        assert_eq!(j.p95_ms(), 0.0);
        for _ in 0..WINDOW {
            j.record(20.0);
        }
        assert_eq!(j.p95_ms(), 32.0);
        // 128 large samples fully evict the small ones.
        for _ in 0..WINDOW {
            j.record(100.0);
        }
        assert_eq!(j.len(), WINDOW);
        assert_eq!(j.p95_ms(), 112.0);
    }

    #[test]
    fn p95_ignores_top_five_percent() {
        let mut j = JitterStats::new();
        for _ in 0..95 {
            j.record(5.0);
        }
        for _ in 0..5 {
            j.record(300.0);
        }
        assert_eq!(j.p95_ms(), 16.0);
        j.record(300.0); // 6 of 101 above: p95 now lands in the tail
        assert_eq!(j.p95_ms(), 304.0);
    }

    #[test]
    fn saturates_in_last_bin() {
        let mut j = JitterStats::new();
        j.record(5000.0);
        assert_eq!(j.p95_ms(), 512.0);
    }
}
