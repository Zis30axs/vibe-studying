import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // Windows hosted runners serialize the real PDF-worker and fsync-heavy suites
    // to avoid disk contention; preserve every test and its existing timeout.
    maxWorkers: process.platform === 'win32' && process.env.CI ? 1 : undefined,
  },
})
