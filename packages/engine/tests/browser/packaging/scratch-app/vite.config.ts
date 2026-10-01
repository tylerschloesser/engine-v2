// What a game writes (0017 §6): one plugin line. The port comes from the environment so the test can
// run dev and preview side by side.
import { engine } from 'engine/vite'
import { defineConfig } from 'vite'

const port = Number(process.env.SCRATCH_PORT ?? 5173)

export default defineConfig({
  plugins: [engine({ crate: './sim' })],
  server: { port, strictPort: true, host: '127.0.0.1' },
  preview: { port, strictPort: true, host: '127.0.0.1' },
})
