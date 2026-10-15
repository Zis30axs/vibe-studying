import { defineConfig } from '@playwright/test'
// Keep developer machines silent. Hosted Windows has its own virtual desktop:
// use normal native activation there for real mouse selection/drag regressions.
process.env.EXAMCRAFT_E2E_SILENT =
  process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows' ? '0' : '1'
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/desktop',
  workers: 1,
  timeout: 45000,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
})
