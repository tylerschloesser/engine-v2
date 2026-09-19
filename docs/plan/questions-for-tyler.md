# Questions for Tyler

One batch, asked once at the end of Phase 2 (2026-09-19). Planning proceeds on the **default** until answered; `PLAN.md` marks dependent milestones with **T**. When an answer arrives: record it in the spec Requirements if it changes them, update the row here, and edit any brief the answer changes. Later phases append new rows rather than asking one at a time.

Detail for Q1–Q6 is in `PRE-PLAN.md` §11 (item numbers in brackets).

| # | Question | Default assumed | Depends on it | Answer |
|---|---|---|---|---|
| Q1 | [1] Approve `serde_json` in the engine crate (UI action JSON + one-time config inside WASM), `ts-rs` as a normal dependency that LTO removes, and `libm` pinned only if a transcendental is ever needed? | Approved | M16 (JSON actions), M35 (size test watches `ts-rs`) | |
| Q2 | [2] Amend the zero-GC Requirement in `docs/spec/testing.md`: net worker budgeted at ≤ 1 KB per message with zero major GCs instead of "approximately zero"; main-thread figure replaced by the measured floor? | Amend as proposed; ADR 0016 is the operative reading meanwhile | M04, M29 | |
| Q3 | [4] Amend the deltas/prediction Requirement wording in `docs/spec/sync.md` and `docs/spec/overview.md` to the text proposed in `PRE-PLAN.md` §11 item 4 (engine derives deltas and prediction; game defines data, rules, presence, opt-outs)? | Amend as proposed; ADRs 0003, 0011, 0012 are the operative reading meanwhile | M12, M25 | |
| Q4 | [5] Collect range for the reference game: 3 tiles, centre of player to centre of tile? | 3 tiles | M20 | |
| Q5 | [6] Devices for manual checks: is there a mid-range 4 GB Android phone, or is Android checked on desktop Chrome only? (An iPhone 12-class or newer on iOS 26+ is assumed.) | iPhone + desktop Chrome only | `docs/plan/device-checks.md` | |
| Q6 | [7] Spend: Cloudflare Workers paid plan ($5/month) for the Durable Objects check; one real static-host deploy for the COOP/COEP check; a Fly machine to verify the hosting cost target rather than compute it? | All three approved, used only in M38 | M38 | |

Resolved without asking: [3] the Xcode license. Native linking works on this machine without `DEVELOPER_DIR` (checked 2026-09-19 with `cc`), so native `cargo test` and the `ts-rs` step will link.

Heads-up, no action: [8] tuning of the 128-chunk cap at maximum zoom-out (risk 3) is measured in M31; if it needs a different default zoom range or cap, that changes `docs/spec/client.md` numbers and will come back as a question.
