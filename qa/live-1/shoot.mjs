// qa/live-1/shoot.mjs
// Standalone Playwright capture of the live Pulse site (QA run 1).
//
//   node qa/live-1/shoot.mjs --preflight   no workspace, no Start or Generate click. Checks the browser, the
//                                          onboarding page and /download/android. Output goes to the scratchpad.
//   node qa/live-1/shoot.mjs               full run: one guest workspace, one Generate press, one publish.
//
// Budget guards are enforced in code:
//   - "Start my demo" is clicked at most once. progress.json records the attempt before the click.
//   - "Generate" is clicked at most once. progress.json records the press before the click.
//   - A re-run reuses the saved workspace token instead of onboarding again.
// The token is written only to the scratchpad token file (mode 600). It is never printed, never put in
// console.json, and any on-screen copy is masked before a screenshot.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = (() => {
  try {
    return require('/home/user/brainstorm-social-dashboard/e2e/node_modules/playwright');
  } catch {
    return require('playwright');
  }
})();

const BASE = 'https://pulse-hackathon.fly.dev';
const REPO_OUT = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = '/tmp/claude-0/-home-user-brainstorm-social-dashboard/1f9221f5-d53c-54eb-8e63-2c05c3622df6/scratchpad/qa-live-1';
const TOKEN_FILE = path.join(SCRATCH, 'workspace-token.txt');
const STATE_FILE = path.join(SCRATCH, 'progress.json');
const PREFLIGHT = process.argv.includes('--preflight');
const OUT = PREFLIGHT ? path.join(SCRATCH, 'preflight') : REPO_OUT;
const BROWSERS = [
  '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
];
const PLATFORM_LABELS = ['LinkedIn', 'Instagram', 'X', 'TikTok', 'Reddit', 'Facebook'];
const WANT = ['LinkedIn', 'Instagram'];

let TOKEN = null;
let current = null;
let selectionOk = false;
const consoleByScreen = {};
const summary = {
  mode: PREFLIGHT ? 'preflight' : 'full',
  workspacesCreated: 0,
  generatePresses: 0,
  publishClicks: 0,
  screens: {},
  notes: [],
};

// ---- redaction and logging --------------------------------------------------------------------------------------

const redact = (text) => {
  let s = String(text);
  if (TOKEN) s = s.split(TOKEN).join('[REDACTED]');
  return s.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/([?&]token=)[^&\s"']+/gi, '$1[REDACTED]');
};

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
};

const note = (msg) => {
  const line = redact(msg);
  summary.notes.push(line);
  console.log(line);
};

// ---- console and response capture (attributed to the current screen) ---------------------------------------------

function startScreen(name) {
  current = name;
  consoleByScreen[name] ??= [];
}

function record(text) {
  if (current) consoleByScreen[current].push(redact(text));
}

function attach(page) {
  page.on('console', (m) => {
    if (m.type() === 'error') record(m.text());
  });
  page.on('pageerror', (e) => record(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400) record(`HTTP ${r.status()} ${r.url()}`);
  });
}

function writeConsole() {
  fs.mkdirSync(OUT, { recursive: true });
  const clean = Object.fromEntries(Object.entries(consoleByScreen).map(([k, v]) => [k, v.map(redact)]));
  fs.writeFileSync(path.join(OUT, 'console.json'), `${JSON.stringify(clean, null, 2)}\n`);
}

// ---- state and token files (scratchpad only) ---------------------------------------------------------------------

function loadState() {
  if (PREFLIGHT) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  if (PREFLIGHT) return;
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function readSavedToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function saveToken(token) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
}

// ---- browser ----------------------------------------------------------------------------------------------------

async function launch() {
  const errors = [];
  for (const exe of BROWSERS) {
    if (!fs.existsSync(exe)) {
      errors.push(`missing ${exe}`);
      continue;
    }
    try {
      return await chromium.launch({ headless: true, executablePath: exe });
    } catch (e) {
      errors.push(`${path.basename(exe)}: ${String(e.message).split('\n')[0]}`);
    }
  }
  throw new Error(`no chromium could launch (${errors.join('; ')})`);
}

const phoneDevice = () => {
  const d = { ...devices['iPhone 15'], viewport: { width: 393, height: 852 } };
  delete d.defaultBrowserType;
  return d;
};

// ---- masking and mock checks -------------------------------------------------------------------------------------

/** Cover any on-screen copy of the token, a Bearer value or a token query string with a black box. */
async function maskSecrets(page) {
  return page.evaluate((tok) => {
    document.querySelectorAll('[data-qa-mask]').forEach((n) => n.remove());
    const needles = ['Bearer ', '?token=', 'Authorization:'];
    if (tok) needles.unshift(tok);
    const hit = (s) => typeof s === 'string' && needles.some((n) => s.includes(n));
    const selfHit = (el) => {
      if (hit(el.textContent)) return true;
      if (typeof el.value === 'string' && hit(el.value)) return true;
      return Array.from(el.attributes).some((a) => hit(a.value));
    };
    const minimal = Array.from(document.body.querySelectorAll('*')).filter(
      (el) => selfHit(el) && !Array.from(el.children).some(selfHit),
    );
    let masked = 0;
    let skipped = 0;
    for (const el of minimal) {
      let target = el;
      for (let i = 0; i < 3; i += 1) {
        const p = target.parentElement;
        if (!p || p === document.body || (p.textContent || '').length > 300) break;
        target = p;
      }
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height > 500) {
        skipped += 1;
        continue;
      }
      const box = document.createElement('div');
      box.setAttribute('data-qa-mask', '1');
      box.style.cssText = `position:absolute;left:${r.left + window.scrollX - 4}px;top:${r.top + window.scrollY - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;background:#000;z-index:2147483647;pointer-events:none;border-radius:8px;`;
      document.body.appendChild(box);
      masked += 1;
    }
    return { masked, skipped, candidates: minimal.length };
  }, TOKEN || '');
}

async function mockState(page) {
  return page.evaluate(() => {
    let flag = null;
    try {
      flag = window.localStorage.getItem('pulse.mock');
    } catch {
      flag = 'storage-blocked';
    }
    const text = document.body ? document.body.innerText : '';
    const tags = ['Offline demo (mock data)', 'Offline demo', 'mock data', 'Template mode'].filter((s) => text.includes(s));
    return { pulseMockKey: flag === null ? 'unset' : flag === '1' ? 'set-1' : 'set-other', textTags: tags };
  });
}

async function shot(page, name) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
  const mock = await mockState(page).catch(() => null);
  const mask = await maskSecrets(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  await page.evaluate(() => document.querySelectorAll('[data-qa-mask]').forEach((n) => n.remove())).catch(() => {});
  summary.screens[name] = { path: pathOf(page.url()), mock, mask };
  console.log(`captured ${name}.png (masked regions: ${mask.masked}, skipped: ${mask.skipped})`);
  writeConsole();
}

// ---- UI helpers --------------------------------------------------------------------------------------------------

async function openTab(page, name) {
  for (const role of ['tab', 'link']) {
    const loc = page.getByRole(role, { name, exact: true });
    if ((await loc.count()) > 0) return loc.first().click();
  }
  return page.getByText(name, { exact: true }).first().click();
}

/** Set the Create-tab chips so that exactly `want` are selected. Returns false if the state cannot be read. */
async function setPlatforms(page, want) {
  for (const label of PLATFORM_LABELS) {
    const chip = page.getByRole('button', { name: label, exact: true });
    if ((await chip.count()) !== 1) continue;
    const before = await chip.getAttribute('aria-selected');
    if (before !== 'true' && before !== 'false') return false;
    if ((before === 'true') !== want.includes(label)) {
      await chip.click();
      await page.waitForTimeout(400);
    }
  }
  return true;
}

async function readPlatforms(page) {
  const out = {};
  for (const label of PLATFORM_LABELS) {
    const chip = page.getByRole('button', { name: label, exact: true });
    const n = await chip.count();
    if (n !== 1) {
      out[label] = `count=${n}`;
      continue;
    }
    const v = await chip.getAttribute('aria-selected');
    out[label] = v === 'true' ? true : v === 'false' ? false : 'unknown';
  }
  return out;
}

const selectionMatches = (sel, want) => PLATFORM_LABELS.every((l) => sel[l] === want.includes(l));

async function apiGet(page, apiPath) {
  const res = await page.request.get(`${BASE}${apiPath}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: res.status(), body: res.ok() ? await res.json().catch(() => null) : null };
}

async function step(name, fn) {
  startScreen(name);
  try {
    await fn();
  } catch (e) {
    note(`${name} failed: ${String(e && e.message ? e.message : e).split('\n')[0]}`);
  }
  writeConsole();
}

// ---- screens -----------------------------------------------------------------------------------------------------

async function downloadStep(page) {
  const url = `${BASE}/download/android`;
  const raw = await page.request.get(url, { maxRedirects: 0 }).catch(() => null);
  summary.downloadRawStatus = raw ? raw.status() : 'request failed';
  const location = raw ? raw.headers().location : undefined;
  if (location) summary.downloadRedirectHost = new URL(location, url).host;
  if (raw && raw.status() >= 300 && raw.status() < 400) {
    // The redirect target is an APK, so a browser visit would start a file download rather than render a page.
    note(`/download/android answers ${raw.status()} (redirect); not followed in the browser, so no page screenshot`);
    return;
  }
  const res = await page
    .goto(url, { waitUntil: 'load' })
    .catch((e) => {
      note(`download navigation: ${String(e.message).split('\n')[0]}`);
      return null;
    });
  summary.downloadPageStatus = res ? res.status() : null;
  await page.waitForTimeout(1000);
  await shot(page, '10-download-android');
}

async function phoneFlow(browser, state) {
  const ctx = await browser.newContext(phoneDevice());
  try {
    const page = await ctx.newPage();
    attach(page);

    // 01: onboarding, no clicks
    startScreen('01-onboarding');
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    const start = page.getByRole('button', { name: /start my demo/i });
    await start.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    summary.startButtonCount = await start.count();
    await shot(page, '01-onboarding');

    if (PREFLIGHT) {
      await step('10-download-android', () => downloadStep(page));
      return;
    }
    if (summary.startButtonCount !== 1) {
      throw new Error(
        `live / shows ${summary.startButtonCount} "Start my demo" buttons (it serves a static landing page); stopped before any workspace action`,
      );
    }

    // Onboarding: one workspace per run. A saved token is reused, never re-onboarded.
    const saved = readSavedToken();
    if (saved) {
      TOKEN = saved;
      const ws = await apiGet(page, '/api/workspace');
      if (ws.status !== 200) throw new Error(`saved workspace token rejected (HTTP ${ws.status}); not onboarding again`);
      note('reusing the saved workspace from the token file (no Start click this run)');
      startScreen('02-dashboard');
      await page.evaluate((t) => window.localStorage.setItem('pulse.token', t), TOKEN);
      await page.goto(`${BASE}/`, { waitUntil: 'load' });
    } else {
      if (state.onboardingAttempted) {
        throw new Error('an earlier onboarding attempt left no saved token; not retrying (stopped)');
      }
      if ((await start.count()) !== 1) throw new Error('Start my demo button is not unique; not clicked (stopped)');
      state.onboardingAttempted = true;
      saveState(state);
      startScreen('02-dashboard');
      await start.click();
      summary.workspacesCreated += 1;
      await page
        .getByText('Views by platform')
        .first()
        .waitFor({ state: 'visible', timeout: 60000 })
        .catch(() => {
          throw new Error('onboarding did not reach the dashboard within 60s (stopped, not retrying)');
        });
      TOKEN = await page.evaluate(() => window.localStorage.getItem('pulse.token'));
      if (!TOKEN) throw new Error('no pulse.token after onboarding (stopped)');
      const ws = await apiGet(page, '/api/workspace');
      if (ws.status !== 200) throw new Error(`new workspace failed verification (HTTP ${ws.status}) (stopped)`);
      saveToken(TOKEN);
      state.workspaceCreated = true;
      saveState(state);
    }

    // 02: dashboard after live numbers have had 6 seconds to move
    startScreen('02-dashboard');
    await page.getByText('Views by platform').first().waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForTimeout(6000);
    await shot(page, '02-dashboard');

    // 03: Create tab, LinkedIn + Instagram selected, no Generate yet
    await step('03-create-before', async () => {
      await openTab(page, 'Create');
      await page.getByRole('button', { name: 'LinkedIn', exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForTimeout(2000);
      const readable = await setPlatforms(page, WANT);
      await page.waitForTimeout(1500);
      summary.selection = await readPlatforms(page);
      selectionOk = readable && selectionMatches(summary.selection, WANT);
      if (!selectionOk) note('platform selection not verified as LinkedIn + Instagram; Generate will NOT be pressed');
      await shot(page, '03-create-before');
    });

    // 04: the ONE Generate press, then the ONE publish
    await step('04-create-after', async () => {
      const gen = page.getByRole('button', { name: /Generate \d+ posts/ });
      const publish = page.getByRole('button', { name: /Publish$/ });
      if (state.generatePressed) {
        note('Generate was already pressed by an earlier attempt; not pressing it again');
        await shot(page, '04-create-after');
        return;
      }
      const genCount = await gen.count();
      const genLabel = genCount === 1 ? (await gen.first().textContent()) || '' : '';
      if (!selectionOk || genCount !== 1 || !/2 posts/.test(genLabel)) {
        note(`Generate NOT pressed (selection ok: ${selectionOk}, Generate buttons: ${genCount})`);
        await shot(page, '04-create-after');
        return;
      }
      state.generatePressed = true;
      saveState(state);
      summary.generatePresses += 1;
      await gen.first().click();
      const appeared = await publish
        .first()
        .waitFor({ state: 'visible', timeout: 60000 })
        .then(() => true, () => false);
      if (!appeared) {
        note('Publish buttons did not appear within 60s after the single Generate press');
        await shot(page, '04-create-after');
        return;
      }
      await shot(page, '04-create-after');
      if (state.published) return;

      state.publishClicked = true;
      saveState(state);
      summary.publishClicks += 1;
      await publish.first().click();
      const toastSeen = await page
        .getByText(/Published to .*sandbox/)
        .first()
        .waitFor({ state: 'visible', timeout: 20000 })
        .then(() => true, () => false);
      const posts = await apiGet(page, '/api/posts?status=published&limit=20');
      const hit = Array.isArray(posts.body) ? posts.body.find((p) => p.link_code) : undefined;
      summary.publish = { toastSeen, apiHasPublishedPostWithLink: Boolean(hit) };
      if (hit) {
        state.published = true;
        state.linkCode = hit.link_code;
        saveState(state);
      } else {
        note('publish not confirmed by the toast or by the API');
      }
    });

    // 05: Queue
    await step('05-queue', async () => {
      await openTab(page, 'Queue');
      await page.getByText('Queue', { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await shot(page, '05-queue');
    });

    // 06: Trends, wait for the trends list request
    await step('06-trends', async () => {
      const trendsCall = page
        .waitForResponse((r) => r.url().includes('/api/trends') && r.request().method() === 'GET', { timeout: 30000 })
        .catch(() => null);
      await openTab(page, 'Trends');
      const r = await trendsCall;
      note(`trends API response: ${r ? r.status() : 'none seen'}`);
      await page.waitForTimeout(2000);
      await shot(page, '06-trends');
    });

    // 07: Settings, Connectors card in view
    await step('07-settings-connectors', async () => {
      await openTab(page, 'Settings');
      const conn = page.getByText('Connectors', { exact: true }).first();
      await conn.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await conn.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(800);
      await shot(page, '07-settings-connectors');
    });

    // 08: Settings, Connect Claude (MCP) card in view
    await step('08-settings-connect-claude-mcp', async () => {
      const card = page.getByText('Connect Claude (MCP)').first();
      await card.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(800);
      await shot(page, '08-settings-connect-claude-mcp');
    });

    // 09: the tracked-link landing page (not clicked, so no click is recorded)
    await step('09-tracked-link', async () => {
      let code = state.linkCode || null;
      if (!code) {
        const posts = await apiGet(page, '/api/posts?status=published&limit=20');
        const hit = Array.isArray(posts.body) ? posts.body.find((p) => p.link_code) : undefined;
        code = hit ? hit.link_code : null;
      }
      if (!code) {
        note('no published post with a link_code; tracked-link screen not captured');
        return;
      }
      summary.linkCode = code;
      const res = await page.goto(`${BASE}/l/${encodeURIComponent(code)}`, { waitUntil: 'load' });
      summary.landingHttpStatus = res ? res.status() : null;
      await page.waitForTimeout(1500);
      await shot(page, '09-tracked-link');
    });

    // 10: Android download
    await step('10-download-android', () => downloadStep(page));
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function desktopFlow(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: 'pulse.token', value: TOKEN }] }] },
  });
  try {
    const page = await ctx.newPage();
    attach(page);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.getByText('Views by platform').first().waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForTimeout(6000);
    await shot(page, '11-dashboard-desktop-1280x800');
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ---- main --------------------------------------------------------------------------------------------------------

(async () => {
  let browser = null;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    browser = await launch();
    const state = loadState();
    await phoneFlow(browser, state);
    if (!PREFLIGHT && TOKEN) await step('11-dashboard-desktop-1280x800', () => desktopFlow(browser));
  } catch (e) {
    summary.error = redact(String(e && e.message ? e.message : e)).split('\n')[0];
    process.exitCode = 1;
    console.log(`STOPPED: ${summary.error}`);
  } finally {
    writeConsole();
    console.log(redact(JSON.stringify(summary, null, 2)));
    if (browser) await browser.close().catch(() => {});
  }
})();
