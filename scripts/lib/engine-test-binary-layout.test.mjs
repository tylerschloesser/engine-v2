// Guard for docs/plan/24c-engine-edit-rebuild-time.md: `crates/engine/tests/` must not quietly grow
// a new top-level `*.rs` file, because each one is its own compiled+linked test binary, and on
// macOS every freshly linked binary pays a one-time first-execution security-check tax (Deviations
// has the measurement: ~1.2-3s each, serial-ish across the binaries a build touches) -- the whole
// reason `tests/main.rs` (`#[path]`-including `tests/main/*.rs`) exists, consolidating what used to
// be 14 separate binaries into one. Deterministic: reads the directory listing, no cargo call, no
// timing, no flakiness.
//
// Two kinds of top-level file are allowed to exist outside `tests/main.rs`'s own module tree:
//   - `no_alloc_*.rs`: each installs its own `#[global_allocator]` to count only that file's own
//     allocations; Rust allows exactly one global allocator per binary, so these can never share one.
//   - `runner_control.rs`: the runner's own permanent negative control
//     (`packages/engine/crates/engine/CLAUDE.md`), deliberately left untouched by a change made for
//     build-time reasons alone.
// Anything else new belongs inside `tests/main/` as a `tests/main.rs` `#[path]` module, not as a
// new top-level file -- add it there and this test keeps passing; add it as a bare `tests/foo.rs`
// and this test names the offending file.
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TESTS_DIR = join(__dirname, '../../packages/engine/crates/engine/tests')

const ALLOWED_TOP_LEVEL_RS_FILES = new Set([
  'main.rs',
  'runner_control.rs',
  'no_alloc_authority.rs',
  'no_alloc_codec.rs',
  'no_alloc_connection.rs',
  'no_alloc_drawlist.rs',
  'no_alloc_gen_queue.rs',
  'no_alloc_store.rs',
  'no_alloc_terrain.rs',
  'no_alloc_tick_state.rs',
  'no_alloc_ui.rs',
  'no_alloc_wire.rs',
])

describe('crates/engine/tests/ top-level binary count', () => {
  test('every top-level tests/*.rs file is either main.rs, runner_control.rs or its own #[global_allocator]', () => {
    const topLevelRustFiles = readdirSync(TESTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.rs'))
      .map((entry) => entry.name)

    expect(new Set(topLevelRustFiles)).toEqual(ALLOWED_TOP_LEVEL_RS_FILES)
  })
})
