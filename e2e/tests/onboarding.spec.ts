import { test, expect, onboard, getToken, auth } from './fixtures';

test('onboarding creates a workspace and shows dashboard with KPIs and funnel', async ({ page, request }) => {
  await onboard(page, { real: true });
  await expect(page.getByText('Sales funnel')).toBeVisible();
  const token = await getToken(page, request);
  const r = await request.get('/api/dashboard?days=30', { headers: auth(token) });
  expect(r.ok()).toBeTruthy();
  const d = await r.json();
  expect(d.totals.views).toBeGreaterThan(0);
  expect(d.totals.engagements).toBeGreaterThan(0);
  expect(d.funnel).toHaveLength(4);
  // UI shows a non-zero number somewhere in the KPI area
  await expect(page.getByText(/[1-9][\d,.]*\s*[kKmM]?/).first()).toBeVisible();
});
