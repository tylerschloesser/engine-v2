---
paths:
  - "packages/engine/src/**"
  - "packages/engine/crates/engine/src/world/cache.rs"
  - "packages/engine/crates/engine/src/gen_queue.rs"
  - "packages/engine/crates/engine/src/view.rs"
  - "packages/engine/crates/engine/src/client/**"
---

# Hot paths: no allocation per frame or per tick

The JS around every WASM instance must stay within the per-frame allocation budget of `docs/decisions/0016-zero-gc-definition.md`; the boundary is shaped for it in `docs/decisions/0014-js-wasm-boundary.md` §4. Test-only code (`src/test/**`, `*.test.ts`) and one-time setup are exempt; the server is outside 0016.

In code that runs every frame, tick or message:

- **Views are created once.** Typed-array views over WASM memory and SAB slots are built at init and reused. Never `subarray()`, `slice()` or `new Uint8Array(...)` in steady state: copy whole blocks with `dst.set(src, offset)` through view pairs made at init.
- **Exports are called through `call0` / `call1` / `call2`** of `EngineInstance` (`packages/engine/src/loader.ts`) and nothing else: fixed arity (no rest array), dead check, trap capture, and the detach check that rebuilds views after `memory.grow`. Read memory through `inst.mem` and a region through its `RegionView` holder every time; never cache their `u8`.
- **Numbers only across the boundary.** No strings, objects, `BigInt`, closures or arrays per call. A 64-bit value is two `u32` in a region. Text (`engine.log`, panic, config, UI JSON) is for init and human-rate paths; a log call inside a measured window is meant to fail 0016.
- No per-iteration closures, spreads, destructuring into new objects, `Array.prototype` callbacks, template strings, or `try` blocks that build an error on the normal path. Preallocate scratch objects at init and mutate them.
- `memory.grow` after init is tolerated but counted (`memGrows()`, `docs/decisions/0015-threads-memory-and-topology.md` §5): steady state expects 0.
- SAB views, descriptors and event objects (`src/sab/**`, `src/camera/**`) are created in constructors and mutated afterwards; no `subarray()`, closures or literals on a per-frame, per-tick or per-message path (`src/sab/no-alloc-syntax.test.ts`). No `postMessage` in steady state (`docs/decisions/0015-threads-memory-and-topology.md` §2): setup, fatal errors and lifecycle only.
- No double-valued temporaries on a per-pass path: integer or Smi values and module-level constants only; WASM reads times from its own region rather than JS reading a `Float64Array` element and passing it.

- No cold branch inlined into a per-frame drain: an inlined never-taken `fatalRejectSeqs` drain put a one-off ~14 KB into `main`'s window 1 and made `neg object` controls red 3 in 24; outline it (`flushFatalRejects()`). Boxing a number in a guard costs bytes too (`Number.isFinite(a + b + c)` boxed a HeapNumber per zoom: 193.5 B/frame against 190; three separate calls read 180.4); a "no allocation" claim from reading code is not evidence, the gc page is.
- Time on a per-frame path: `cameraState.frameTimeMs` is a timestamp feeding the 50 ms uplink limit and 1 s keep-alive. Production forwards rAF's own timestamp into `tick(tMs)` with no clock read (a nominal `FRAME_MS` runs the uplink 2x fast at 120 Hz); `createResyncingClock` (`RESYNC_FRAMES = 30`, not 8: each read costs ~12 B) is only the fallback for `stepFrame`-style callers owning their clock. A budget may go down, never up.
- Park signals: a park request must bump and notify the very word the waiter waits on (`Wake`/`Req`), never just store a flag; every blocking loop checks the yield flag before its first wait. `sab.atomics_wait_confined` pins two `Atomics.wait` sites; a race test must import the shared `signalPark`/`signalWake`, not copy them (a copy stayed green with the bump deleted). A worker that crashes after setup never rejects a pending `parkOne`/`send` (open).
- Harness spin-waits (`stepFrame`, `stepSimTickSync`, `asHarness.stepTick`) have no wall-clock ceiling, only `SPIN_LIMIT` (2e9): a periodic `now()` boxed a HeapNumber and broke `sim`'s budget of 0; `now()` is read once, on the failure path. A hang then shows as a bare 30 s Playwright timeout, as does `createHarness` `send`/`parkOne` (no timeout of its own).
- Tests of these properties: a no-alloc test asserts growth over a long window equals a short one and states real growth per unit of new work, never per tick. A test deriving its numbers from the constant under test cannot fail (`recovery_loop_guard` pins the literals 3 and 1,200). `tick_state_steady_no_alloc` compares net bytes, so an alloc-then-free pair is invisible: per-call allocation needs a `no_alloc_*` counting-allocator test.
- WebKit fires `gesturestart`/`gesturechange` for every two-finger touch (the engine's own pinch), Chrome none: "gesture events fired" does not mean "the page zoomed" (use `visualViewport.scale`). `GestureEvent` has no `offsetX`/`Y`; `clientX/Y` were never machine-verified (WebKit's IDL is private), so a non-finite point falls back to the canvas centre.

Verified by the `gc-test` skill; a new hot path gets a page or joins one (`docs/decisions/0016-zero-gc-definition.md` §3, `docs/plan/04-zero-gc-harness.md`).

`world/cache.rs` is Rust, not JS: the boundary-specific bullets above (views, `call0`/`call1`/`call2`, SAB) do not apply, but the same no-allocation-per-tick principle does -- `world.tile()` runs on every read, cache hit or miss. Verified natively by `no_alloc_terrain` (`abi::arena::live_bytes()` unchanged across reads and LRU churn); overlay growth (writes, world state) is the one allowed exception.

`gen_queue.rs`, `view.rs` and `client/**` (docs/plan/08b-gen-workers-and-queue.md) are the same: `GenQueue::set_view`/`take`/`complete` and `client::TerrainFeed::on_frame` run every client frame, in the queue's own preallocated storage (`pending`/`in_flight` reserved once at `new`, never reallocated). Verified natively by `no_alloc_gen_queue` (its own binary, `tests/no_alloc_gen_queue.rs`: a `#[global_allocator]` only counts allocations in the binary that installs it, so this cannot be an inline `#[cfg(test)]` module inside `gen_queue.rs` itself).
