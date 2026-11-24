import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8000';
// QA sandbox only: WebKit is not installed there, so QA_IPHONE_CHROMIUM=1 keeps the iPhone 15
// viewport, user agent and touch settings but runs them on Chromium. Unset = WebKit, as before.
const IPHONE_ON_CHROMIUM = process.env.QA_IPHONE_CHROMIUM === '1';
// QA sandbox only: Playwright's API client does not use HTTPS_PROXY, so the sandbox cannot resolve the live host.
// QA_USE_PROXY=1 hands the sandbox's own proxy to Playwright (browser and API client). Unset = direct, as before.
const SANDBOX_PROXY = process.env.QA_USE_PROXY === '1' ? process.env.HTTPS_PROXY : undefined;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 1,
  workers: 2,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'off', // taken manually in the afterEach hook (tests/fixtures.ts)
    ...(SANDBOX_PROXY ? { proxy: { server: SANDBOX_PROXY } } : {}),
  },
  projects: [
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 15'],
        ...(IPHONE_ON_CHROMIUM ? { browserName: 'chromium', defaultBrowserType: 'chromium' } : {}),
      },
    },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
});
