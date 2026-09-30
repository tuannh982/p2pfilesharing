import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 45_000 },
  forbidOnly: Boolean(process.env['CI']),
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    // The suite's status assertions are written for the save-dialog path, which
    // the app only selects when the build asks for it. `vite build` reads this
    // env, so the suite's own build has to set it or every "Saved to disk."
    // assertion is red against a build the suite produced itself. This is why
    // the env lives here and not on the command: `E2E_LIVE=1 npm run e2e` is
    // the documented live command and must not need a second variable. A
    // preview server left over on PORT from an earlier build is reused and
    // keeps whatever mode it was built with, so stop it before trusting a run.
    env: { VITE_DOWNLOAD_MODE: 'picker' },
  },
});
