import { test, expect, onboard, openTab, TABS } from './fixtures';

test('no console errors on load of each tab', async ({ page, errors }) => {
  await onboard(page);
  for (const tab of TABS) {
    await openTab(page, tab);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
  }
  await expect(page.getByText('Connect Claude (MCP)')).toBeVisible();
  expect(errors).toEqual([]);
});
