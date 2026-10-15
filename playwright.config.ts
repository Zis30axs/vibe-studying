import { defineConfig } from '@playwright/test'
// Inherited by each Electron launch, including fixtures that copy process.env.
// Native windows and unexpected OS dialogs remain hidden on developer machines.
process.env.EXAMCRAFT_E2E_SILENT = '1'
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/desktop',
  workers: 1,
  timeout: 45000,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
})
