//! Shared support for the M40 and M41 spikes (`tests/spike_repr.rs`, `tests/spike_forecast.rs`): the standard belt world, the three
//! candidates of docs/decisions/0077 §1 behind one trait, and the release re-run helper.
//! `#![allow(dead_code)]` in each module: every `tests/*.rs` file is its own binary that includes
//! this tree whole.

pub mod bench_run;
pub mod forecast;
pub mod repr;
pub mod repr_a;
pub mod repr_b;
pub mod world;
