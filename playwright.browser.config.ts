import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'

// Renderer-only regression tests. IPC and OS credential storage are stubbed;
// real Electron coverage remains in playwright.config.ts.
export default defineConfig({
  testDir: 'tests/browser',
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    headless: true,
    viewport: { width: 1440, height: 1050 },
    launchOptions: {
      executablePath:
        process.env.EXAMCRAFT_CHROMIUM_PATH ||
        (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--no-sandbox'],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:web -- --port 5174',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
  },
})
