import { test, expect, onboard, getToken, auth, openTab } from './fixtures';

test('real click and conversion on a tracked link show up on the dashboard', async ({ page, request, context }) => {
  await onboard(page);
  const token = await getToken(page, request);

  const posts = await (await request.get('/api/posts?status=published&limit=20', { headers: auth(token) })).json();
  const post = posts.find((p: any) => p.link_code);
  expect(post, 'a published post with a link_code').toBeTruthy();

  const before = await (await request.get('/api/dashboard?days=30', { headers: auth(token) })).json();

  const lp = await context.newPage();
  await lp.goto(`/r/${post.link_code}`);
  await expect(lp).toHaveURL(new RegExp(`/l/${post.link_code}`));
  await lp.getByRole('button', { name: /get started/i }).or(lp.getByRole('link', { name: /get started/i })).first().click();
  await lp.waitForTimeout(1000);
  await lp.close();

  await expect
    .poll(
      async () => {
        const d = await (await request.get('/api/dashboard?days=30', { headers: auth(token) })).json();
        return [d.real_clicks - before.real_clicks, d.real_conversions - before.real_conversions];
      },
      { timeout: 15_000 },
    )
    .toEqual([1, 1]);

  await page.reload();
  await expect(page.getByText('Views by platform')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/real/i).first()).toBeVisible();
});
