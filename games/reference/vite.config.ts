// docs/decisions/0017-packaging-and-build.md §6: what a game writes, verbatim (one plugin line).

import { engine } from 'engine/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [engine({ crate: './sim' })] })
