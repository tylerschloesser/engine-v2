//! `Tick`, `Ticks`, `TickRate` (docs/decisions/0003-game-facing-api.md `Game::TICK_RATE`,
//! `WorldRead::tick`). Conversions between `Tick` and `Ticks` (and to/from wall time) are M12b's
//! (docs/plan/12-store-and-game-trait.md Non-scope): this module only builds the three types.

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

/// The sim's tick rate (0006, 0010 own the number; `Game::TICK_RATE` names it). Only `hz()` and
/// `HZ_20` are built here -- conversions to/from wall time and `Ticks` are M12b's.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TickRate(u32);

impl TickRate {
    pub const HZ_20: TickRate = TickRate(20);

    #[inline]
    pub const fn hz(self) -> u32 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hz_20_is_20() {
        assert_eq!(TickRate::HZ_20.hz(), 20);
    }

    #[test]
    fn tick_and_ticks_order_by_value() {
        assert!(Tick(1) < Tick(2));
        assert!(Ticks(1) < Ticks(2));
        assert_eq!(Tick::default(), Tick(0));
        assert_eq!(Ticks::default(), Ticks(0));
    }
}
