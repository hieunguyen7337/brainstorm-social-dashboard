import { test, expect, onboard, getToken, auth, openTab } from './fixtures';

test('create two variants, publish one, see it in Queue with growing views', async ({ page, request }) => {
  await onboard(page);
  const token = await getToken(page, request);
  await openTab(page, 'Create');

  // select X and LinkedIn
  for (const name of ['X', 'LinkedIn']) {
    await page.getByRole('button', { name, exact: true }).or(page.getByText(name, { exact: true })).first().click();
  }
  await page.getByRole('button', { name: 'Generate' }).click();

  const publish = page.getByRole('button', { name: 'Publish' });
  await expect(publish).toHaveCount(2, { timeout: 45_000 });
  await publish.first().click();

  // find the published post through the API (newest published, created in last minutes)
  let post: any;
  await expect
    .poll(
      async () => {
        const r = await request.get('/api/posts?status=published&limit=5', { headers: auth(token) });
        const list = await r.json();
        post = list.find((p: any) => p.source === 'ai' || p.source === 'manual');
        return !!post;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  const startViews = post.views;

  await openTab(page, 'Queue');
  await expect(page.getByText(/published/i).first()).toBeVisible();

  await expect
    .poll(
      async () => {
        const r = await request.get('/api/posts?status=published&limit=50', { headers: auth(token) });
        const p = (await r.json()).find((x: any) => x.id === post.id);
        return p?.views ?? 0;
      },
      { timeout: 20_000, intervals: [2000] },
    )
    .toBeGreaterThan(startViews);
});
