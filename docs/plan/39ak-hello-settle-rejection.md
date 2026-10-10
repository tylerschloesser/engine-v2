# M39ak: a rejected `Hello` settle must not stall every later `Hello`

Status: done (2026-10-10) · After: 39aj · Tyler-dependent: no

## Goal
Found by the M39b sweep (ADR 0064 §26; noted in `packages/engine/CLAUDE.md`). In `packages/engine/src/server.ts`'s `Hello` handler (about lines 1491-1561), the async `settle` awaits `hashSecretHex(parsed.playerSecret)` and, for a new secret, `deps.sessions.save()`. If either rejects (a digest failure; a full or failing disk on a server):
1. `resolveMyTurn()` is never called, so `sessionMutationChain` never resolves and **every later `Hello`'s `await myTurn` waits forever**;
2. the arrival's `slot` stays in `attachQueue` with no `entry`, so the in-order attach drain is blocked behind it;
3. `settle.finally(...)` leaves the rejection unhandled.
One bad handshake therefore stops the server admitting anyone. When this is done, a rejected settle releases its turn, removes its slot, closes that connection with a handshake close code, and later `Hello`s are admitted normally.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0013-sessions-and-integrity.md` (handshake; close codes) and `docs/decisions/0053-connection-slots-and-full-admission.md` (Full counts players)
3. `packages/engine/CLAUDE.md`, `packages/engine/src/CLAUDE.md`, `packages/engine/tests/netcode/CLAUDE.md`
Rules that apply: `.claude/rules/hot-paths.md` does not cover the server (0016 excludes it), but keep the handshake path's existing shape.

## Scope
1. Wrap `settle`'s body so any rejection: calls `resolveMyTurn()` exactly once (also on the success and `Full` paths, as now), removes `slot` from `attachQueue`, and, if the connection is still this arrival's (`handshakeState.get(conn) === state && conns[conn] === connection`, as the `Full` path checks), closes it with the close code the handshake uses for a server-side failure (pick from `src/host/handshake.ts`'s `CloseCode`; if none fits, say which you used and why, or add one per 0013). Surface the error once through the host's existing error/log path (whatever `server.ts` already uses for a handshake trace or fatal), never silently.
2. `settle` never produces an unhandled rejection.
3. Remove the "Open gap" sentence from `packages/engine/CLAUDE.md` once fixed.

## Non-scope
Retrying the save; changing the session-table format; anything outside the `Hello` handler.

## Files touched
`packages/engine/src/server.ts`, a netcode or unit test, `packages/engine/CLAUDE.md` (one sentence removed), `src/host/handshake.ts` only if a close code is added.

## Tests added
- `hello settle rejection does not stall later hellos` (netcode suite, or unit if the server can be driven there with fakes): inject `deps.sessions.save` (or the digest) to reject once for the first `Hello`; the first connection is closed with the chosen code; a second `Hello` with a new secret is admitted (gets `Welcome`) within a bounded number of ticks. Inject-fail-revert: with the try/catch removed, the second `Hello` never gets `Welcome` (the test must fail by a bounded wait, not hang the suite). Paste the red.
- If practical, the same for a rejection on a returning secret (digest path only).

## Exit criteria
- [x] A rejected settle releases `sessionMutationChain`, removes its slot and closes its connection (test named, red pasted).
- [x] No unhandled rejection from `settle`.
- [x] The "Open gap" line is gone from `packages/engine/CLAUDE.md`.
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test netcode -t "settle"` (or `unit`). Foreground, bounded.

## Manual device checks
None.

## Deviations

- Close code: `CloseCode.ProtocolError` (4005). No server-failure code exists; `src/net/link.ts` treats it as transient, so the client simply redials. No code added.
- Error surfacing: `host.handshakeTrace` (`hello settle failed conn=N: <message>`) only; `server.ts` has no other non-fatal log path, and `onFatal` would stop the world. Silent when no trace is set (as every other handshake trace).
- Shape: the body is now `settleBody()` and `settle = settleBody().catch(...)`; the catch calls `resolveMyTurn()` again (idempotent), splices `slot`, traces, and closes if the connection is still this arrival's.
- Not undone: a new secret whose `save()` rejected stays in the in-memory session table (no remove API; table format is non-scope). A redial with that secret is admitted from memory and persisted by the next successful save.
- Tests: `handshake.test.ts` `hello settle rejection does not stall later hellos` (save) and `... (digest) ...`. Red with the `resolveMyTurn()` in the catch removed: `AssertionError: expected false to be true` at handshake.test.ts:603 and :610 (bounded 2 s race, 4.8 s run).
- **Gate (orchestrator):** accepted. `pnpm test` green (netcode 149: the two new tests), `pnpm lint` green; inject-fail red pasted by the implementer. Accepted: `ProtocolError` (4005, transient, so the client redials); the failure is surfaced only through `handshakeTrace` (the server has no non-fatal log path; `onFatal` would stop the world); a new secret whose `save()` failed stays in the in-memory table and is made durable by the next successful save (recorded, no decision needed).
