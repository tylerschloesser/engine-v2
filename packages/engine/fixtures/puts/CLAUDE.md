# fixtures/puts (`fx-puts`)

The puts-coverage fixture (docs/decisions/0003-game-facing-api.md Consequences: "the puts cover
every replicated scope of [0011](../../../../docs/decisions/0011-wire-format-and-deltas.md)").
M12 (docs/plan/12-store-and-game-trait.md) declares its replicated types only -- `Action`,
`Reject`, `Entity`, `Player`, `Global` (`Ui` is `()`) -- so `Store<Puts>`/`Delta<Puts>` compile
against a real, non-trivial type set, natively and for `wasm32`. `impl Game` (`register`,
`prototype`, `anchor`, `genesis`, `on_player`, `apply`, `tick`, the `Sim` role) lands in M12b.

Until then `Instance` is implemented directly (M02 conventions), every role but `init` defaulting
to `Status::Unsupported`: enough to build and pass the import allowlist test
(`tests/wasm/allowlist.test.ts`), not to run.
