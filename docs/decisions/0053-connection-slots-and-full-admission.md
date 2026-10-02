# 0053: Sixteen connection slots; `Full` counts attached players

Status: Accepted (2026-10-02). Amends [0013](0013-sessions-and-integrity.md) (Identity: `max_players`, the same-secret supersede rule). Implemented by M39d in `packages/engine/src/server.ts` and `crates/engine/src/host/warm.rs`.

## Context

[0013](0013-sessions-and-integrity.md) says the same secret replaces the old connection, and that a player whose socket died silently is only declared dead after 3 s. [0009](0009-world-config.md)'s default `maxPlayers` is 8, and the sim host's connection table (`host::MAX_CONNS = warm::MAX_VIEWS`, mirrored as `MAX_CONNS` in `server.ts`) was also 8. M39c step 2 found the consequence. In a full world a socket that died silently and redialled with its secret inside those 3 s found no free slot: `SimHost.accept` threw, the adapter closed the socket with `CloseCode.Full`, and `createLink` stops for good on `full`. The supersede rule could never run in the one case it exists for. The `Reject{Full}` branch of the handshake was unreachable at the default, and counted connections rather than players, so a redial would have been refused even with a spare slot.

`packages/engine/tests/netcode/full-world.test.ts` reproduced it first: 8 players, client 0's link stalled, a redial with its secret, `SimHost.accept: no free connection slot (MAX_CONNS = 8)`.

Measured (M39d step 1, Apple M3 Max, release): an empty `Option<ConnSlot>` is 1368 B, plus 20 B in `Warm.views` and 1 B in `ever_joined`, about 1.4 KB per empty slot. An occupied slot also reserves its subscription buffers at connect, about 6 KB at the default 128-chunk cap (computed from the field sizes, not measured with the allocator). The arena is a fixed size, so 8 more empty slots (about 11 KB) cause no growth event. `slow_tick_large_save` median with 16 slots: see Consequences.

## Decision

**1. Sixteen connection slots.** `warm::MAX_VIEWS` (and so `host::MAX_CONNS`) and the TypeScript `MAX_CONNS` are 16, twice the largest `maxPlayers`. The spare half is reconnect headroom: slots a returning player's new connection occupies for the moment before it supersedes the old one.

**2. `maxPlayers` is at most `MAX_CONNS / 2` (8).** `createWorldServer` throws at construction for a `maxPlayers` outside `1..=8` with a message naming the limit. It does not clamp: before this a larger value was accepted and silently capped by the slot count.

**3. `Full` is decided after the secret's hash resolves, on attached players.** A `Hello` that clears the build-hash and join-key checks is queued as before. In `settle`, once the secret's digest is known, the host counts the distinct players that are attached (settled, or resolved and queued ahead of this `Hello`). A secret that maps to one of them supersedes it per 0013 and is never `Full`. A secret that does not, and finds `maxPlayers` players attached, gets `Reject{Full}` and the close, creates no session entry and leaves no queue entry. The 3 s liveness timer and the supersede mechanics are unchanged.

**4. The adapters' `CloseCode.Full` fallback stays** (`server-node.ts`, `server-bun.ts`, `server-deno.ts`) for a slot table that is truly exhausted: 16 simultaneous unresolved connections.

## Alternatives rejected

- **One spare slot (9).** Two returning players inside one attach window (several networks dropping together) would still be refused `full`, which is terminal client-side.
- **A transient handshake slot reclaimed on supersede.** Every closure in `accept` and the pump captures its `conn` by value, so moving a connection to the superseded index means re-keying `conns`, `handshakeState` and those closures, and a TS-id to Rust-slot map on every `sim.*` call. The new connection's warm view still needs an index. About 80-120 lines across several seams to save about 11 KB.
- **Raising `maxPlayers` instead.** Out of scope: the default is a product decision.

## Consequences

- 0015's memory table does not name the slot count, so it is untouched.
- A world cannot be configured above 8 players. A larger world needs `MAX_VIEWS` raised and this ADR superseded.
- The per-tick cost of an empty slot is one null check in the TS and Rust connection loops; the `slow_tick_large_save` figures are in the M39d brief's Deviations.
- Reject-after-hash means a refused `Hello` now costs one digest. It is bounded by the 16 slots.

## Sources

- M39c step 2 finding, `docs/plan/39c-acceptance-gap-tests.md` Deviations; M39d step 1 measurements, `docs/plan/39d-full-world-reconnect.md` Deviations (2026-10-02).
