import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: Number(process.env.PW_WORKERS ?? 4),
  reporter: [['line']],
  timeout: 30_000,
  use: {
    // 'chromium' channel = full Chromium build in NEW headless mode (the default headless shell has no GPU adapter)
    // CHANNEL=shell -> old headless shell, which with --enable-unsafe-webgpu yields the SwiftShader adapter
    channel: process.env.CHANNEL === 'shell' ? undefined : 'chromium',
    headless: true,
    baseURL: 'http://127.0.0.1:4517',
    launchOptions: {
      args: [
        '--enable-unsafe-webgpu',
        `--js-flags=${process.env.JS_FLAGS ?? '--expose-gc --sampling-heap-profiler-suppress-randomness'}`,
        ...(process.env.EXTRA_ARGS ? process.env.EXTRA_ARGS.split(' ') : []),
      ],
    },
  },
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:4517/index.html', reuseExistingServer: true },
});
