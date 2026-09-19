import { defineConfig } from 'vite'
import { engine } from 'fake-engine/vite'

// Spike toggles (env) so the test matrix can flip what the plugin injects.
const env = process.env
export default defineConfig({
  plugins: [
    engine({
      crate: './sim',
      profile: (env.SPIKE_PROFILE as 'dev' | 'release' | undefined) || undefined,
      exclude: env.SPIKE_EXCLUDE !== '0',
      workerFormat: env.SPIKE_WORKER_FORMAT === 'default' ? null : ((env.SPIKE_WORKER_FORMAT as 'es' | 'iife') || 'es'),
    }),
  ],
})
