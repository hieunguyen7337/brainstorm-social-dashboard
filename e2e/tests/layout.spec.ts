import { test as base, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { onboard, TABS } from './fixtures';

/**
 * Layout check (run with playwright.layout.config.ts): every tab at a desktop (1440x900) and a phone (390x844)
 * viewport. Writes e2e/screenshots/layout-<project>-<tab>.png and fails on horizontal overflow, console errors,
 * page errors, and (separately, in 'wide arrangement') on the board arrangement of the wide layout.
 */

const SHOTS = path.resolve(__dirname, '..', 'screenshots');
type Tab = (typeof TABS)[number];

// ---------------------------------------------------------------------------------------------------------------------
// Console / page error collection. The ignore list is deliberately tiny and explicit.

interface ConsoleMsg {
  text: string;
  url: string;
}

/** Benign noise only: asset 404s for the PWA shell, and connection-level failures of the (unavailable) real API. */
function isBenign({ text, url }: ConsoleMsg): boolean {
  if (!text.startsWith('Failed to load resource')) return false;
  if (/\/(favicon\.ico|manifest\.json|apple-touch-icon[^/?]*\.png)(\?|$)/.test(url)) return true;
  if (/net::ERR_/.test(text) && /\/api\//.test(url)) return true; // never a real 4xx/5xx from the API
  return false;
}

const test = base.extend<{ problems: string[] }>({
  problems: async ({ page }, use) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const msg = { text: m.text(), url: m.location().url ?? '' };
      if (!isBenign(msg)) problems.push(msg.url && !msg.text.includes(msg.url) ? `${msg.text} [${msg.url}]` : msg.text);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${String(e)}`));
    await use(problems);
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Navigation helpers

/**
 * Tab button: the sidebar/tab-bar testID (`tab-dashboard`, ...) first, role tab / link as the fallback. The accessible
 * name of a tab carries its icon glyph ("\uf2c5 Dashboard"), so the name is matched allowing non-word chars in front.
 */
async function tabButton(page: Page, name: Tab): Promise<Locator> {
  const label = new RegExp(`^[^\\w]*${name}$`);
  const candidates = [
    page.getByTestId(`tab-${name.toLowerCase()}`),
    page.getByRole('tab', { name: label }),
    page.getByRole('link', { name: label }),
  ];
  for (const c of candidates) {
    const visible = c.filter({ visible: true });
    if ((await visible.count()) > 0) return visible.first();
  }
  throw new Error(`No visible tab button for "${name}" (tried testID tab-${name.toLowerCase()}, role tab, role link)`);
}

async function openTab(page: Page, tab: Tab) {
  await (await tabButton(page, tab)).click();
  await page.waitForURL(new RegExp(`/${tab.toLowerCase()}(?:[/?#]|$)`), { timeout: 10_000 });
}

/** Wait for the screen: network idle (best effort, the live app polls), its heading, then let entrance animations end. */
async function settle(page: Page, tab: Tab) {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await page
    .getByRole('heading', { name: tab, exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => undefined); // not every board need keep a heading named exactly like the tab: the checks below decide
  await page.waitForTimeout(1_000);
}

// ---------------------------------------------------------------------------------------------------------------------
// In-page measurements (serialised into the browser: no closures over test code)

interface Offender {
  tag: string;
  testId: string | null;
  text: string;
  left: number;
  right: number;
}

interface OverflowReport {
  innerWidth: number;
  innerHeight: number;
  docScrollWidth: number;
  bodyScrollWidth: number;
  /** The widest vertical scroller whose content is wider than its box (clipped content), if any. */
  scrollerClips: Offender | null;
  offenders: Offender[];
  /** Total scrollable content height (document or inner page scroller), px. */
  contentHeight: number;
}

function measureLayout(): OverflowReport {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const slack = 1;
  const describe = (el: Element): Offender => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute('data-testid'),
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      left: Math.round(r.left),
      right: Math.round(r.right),
    };
  };
  // react-navigation keeps inactive tab scenes mounted under the active one (aria-hidden, z-index -1): not on screen.
  const inactiveRoots = Array.from(document.querySelectorAll('[aria-hidden="true"], [inert]')).filter(
    (n) => n.hasAttribute('inert') || Number(getComputedStyle(n).zIndex) < 0,
  );
  const inInactive = (el: Element) => inactiveRoots.some((n) => n.contains(el));
  // Position fixed/absolute and entirely right of the viewport: off-screen decoration (parked drawers, toasts, glows).
  const parkedOffscreen = (el: Element) => {
    const cs = getComputedStyle(el);
    return (cs.position === 'fixed' || cs.position === 'absolute') && el.getBoundingClientRect().left >= vw - slack;
  };

  const offenders: Offender[] = [];
  let scrollerClips: Offender | null = null;
  let contentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);

  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || inInactive(el)) continue;
    const r = el.getBoundingClientRect();

    // Inner page scroller (react-native-web ScrollView): its content height counts, and wider-than-box content is clipped.
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && r.width >= vw * 0.5 && r.height >= vh * 0.5) {
      contentHeight = Math.max(contentHeight, Math.round(r.top + el.scrollHeight));
      if (el.scrollWidth > el.clientWidth + slack && !scrollerClips) scrollerClips = describe(el);
    }

    if (r.width === 0 && r.height === 0) continue;
    if (r.right <= vw + slack) continue;
    // Exempt: inside an intentionally horizontally scrollable element, or parked off-screen (fixed/absolute).
    let exempt = false;
    for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
      if (parkedOffscreen(a)) {
        exempt = true;
        break;
      }
      if (a !== el) {
        const ox = getComputedStyle(a).overflowX;
        if (ox === 'auto' || ox === 'scroll') {
          exempt = true;
          break;
        }
      }
    }
    if (!exempt) offenders.push(describe(el));
  }

  return {
    innerWidth: vw,
    innerHeight: vh,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    scrollerClips,
    offenders,
    contentHeight,
  };
}

/** A tab bar along the bottom of the viewport: a wide element in the lower 40% that contains >= 3 of the tab labels. */
function findBottomBar(labels: string[]): Offender | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const inactiveRoots = Array.from(document.querySelectorAll('[aria-hidden="true"], [inert]')).filter(
    (n) => n.hasAttribute('inert') || Number(getComputedStyle(n).zIndex) < 0,
  );
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (inactiveRoots.some((n) => n.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.5 || r.height <= 0 || r.top < vh * 0.6 || r.top >= vh) continue;
    const text = (el as HTMLElement).innerText ?? '';
    if (labels.filter((l) => text.includes(l)).length >= 3) {
      return {
        tag: el.tagName.toLowerCase(),
        testId: el.getAttribute('data-testid'),
        text: text.replace(/\s+/g, ' ').trim().slice(0, 60),
        left: Math.round(r.left),
        right: Math.round(r.right),
      };
    }
  }
  return null;
}

const fmt = (o: Offender) =>
  `<${o.tag}${o.testId ? ` data-testid="${o.testId}"` : ''}> "${o.text}" x ${o.left}..${o.right}`;

/** Full-content screenshot. RN-web scrolls inside the page (the document itself does not), so the viewport is grown. */
async function screenshotAll(page: Page, file: string, contentHeight: number) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const vp = page.viewportSize();
  const target = Math.min(Math.ceil(contentHeight) + 4, 6_000);
  if (!vp || target <= vp.height) {
    await page.screenshot({ path: file, fullPage: true });
    return;
  }
  try {
    await page.setViewportSize({ width: vp.width, height: target });
    await page.waitForTimeout(400);
    await page.screenshot({ path: file, fullPage: true });
  } finally {
    await page.setViewportSize(vp);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Every tab fits the viewport and logs no errors (independent of how the wide board is arranged)

test.describe('overflow and console', () => {
  test('every tab: screenshot, no horizontal overflow, no console errors', async ({ page, problems }, info) => {
    const project = info.project.name;
    await onboard(page);
    await settle(page, 'Dashboard');
    expect.soft(problems, `console/page errors during onboarding (${project})`).toEqual([]);

    for (const tab of TABS) {
      await test.step(`${project}: ${tab}`, async () => {
        const before = problems.length;
        await openTab(page, tab);
        await settle(page, tab);

        const m = await page.evaluate(measureLayout);
        const vp = page.viewportSize();
        const where = `${tab} @ ${vp?.width}x${vp?.height} (${project})`;
        await screenshotAll(page, path.join(SHOTS, `layout-${project}-${tab.toLowerCase()}.png`), m.contentHeight);

        expect.soft(m.docScrollWidth, `document scrollWidth exceeds window.innerWidth on ${where}`).toBeLessThanOrEqual(m.innerWidth + 1);
        expect.soft(m.bodyScrollWidth, `body scrollWidth exceeds window.innerWidth on ${where}`).toBeLessThanOrEqual(m.innerWidth + 1);
        expect
          .soft(
            m.offenders.length,
            `${m.offenders.length} element(s) stick out past the right edge (${m.innerWidth}px) on ${where}; first: ${m.offenders[0] ? fmt(m.offenders[0]) : '-'}`,
          )
          .toBe(0);
        expect
          .soft(m.scrollerClips, `the page scroller on ${where} has content wider than its box (clipped): ${m.scrollerClips ? fmt(m.scrollerClips) : ''}`)
          .toBeNull();
        expect.soft(problems.slice(before), `console/page errors while on ${where}`).toEqual([]);
      });
    }

    expect(problems, `console/page errors during the whole run (${project})`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Layout mode and the whiteboard arrangement of the wide layout (tolerant: bounding boxes and loose text matches)

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(loc: Locator, what: string): Promise<Box> {
  const b = await loc.first().boundingBox();
  if (!b) throw new Error(`${what}: no bounding box (not rendered?)`);
  return b;
}

/** Boxes of the rendered matches outside aria-hidden subtrees (react-navigation keeps inactive tab scenes mounted, hidden). */
async function activeBoxes(loc: Locator, limit = 40): Promise<Box[]> {
  const boxes = await loc.evaluateAll((els) =>
    els
      .filter((el) => !el.closest('[aria-hidden="true"], [inert]') && getComputedStyle(el).visibility !== 'hidden')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })
      .filter((b) => b.width > 0 && b.height > 0),
  );
  return boxes.slice(0, limit);
}

/** Topmost, then leftmost, rendered element whose text matches (headers sit above the content that repeats their words). */
async function headerBox(page: Page, text: RegExp | string, what: string): Promise<Box> {
  const boxes = await activeBoxes(page.getByText(text));
  if (boxes.length === 0) throw new Error(`${what}: no visible element matching ${String(text)}`);
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  return boxes[0];
}

/** First pair of boxes on (nearly) the same row but in different columns. */
function sameRowPair(boxes: Box[], tolY: number, minDx: number): [Box, Box] | null {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (Math.abs(boxes[i].y - boxes[j].y) <= tolY && Math.abs(boxes[i].x - boxes[j].x) >= minDx) return [boxes[i], boxes[j]];
    }
  }
  return null;
}

test.describe('wide arrangement', () => {
  test('navigation: sidebar at 1440, bottom bar at 390', async ({ page }, info) => {
    const project = info.project.name;
    await onboard(page);
    await settle(page, 'Dashboard');

    const boxes: Box[] = [];
    for (const tab of TABS) boxes.push(await boxOf(await tabButton(page, tab), `tab button "${tab}"`));
    const list = boxes.map((b, i) => `${TABS[i]}@(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)})`).join(' ');

    if (project === 'desktop') {
      for (let i = 0; i < boxes.length; i++) {
        expect.soft(boxes[i].x, `${TABS[i]} button must be in a left sidebar (x < 300): ${list}`).toBeLessThan(300);
        expect.soft(Math.abs(boxes[i].x - boxes[0].x), `${TABS[i]} button shares the sidebar's x range: ${list}`).toBeLessThanOrEqual(8);
        expect.soft(boxes[i].x < boxes[0].x + boxes[0].width && boxes[0].x < boxes[i].x + boxes[i].width, `${TABS[i]} overlaps the first button's x range: ${list}`).toBe(true);
        if (i > 0) expect.soft(boxes[i].y, `${TABS[i]} must sit below ${TABS[i - 1]} (stacked vertically): ${list}`).toBeGreaterThan(boxes[i - 1].y + 10);
      }
      const bar = await page.evaluate(findBottomBar, [...TABS]);
      expect.soft(bar, `no bottom tab bar at 1440 wide, found ${bar ? fmt(bar) : ''}`).toBeNull();
    } else {
      for (let i = 0; i < boxes.length; i++) {
        expect.soft(boxes[i].y, `${TABS[i]} button must be near the bottom (y > 600): ${list}`).toBeGreaterThan(600);
        expect.soft(Math.abs(boxes[i].y - boxes[0].y), `${TABS[i]} button sits in the same row: ${list}`).toBeLessThanOrEqual(8);
        if (i > 0) expect.soft(boxes[i].x, `${TABS[i]} must be right of ${TABS[i - 1]} (one horizontal row): ${list}`).toBeGreaterThan(boxes[i - 1].x + 20);
      }
    }
  });

  test.describe('desktop boards', () => {
    test.beforeEach(({}, info) => {
      test.skip(info.project.name !== 'desktop', 'wide arrangement is only asserted at 1440 px');
    });

    test('dashboard: whiteboard cards side by side, a few screens tall', async ({ page }) => {
      await onboard(page);
      await settle(page, 'Dashboard');

      const views = await headerBox(page, /views by platform/i, '"Views by platform"');
      const outside = await headerBox(page, /outside trends/i, '"Outside trends"');
      expect
        .soft(outside.x, `"Outside trends" card must be to the right of "Views by platform" (x ${Math.round(outside.x)} vs ${Math.round(views.x)})`)
        .toBeGreaterThan(views.x + 200);

      const generate = page.getByRole('heading', { name: /^generate$/i }).or(page.getByText('Generate', { exact: true }));
      expect.soft((await activeBoxes(generate)).length, '"Generate" heading is visible').toBeGreaterThan(0);
      expect.soft((await activeBoxes(page.getByText('Social media connectors'))).length, '"Social media connectors" heading is visible').toBeGreaterThan(0);
      expect.soft((await activeBoxes(page.getByText('Themes (Jev AI)'))).length, '"Themes (Jev AI)" heading is visible').toBeGreaterThan(0);

      const m = await page.evaluate(measureLayout);
      const screens = m.contentHeight / m.innerHeight;
      expect.soft(screens, `dashboard is ${screens.toFixed(1)} viewport heights tall (${m.contentHeight}px of ${m.innerHeight}px), expected a few at most`).toBeLessThanOrEqual(4);
    });

    test('queue: three status columns side by side', async ({ page }) => {
      await onboard(page);
      await openTab(page, 'Queue');
      await settle(page, 'Queue');

      const drafts = await headerBox(page, /^\s*drafts\b/i, 'Queue column "Drafts"');
      const scheduled = await headerBox(page, /^\s*scheduled\b/i, 'Queue column "Scheduled"');
      const published = await headerBox(page, /^\s*published\b/i, 'Queue column "Published"');
      const at = `Drafts(${Math.round(drafts.x)},${Math.round(drafts.y)}) Scheduled(${Math.round(scheduled.x)},${Math.round(scheduled.y)}) Published(${Math.round(published.x)},${Math.round(published.y)})`;
      expect.soft(Math.abs(drafts.y - scheduled.y), `Drafts and Scheduled headers share a row: ${at}`).toBeLessThanOrEqual(30);
      expect.soft(Math.abs(scheduled.y - published.y), `Scheduled and Published headers share a row: ${at}`).toBeLessThanOrEqual(30);
      expect.soft(scheduled.x, `Scheduled column is right of Drafts: ${at}`).toBeGreaterThan(drafts.x + 150);
      expect.soft(published.x, `Published column is right of Scheduled: ${at}`).toBeGreaterThan(scheduled.x + 150);
      expect.soft(published.x - drafts.x, `three real columns, not a segmented control: ${at}`).toBeGreaterThanOrEqual(500);
    });

    test('trends: at least two trend cards share a row', async ({ page }) => {
      await onboard(page);
      await openTab(page, 'Trends');
      await settle(page, 'Trends');

      // Card header buttons carry "<rank>. <title>. <n>% match..." as their label (identical tops within a row).
      let boxes = await activeBoxes(page.getByRole('button', { name: /^\d+\. .*\d+% match/ }), 30);
      let tol = 24;
      if (boxes.length < 2) {
        // Labels changed: fall back to the visible "NN% match" texts (their y varies with the title's line count).
        boxes = await activeBoxes(page.getByText(/\d+%\s*match/), 30);
        tol = 80;
      }
      expect(boxes.length, 'trend cards found on the Trends tab').toBeGreaterThanOrEqual(2);
      const pair = sameRowPair(boxes, tol, 150);
      const at = boxes.slice(0, 8).map((b) => `(${Math.round(b.x)},${Math.round(b.y)})`).join(' ');
      expect(pair, `at least two trend cards share a row (equal-ish y, different x): ${at}`).not.toBeNull();
    });
  });
});
