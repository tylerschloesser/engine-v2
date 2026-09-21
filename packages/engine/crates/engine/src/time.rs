//! `Tick`, `Ticks`, `TickRate` (docs/decisions/0003-game-facing-api.md `Game::TICK_RATE`,
//! `WorldRead::tick`). Conversions between `Tick` and `Ticks` (and to/from wall time) are M12b's
//! (docs/plan/12-store-and-game-trait.md Non-scope): built here per
//! docs/decisions/0006-time-units.md "Conversion rule".

/// A tick index (0003: `u32`).
#[derive(
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Debug,
    Default,
    serde::Serialize,
    serde::Deserialize,
)]
pub struct Tick(pub u32);

impl Tick {
    #[inline]
    pub const fn add(self, d: Ticks) -> Tick {
        Tick(self.0.wrapping_add(d.0))
    }
}

impl core::ops::Add<Ticks> for Tick {
    type Output = Tick;
    #[inline]
    fn add(self, rhs: Ticks) -> Tick {
        self.add(rhs)
    }
}

/// A duration measured in ticks.
#[derive(
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Debug,
    Default,
    serde::Serialize,
    serde::Deserialize,
)]
pub struct Ticks(pub u32);

/// The sim's tick rate (0006, 0010 own the number; `Game::TICK_RATE` names it), fixed for a
/// world's life. Only [`TickRate::hz`] can construct one, so a game's `TICK_RATE` is always in
/// range (docs/plan/12b-world-access-and-sim-driver.md Scope).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TickRate(u32);

impl TickRate {
    pub const HZ_20: TickRate = TickRate::hz(20);

    /// Docs/decisions/0006-time-units.md "Conversion rule": the only constructor, and a compile
    /// error outside `10..=60` (0010 Rates) because `assert!` inside a `const fn` fails the const
    /// evaluation of any `const`/`static` initializer that calls it out of range -- exactly how a
    /// game declares `TICK_RATE`. `tickrate_hz_out_of_range`: the two doc tests below pin the two
    /// failing boundaries; a third, passing block pins 10 and 60.
    ///
    /// ```compile_fail
    /// const R: engine::time::TickRate = engine::time::TickRate::hz(9);
    /// ```
    ///
    /// ```compile_fail
    /// const R: engine::time::TickRate = engine::time::TickRate::hz(61);
    /// ```
    ///
    /// ```
    /// const A: engine::time::TickRate = engine::time::TickRate::hz(10);
    /// const B: engine::time::TickRate = engine::time::TickRate::hz(60);
    /// let _ = (A, B);
    /// ```
    #[inline]
    pub const fn hz(hz: u32) -> TickRate {
        assert!(
            hz >= 10 && hz <= 60,
            "tick rate must be in 10..=60 (0010 Rates)"
        );
        TickRate(hz)
    }

    /// The raw Hz value.
    #[inline]
    pub const fn hz_value(self) -> u32 {
        self.0
    }

    /// Integer-only, round to nearest with ties up, never zero for a non-zero duration (0006
    /// Decision, verbatim arithmetic).
    #[inline]
    pub const fn millis(self, ms: u32) -> Ticks {
        let t = (ms as u64 * self.0 as u64 + 500) / 1000;
        Ticks(if t == 0 && ms > 0 { 1 } else { t as u32 })
    }

    #[inline]
    pub const fn secs(self, s: u32) -> Ticks {
        self.millis(s * 1000)
    }

    /// `1.0 / hz`, for continuous dynamics only (0006: never for stored durations). Named `DT` in
    /// 0006's Decision block; spelled as a lower-case method here since `TickRate` values vary per
    /// game (`Game::TICK_RATE`), so it cannot be a single associated constant (docs/plan/
    /// 12b-world-access-and-sim-driver.md Deviations).
    #[inline]
    pub const fn dt(self) -> f32 {
        1.0 / self.0 as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hz_20_is_20() {
        assert_eq!(TickRate::HZ_20.hz_value(), 20);
    }

    #[test]
    fn tick_and_ticks_order_by_value() {
        assert!(Tick(1) < Tick(2));
        assert!(Ticks(1) < Ticks(2));
        assert_eq!(Tick::default(), Tick(0));
        assert_eq!(Ticks::default(), Ticks(0));
    }

    /// 0006 Consequences: unit-tested at two rates (20 and 30 Hz) against whole-second and
    /// sub-second durations, including the non-zero floor.
    #[test]
    fn ticks_conversion_20_and_30_hz() {
        let hz20 = TickRate::hz(20);
        assert_eq!(hz20.secs(2), Ticks(40));
        assert_eq!(hz20.millis(50), Ticks(1));
        assert_eq!(hz20.millis(1), Ticks(1)); // non-zero floor: never zero for ms > 0
        assert_eq!(hz20.millis(0), Ticks(0));
        // Round to nearest, ties up: 25ms at 20Hz is exactly 0.5 ticks.
        assert_eq!(hz20.millis(25), Ticks(1));

        let hz30 = TickRate::hz(30);
        assert_eq!(hz30.secs(2), Ticks(60));
        // 40ms at 30Hz = 1.2 ticks -> rounds to 1.
        assert_eq!(hz30.millis(40), Ticks(1));
    }

    #[test]
    fn millis_never_zero_for_nonzero_duration() {
        for hz in [10u32, 20, 37, 60] {
            let rate = TickRate::hz(hz);
            for ms in 1..=hz {
                assert_ne!(rate.millis(ms), Ticks(0), "hz={hz} ms={ms}");
            }
        }
    }

    /// `DT` equals `1.0 / hz` bit-exactly at 20, 30 and 60 Hz.
    #[test]
    fn dt_is_reciprocal() {
        assert_eq!(TickRate::hz(20).dt(), 1.0 / 20.0);
        assert_eq!(TickRate::hz(30).dt(), 1.0 / 30.0);
        assert_eq!(TickRate::hz(60).dt(), 1.0 / 60.0);
    }

    #[test]
    fn tick_add_ticks() {
        assert_eq!(Tick(5).add(Ticks(3)), Tick(8));
        assert_eq!(Tick(5) + Ticks(3), Tick(8));
    }
}
