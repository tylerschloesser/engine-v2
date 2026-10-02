# M39d: A full world lets a returning player back in

Status: not started · After: 39c steps 1-2 (`727bfa4`) · Tyler-dependent: no

## Goal
Found by M39c step 2 (row `0013 Identity (max_players)`, [M39c Deviations](39c-acceptance-gap-tests.md#deviations)): the default `maxPlayers` 8 equals `MAX_CONNS` 8 (`src/server.ts:142`; Rust `host::MAX_CONNS = warm::MAX_VIEWS`). In a world with 8 players, a connection beyond the 8th finds no slot, `SimHost.accept` throws and the adapter closes it with `CloseCode.Full`; the admission branch that sends `Reject{Full}` (`server.ts` ~1440) can never fire at the default. The user-visible defect: a player whose socket died silently and who redials **before** the host declares the old connection dead (0013: 3 s) is refused `full`, and `createLink` stops for good on `full`, so that player is locked out of a full world until reload, although 0013's supersede rule (same secret replaces the old connection) exists for exactly that case. Fix it so that, at the default `maxPlayers`, a returning player is admitted (superseding the old connection) and a ninth *distinct* player gets `Reject{Full}`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0013-sessions-and-integrity.md` (identity, `max_players`, supersede, liveness)
3. `src/server.ts` (`accept`, the handshake's admission and supersede paths), `crates/engine/src/host/mod.rs` (`MAX_CONNS`, and what `warm::MAX_VIEWS` sizes)

## Scope
- **Step 1, measure and propose (no code change).** Name the options and their cost, measured: (a) connection slots above `maxPlayers` (what `MAX_VIEWS` sizes per view, arena bytes per extra slot, per-tick work per slot; a handshake-only slot that is not a view would avoid most of it), (b) the handshake accepting a `Hello` into a transient slot and reclaiming the superseded one, (c) anything else you find. Report to the orchestrator and stop; the orchestrator rules (an ADR if 0013's or 0015's numbers change).
- **Step 2, build the ruled option** with the tests below.

## Non-scope
Changing the default `maxPlayers`; client link policy (`full` stays terminal); any transport adapter beyond keeping its `CloseCode.Full` fallback for a slot table that is truly exhausted.

## Files, packages and crates touched
`packages/engine/src/server.ts`, `packages/engine/crates/engine/src/host/**` if the ruled option needs it, tests in `packages/engine/tests/netcode/` and `crates/engine/tests/`.

## Seams
**Provides:** the behaviour above. **Consumes:** `createWorldServer`, `SimHost.accept`, the handshake (M13, M28, M30), the in-memory netcode harness.

## Planning decisions
- The test must use the production `accept` path (the in-memory harness today calls `accept` without the adapter's catch, so a ninth `accept` throws there: make the harness behave like the adapters, or test through `attachWebSocketServer`).

## Order of work
Step 1, report; step 2 after the ruling.

## Tests added
`netcode`: `full-world/returning-player-supersedes` (8 players; one player's socket dies silently; it redials with its secret before 3 s; it is admitted, the old connection is superseded, 8 players remain); `full-world/ninth-player-gets-reject-full` (a ninth distinct secret receives a `Reject{Full}` frame, then the close). Both inject-fail-reverted. The M39c row `0013 Identity (max_players)` and the maxPlayers part of `0009 WorldConfig defaults` cite them.

## Exit criteria
- [ ] Both tests pass and fail without the fix.
- [ ] The two M39 table rows are `covered`.
- [ ] Fast tier inside budget; `pnpm test` and `pnpm lint` green.

## Verification commands
`pnpm test netcode -t full-world` · `pnpm acceptance:check` · `pnpm test` · `pnpm lint`

## Budgets
Arena and per-tick costs of any extra slot, measured in step 1.

## Context artifacts
None.

## Manual device checks
None.

## Deviations
- **Ruling (orchestrator):** option (a), 16 slots, plus admission by distinct attached players decided after the hash, plus `maxPlayers` > 8 rejected at construction. ADR [0053](../decisions/0053-connection-slots-and-full-admission.md) amends 0013; 0015's memory table names no slot count, so it is untouched.
- **Brief gap found in step 1:** more slots alone do not fix the defect. The admission check ran before the hash and counted connections, so a returning player would still get `Reject{Full}`. Fixed in `settle` (`server.ts`): count distinct `playerId`s that are settled or queued-and-resolved; a secret mapping to one of them supersedes; otherwise at `maxPlayers` it is refused with `Reject{Full}` and the close, no session created, queue slot spliced out.
- **Seams:** `server.ts` exports `MAX_CONNS = 16` and `MAX_PLAYERS_LIMIT = MAX_CONNS / 2`; `warm::MAX_VIEWS = 16` (`host::MAX_CONNS` follows). `createWorldServer` throws `maxPlayers N is out of range (1..=8; ...)` outside `1..=8`.
- **Measured (M3 Max, release):** empty slot 1368 B (`Option<ConnSlot>`) + 20 B warm view + 1 B `ever_joined`; occupied adds about 6 KB of subscription buffers at the 128-chunk cap (computed from field sizes, not measured); arena fixed, so 8 more empty slots (about 11 KB) cause no growth. `slow_tick_large_save` median, 8 slots: 2.897, 2.935, 2.913 (load 4-8). 16 slots, load about 4: 2.9087, 2.8979, 2.9002 (earlier at load 4-7: 2.902, 2.896, 2.899, 2.913). No measurable per-tick cost; headroom still about 3 %.
- **Tests:** `tests/netcode/full-world.test.ts`: `returning-player-supersedes`, `ninth-player-gets-reject-full`, `max-players-above-half-the-slots-is-rejected`. Inject-fail-reverted: without the returning-player check `AssertionError: expected 4004 to be undefined` (Full close code); without the Full branch `one Reject frame, then the close: expected 2 to be 1` (the ninth got a Welcome); without the construction check `promise resolved ... instead of rejecting`.
- **Acceptance rows:** `0013 Identity (max_players)` covered; `0009 WorldConfig (defaults)` split, the new `(defaults: maxPlayers)` row covered, the remaining defaults row stays `gap` (rate, arena, cache, joinKey), so `pnpm acceptance:check` still reports it (and the unticked device checks).
- `pnpm test netcode` (140) and `pnpm test rust -t host` pass; the full `pnpm test`/`pnpm lint` were not run, per instruction.
