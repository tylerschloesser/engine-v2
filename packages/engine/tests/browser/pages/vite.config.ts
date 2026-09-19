// The page host for every browser test from M03 on. `engine({ crate: '../../../fixtures/hash' })`
// on the dev profile; adding a page is adding `<name>.html` here plus `src/<name>.ts` (globbed into
// `build.rollupOptions.input`). Port from `ENGINE_TEST_PORT` (default 4517, strictPort), so two
// worktrees can run the browser suite at once.
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { engine } from '../../../src/vite.ts'
import { fixturesPlugin } from './fixtures-plugin.ts'

const root = import.meta.dirname
const port = Number(process.env.ENGINE_TEST_PORT ?? 4517)

const input = Object.fromEntries(
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => [entry.name.replace(/\.html$/, ''), resolve(root, entry.name)]),
)

export default defineConfig({
  root,
  plugins: [engine({ crate: '../../../fixtures/hash', profile: 'dev' }), fixturesPlugin()],
  build: {
    target: 'es2022',
    // M04 attributes allocations by function name; minified names would hide them.
    minify: false,
    rollupOptions: { input },
  },
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
})
