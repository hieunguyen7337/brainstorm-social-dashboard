import { test, expect, onboard, getToken, auth, openTab } from './fixtures';

test('trends list loads with at least 5 items', async ({ page, request }) => {
  await onboard(page);
  const token = await getToken(page, request);
  await openTab(page, 'Trends');
  await expect(page.getByText(/hacker ?news|reddit|google/i).first()).toBeVisible({ timeout: 30_000 });
  const r = await request.get('/api/trends?limit=20', { headers: auth(token), timeout: 45_000 });
  expect(r.ok()).toBeTruthy();
  expect((await r.json()).length).toBeGreaterThanOrEqual(5);
});
