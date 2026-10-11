# 0075: The reference page reloads once on `WorldMismatch`

Status: Accepted (2026-10-10). Settles [0064](0064-phase-3-decisions-sync-and-netcode.md) §16 for the reference game; the engine keeps [0042](0042-remote-client-world-config-from-welcome.md) §5 (no engine policy: "a page decides for itself").

## Context

A server restarted on the same address with another world (another seed or params) makes every connected page's redial end in `onLink` `rejected` `WorldMismatch`: the client's world came from the first `Welcome` and cannot change under it (0042 §5). The reference page showed "The server runs a different world." and stayed there. 0064 §16 also noted there was no end-to-end test.

## Decision

The reference page's status UI (`src/ui/status.ts`) reloads the page on `rejected` `WorldMismatch`, once per tab: `sessionStorage['reference.worldMismatchReload']` is set before the reload and cleared on the next `online`. A fresh page takes its world from its first `Welcome`, so the reload lands on the new world. A second mismatch in a row (the guard still set) shows the message and does not reload again. Storage that throws reloads every time, as the engine's version-mismatch guard does. Test: `reference_world_mismatch_reloads_once_onto_the_new_world` (`tests/browser/world-mismatch.spec.ts`) stops a server, starts one on the same port with another seed, and checks one reload, `online`, other resources in range and the guard cleared.

## Alternatives rejected

- **An engine default like `onVersionMismatch`.** 0042 §5 left the choice to the page on purpose: a page may hold unsaved local state worth showing before a reload. The reference game has none to lose (its remote world lives on the server).
- **Reload without a guard.** A server that alternates worlds, or a page whose cached bundle disagrees, would loop.

## Sources

- `games/reference/tests/browser/world-mismatch.spec.ts`: passes; with the reload disabled it fails with 0 reloads.
