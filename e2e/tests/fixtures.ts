import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export { expect };

const SHOTS = path.resolve(__dirname, '..', 'screenshots');

/** Collects console errors / page errors; tests assert on `errors`. */
export const test = base.extend<{ errors: string[] }>({
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    await use(errors);
  },
});

test.afterEach(async ({ page }, info) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const name = `${info.project.name}-${info.title.replace(/[^a-z0-9]+/gi, '_')}-r${info.retry}.png`;
  try {
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
  } catch {
    /* page may be closed */
  }
});

/**
 * Onboard through the UI with the demo workspace (docs/REAL.md, "Demo workspaces"): Try the demo, sign in to Instagram
 * with the synthetic demo account, then go to the dashboard. Lands on the dashboard with Instagram's numbers.
 */
export async function onboard(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^try the demo$/i }).click();
  await page.getByRole('button', { name: /^connect with instagram$/i }).click();
  await page.getByRole('button', { name: /^sign in$/i }).click();
  // The sheet reads for about three seconds, then hands back; the onboarding footer then offers the dashboard.
  await page.getByRole('button', { name: /^go to my dashboard$/i }).click({ timeout: 30_000 });
  await expect(page.getByText('Views by platform')).toBeVisible({ timeout: 30_000 });
}

/** Bearer token stored by the app: look for a localStorage value that the API accepts. */
export async function getToken(page: Page, request: APIRequestContext): Promise<string> {
  const entries: [string, string][] = await page.evaluate(() =>
    Object.keys(localStorage).map((k) => [k, localStorage.getItem(k) ?? ''] as [string, string]),
  );
  const candidates: string[] = [];
  for (const [, v] of entries) {
    candidates.push(v);
    try {
      const j = JSON.parse(v);
      if (typeof j === 'string') candidates.push(j);
      else if (j && typeof j === 'object') {
        for (const val of Object.values(j)) if (typeof val === 'string') candidates.push(val);
      }
    } catch {
      /* not JSON */
    }
  }
  for (const c of candidates) {
    if (!c || c.length > 200) continue;
    const r = await request.get('/api/workspace', { headers: { Authorization: `Bearer ${c}` } });
    if (r.ok()) return c;
  }
  throw new Error('No valid workspace token found in localStorage');
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export const TABS = ['Dashboard', 'Trends', 'Create', 'Queue', 'Settings'] as const;

export async function openTab(page: Page, name: (typeof TABS)[number]) {
  await page.getByRole('tab', { name }).or(page.getByRole('link', { name })).or(page.getByText(name, { exact: true })).first().click();
}
