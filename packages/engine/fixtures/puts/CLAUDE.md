# fixtures/puts (`fx-puts`)

The puts-coverage fixture (docs/decisions/0003-game-facing-api.md Consequences: "the puts cover
every replicated scope of [0011](../../../../docs/decisions/0011-wire-format-and-deltas.md)").
M12 (docs/plan/12-store-and-game-trait.md) declares its replicated types only -- `Action`,
`Reject`, `Entity`, `Player`, `Global` (`Ui` was `()`) -- so `Store<Puts>`/`Delta<Puts>` compile
against a real, non-trivial type set, natively and for `wasm32`. `impl Game` (`register`,
`prototype`, `anchor`, `genesis`, `on_player`, `apply`, `tick`, the `Sim` role) lands in M12b.

M16b (docs/plan/16b-ui-observation-and-clock.md) gives `Ui` a real shape: `PutsClient::ui` mirrors
`Global::motd`/`day` (every client) and the caller's own `Player::note`/`note_until` (player-scoped)
into `PutsUi { motd, note, note_until, global_ticks }` -- `bindings/PutsUi.ts`.

M13 (docs/plan/13-sim-host-tick-loop.md) switches the one line of ABI this fixture writes from
`engine::export_instance!(Puts)` to `engine::export_game!(Puts)`, which re-points at
`engine::game_instance::GameInstance<Puts>`: the `.wasm` now has a real sim role
(`sim_genesis`/`sim_tick`/`sim_hash`, driving the same `Sim<Puts>` `tests/*.rs` already drove
directly), so `puts_idle_100`'s golden is `.wasm`-authoritative (`fixtures/puts/golden/
scenario.json` + `pnpm golden puts`) instead of native-blessed. The `gen`/`client` roles exist
(every fixture's `.wasm` carries every export) but nothing in this fixture exercises them yet.
