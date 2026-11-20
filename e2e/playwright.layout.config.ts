import { chromium, defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Layout check: every tab at a wide desktop viewport and at a phone viewport (tests/layout.spec.ts).
// Separate from playwright.config.ts (the phone functional suite against a live API), which stays untouched.
//
//   BASE_URL unset -> serve a static export (default apps/mobile/dist-mock, built with EXPO_PUBLIC_MOCK=1) on PORT.
//   BASE_URL set   -> no server is started; the check runs against that URL (e.g. the live app with the real API).

const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT ?? 4173);
const BASE_URL_SET = Boolean(process.env.BASE_URL);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

/**
 * Chromium binary. Normally the one `playwright install` fetched for this exact @playwright/test version. In the sandbox
 * only an older preinstalled build exists (/opt/pw-browsers/chromium), so when the matching one is missing fall back to it.
 * Never run `playwright install` here. Override with CHROMIUM_PATH.
 */
function chromiumPath(): string | undefined {
  const override = process.env.CHROMIUM_PATH;
  if (override && fs.existsSync(override)) return override;
  try {
    if (fs.existsSync(chromium.executablePath())) return undefined; // matching build installed: use it
  } catch {
    /* executablePath() throws when no browser path can be resolved */
  }
  const preinstalled = '/opt/pw-browsers/chromium';
  return fs.existsSync(preinstalled) ? preinstalled : undefined;
}

const executablePath = chromiumPath();
const launchOptions = {
  ...(executablePath ? { executablePath } : null),
  // Running as root in a container (the sandbox): Chromium refuses to start without --no-sandbox.
  ...(executablePath || process.getuid?.() === 0 ? { args: ['--no-sandbox'] } : null),
};

export default defineConfig({
  testDir: './tests',
  testMatch: /layout\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 2,
  reporter: [['list']],
  outputDir: 'test-results-layout',
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    launchOptions,
    trace: 'retain-on-failure',
    screenshot: 'off', // layout.spec.ts writes e2e/screenshots/layout-<project>-<tab>.png itself
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    },
    {
      name: 'phone',
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
  ],
  webServer: BASE_URL_SET
    ? undefined
    : {
        command: 'node e2e/scripts/serve-dist.mjs',
        cwd: REPO_ROOT,
        env: { ...(process.env as Record<string, string>), PORT: String(PORT) },
        url: BASE_URL,
        // Never silently test whatever else is listening on the port: a stale server would serve another build.
        reuseExistingServer: false,
        timeout: 20_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
