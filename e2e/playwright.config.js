// Playwright configuration for the end-to-end suite. Playwright is not a
// dependency of the project: install it with `--no-save` (see e2e/README.md).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  outputDir: '../test-results',
  // The specs share one server and create accounts; one at a time keeps a
  // failure readable.
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    colorScheme: 'dark',
    trace: 'retain-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
