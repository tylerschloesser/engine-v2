---
paths:
  - "packages/engine/src/**"
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

Verified by the `gc-test` skill; a new hot path gets a page or joins one (`docs/decisions/0016-zero-gc-definition.md` §3, `docs/plan/04-zero-gc-harness.md`).
