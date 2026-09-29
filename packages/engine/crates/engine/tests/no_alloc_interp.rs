//! Own test binary (only a dedicated binary's `#[global_allocator]` is counted; see
//! `no_alloc_gen_queue.rs`). docs/plan/30-interpolation.md `interp_alloc`: 600 frames of
//! `InterpBuffer` pushes/samples over 7 remote keys plus `InterpDelay` arrivals/slew allocate zero
//! bytes once the keys exist (`.claude/rules/hot-paths.md`).

use engine::abi::Arena;
use engine::game::PlayerId;
use engine::interp::{InterpBuffer, InterpDelay, InterpKey};
use engine::time::{Tick, TickRate};
use engine::world::WorldPos;

#[global_allocator]
static ALLOCATOR: Arena = Arena;

fn live() -> usize {
    engine::abi::arena::live_bytes()
}

#[test]
fn interp_alloc() {
    let mut buf = InterpBuffer::<InterpKey>::new(20);
    let mut delay = InterpDelay::new(TickRate::hz(20));
    let key = |i: u32| InterpKey::Player(PlayerId(i));
    let mut sink = 0i64;
    let mut frame = |buf: &mut InterpBuffer<InterpKey>, delay: &mut InterpDelay, f: u32| {
        let host = 10.0 + f as f64 * 0.5; // frames at 40 Hz against a 20 Hz tick
        delay.advance(25.0);
        if f.is_multiple_of(2) {
            let tick = f / 2;
            delay.on_arrival(Tick(tick), tick as f64 * 50.0 + ((f * 13) % 40) as f64);
            for i in 1..=7 {
                let x = (tick as i32) * 90 + i as i32 * 1000;
                buf.push(key(i), tick as f64, WorldPos { x, y: -x }, [1800, -1800]);
            }
        }
        let rt = delay.render_time(host);
        for i in 1..=7 {
            if let Some(s) = buf.sample(key(i), rt) {
                sink += s.pos.x as i64 + s.alpha as i64;
            }
        }
    };
    for f in 0..40 {
        frame(&mut buf, &mut delay, f);
    }
    let before = live();
    for f in 40..640 {
        frame(&mut buf, &mut delay, f);
    }
    assert_eq!(live(), before, "interp allocated in steady state");
    assert_ne!(sink, 0);
}
