# 0074: `Persistence.open` instantiates the module once on a clean load

Status: Accepted (2026-10-10). Settles [0065](0065-phase-3-decisions-persistence.md) §14; [0051](0051-durable-objects-no-go.md)'s revisit condition ("fix the double instantiation") is met, the Durable Object retry itself is not done.

## Context

0065 §14: on a restore, `Persistence.open` created a probe instance for the `chunk_bits` check and `loadLatest` a second one for the load, neither released before the first GC (Node: `WebAssembly.Instance` count 2; at scale 1, `external` 99 to 221 MiB). Peak two arenas: the cause of the Durable Object no-go and a startup spike on a 1 GB Fly machine.

## Decision

`open` hands its probe to `loadLatest` as the first instance `loadLatest` asks for (a one-shot wrapper around `newInstance`). The probe has only answered `chunk_bits()`, a pure read, and `loadLatest`'s first instance only ever runs `sim_segment_header` before its first restore candidate. A clean load, from a snapshot or by genesis replay, now instantiates once: `open_instantiates_once_on_a_clean_load` counts the `newInstance` calls. A recovery still takes a fresh instance per rejected snapshot candidate (each restore attempt may leave its instance half-written); that path is rare and was not part of the measured spike.

## Alternatives rejected

- **Read `chunk_bits` from `game.json`.** `chunk_bits()` is the running build's own value (0065); a metadata file could disagree with the `.wasm` it ships beside.
- **Release the probe explicitly.** A `WebAssembly.Instance` has no free; only dropping every reference before the next instantiate releases it, and that waits on GC.

## Sources

- `packages/engine/tests/wasm/persist-open.test.ts` `open_instantiates_once_on_a_clean_load` (2 before the change, 1 after).
