/**
 * The state machine behind `AutoReadSheet`. Plain TypeScript with every side effect injected (load a URL, inject a script,
 * capture the WebView, call the screenshot endpoint, timers), so the whole flow runs under plain Node in tests.
 *
 *   anon      free first try (plain fetch with the caller's public handle), when the platform and handle allow it
 *   login     the WebView shows the platform's login page; we wait for a page that is past it
 *   reading   a reader script is injected into the stats page and posts back numbers (or says the person is signed out)
 *   fallback  the reader found nothing: show the page that carries the numbers, capture it, Claude reads the image
 *
 * Contract with the caller: exactly one of `emitResult(read)` or `emitClose(reason?)` is called, once. Nothing is called
 * after `dispose()`. Page contents are never logged and never leave this object except as parsed numbers.
 */
import { ANON_PLATFORMS, cleanHandle, readAnonymously } from './anon';
import {
  FALLBACK_LOAD_MS,
  INJECT_DELAY_MS,
  MAX_INJECTIONS,
  MAX_NAVIGATIONS,
  NAV_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  SETTLE_MS,
  STALE_PAGE_MS,
} from './config';
import { hasNumbers, toScreenshotRead } from './parse';
import { flowFor, parsePageUrl, type Flow, type PageUrl, type StepOutcome } from './platforms';
import {
  AUTO_READ_FAILED,
  type DeviceRead,
  type PageMessage,
  type ParsedRead,
  type Platform,
  type ScreenshotRead,
  type StepCtx,
} from './types';

/** What the sheet shows under the WebView. */
export type RunnerStatus = 'anon' | 'login' | 'reading' | 'capturing' | 'claude';

export interface RunnerDeps {
  platform: Platform;
  /** The person's public handle, if the caller knows it (enables the anonymous first try). */
  handle?: string | null;
  /** Point the WebView at a URL (the first call mounts it). */
  loadUrl(url: string): void;
  /** `injectJavaScript` on the WebView. */
  inject(script: string): void;
  /** JPEG base64 (no `data:` prefix) of the WebView; rejects when it cannot be captured. */
  capture(): Promise<string>;
  readScreenshot(base64: string, mediaType: 'image/jpeg'): Promise<ScreenshotRead>;
  emitResult(read: DeviceRead): void;
  emitClose(reason?: string): void;
  onStatus(status: RunnerStatus): void;
  /** Best effort: drop the WebView's sign-in (cookies) before the sheet reports back. */
  clearSession?(): Promise<void>;
  // test seams
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

type Phase = 'anon' | 'login' | 'reading' | 'fallback' | 'capturing' | 'claude' | 'done';

const STATUS: Record<Exclude<Phase, 'done'>, RunnerStatus> = {
  anon: 'anon',
  login: 'login',
  reading: 'reading',
  fallback: 'reading',
  capturing: 'capturing',
  claude: 'claude',
};

const samePath = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/\/+$/, '') === b.toLowerCase().replace(/\/+$/, '');

function parseMessage(raw: unknown): PageMessage | null {
  if (typeof raw !== 'string' || raw.length > 400_000) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.pulse !== 'autoRead' || typeof o.platform !== 'string' || typeof o.step !== 'number') return null;
  if (o.status !== 'ok' && o.status !== 'signed_out' && o.status !== 'empty' && o.status !== 'error') return null;
  return o as unknown as PageMessage;
}

export class AutoReadRunner {
  private readonly flow: Flow;
  private phase: Phase = 'login';
  private step = 0;
  private ctx: StepCtx = {};
  private currentUrl: PageUrl | null = null;
  private currentRaw: string | null = null;
  /** The page we just navigated away from: its late events must not trigger a read or a capture. */
  private stale: { url: string; until: number } | null = null;
  private timer: unknown = null;
  private injectTimer: unknown = null;
  private navigations = 0;
  private injections = 0;
  private fallbackTarget: PageUrl | null = null;
  private lastInject: { url: string; at: number; ran: boolean } | null = null;
  private disposed = false;

  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.flow = flowFor(deps.platform);
  }

  // ---- inputs ------------------------------------------------------------------------------------------------------

  /** Starts the run: the anonymous try when it applies, otherwise the login page. */
  start(): void {
    const handle = cleanHandle(this.deps.handle);
    if (handle && ANON_PLATFORMS.includes(this.deps.platform)) {
      this.setPhase('anon');
      void this.runAnon(handle);
    } else {
      this.toLogin(true);
    }
  }

  /** WebView `onNavigationStateChange`: also fires for single-page-app route changes (no `onLoadEnd` then). */
  navigated(url: string, loading: boolean): void {
    this.guard(() => {
      const u = parsePageUrl(url);
      if (!u) return;
      this.currentUrl = u;
      this.currentRaw = url;
      if (!loading) this.onPage(u, url, false);
    });
  }

  /** WebView `onLoadEnd`. */
  loadEnded(url: string): void {
    this.guard(() => {
      const u = parsePageUrl(url);
      if (!u) return;
      this.currentUrl = u;
      this.currentRaw = url;
      this.onPage(u, url, true);
    });
  }

  /** WebView `onMessage` (the raw `nativeEvent.data` string). Anything that is not ours is ignored. */
  message(raw: unknown): void {
    this.guard(() => {
      if (this.phase !== 'reading') return;
      const msg = parseMessage(raw);
      if (!msg || msg.platform !== this.deps.platform || msg.step !== this.step) return;
      // A failed read says which step failed (status codes, no cookie values): visible in `adb logcat -s ReactNativeJS`.
      if (msg.status !== 'ok') console.log(`[autoRead] ${String(raw).slice(0, 500)}`);
      if (msg.status === 'ok') this.onStepData(msg.data);
      else if (msg.status === 'signed_out') this.toLogin(false);
      else void this.stepEmpty(msg.data);
    });
  }

  /** WebView `onError` for a main-frame load. `url` is the failing URL. */
  loadFailed(url: string | null | undefined): void {
    this.guard(() => {
      if (this.isOver() || this.phase === 'anon') return;
      const u = parsePageUrl(url);
      if (this.phase === 'login') {
        // only the login page itself failing (offline) ends the run; a stray failure inside a login flow is the person's business
        const login = parsePageUrl(this.flow.loginUrl);
        if (!u || !login || u.host !== login.host || !samePath(u.path, login.path)) return;
      } else if (u && !this.flow.hostOk(u)) {
        return;
      }
      void this.fail();
    });
  }

  /** The person pressed Close. */
  cancel(): void {
    void this.end(() => this.deps.emitClose());
  }

  /** The sheet is going away: stop everything and call nothing back. */
  dispose(): void {
    this.disposed = true;
    this.phase = 'done';
    this.clearTimers();
  }

  // ---- anonymous try -----------------------------------------------------------------------------------------------

  private async runAnon(handle: string): Promise<void> {
    let parsed: ParsedRead | null = null;
    try {
      parsed = await readAnonymously(this.deps.platform, handle, { fetchImpl: this.deps.fetchImpl });
    } catch {
      parsed = null;
    }
    if (this.phase !== 'anon') return;
    if (parsed) await this.finishParsed(parsed, 'high');
    else this.toLogin(true);
  }

  // ---- page events -------------------------------------------------------------------------------------------------

  /** `isLoad`: a document finished loading (`onLoadEnd`); false for a single-page-app route change. */
  private onPage(u: PageUrl, raw: string, isLoad: boolean): void {
    if (this.isOver()) return;
    if (this.stale) {
      const { url, until } = this.stale;
      if (raw === url && this.now() < until) return; // a late event for the page we just left
      this.stale = null;
    }
    if (this.phase === 'login') {
      if (!this.flow.pastLogin(u)) {
        // A real login page resets the read budget: the person is signing in again, not looping on a signed-out feed.
        if (this.flow.isLogin(u)) this.injections = 0;
        return;
      }
      const first = this.flow.steps[0];
      if (first.direct?.(u, this.ctx)) {
        this.enterStep(0, false);
        this.scheduleInject(raw, isLoad);
      } else if (this.navigations < MAX_NAVIGATIONS) {
        this.navigations += 1;
        this.enterStep(0, true);
      }
    } else if (this.phase === 'reading') {
      if (this.flow.isLogin(u)) this.toLogin(false);
      else if (this.flow.steps[this.step].matches(u, this.ctx)) this.scheduleInject(raw, isLoad);
    } else if (this.phase === 'fallback') {
      if (!this.flow.hostOk(u)) return;
      if (this.flow.isLogin(u)) this.toLogin(false);
      else if (!this.fallbackTarget || (u.host === this.fallbackTarget.host && samePath(u.path, this.fallbackTarget.path)))
        this.arm(SETTLE_MS, () => void this.captureNow());
    }
  }

  /** Opens `url` in the WebView and remembers the page being left, so its trailing events are not mistaken for the new one. */
  private navigateTo(url: string): void {
    this.stale = this.currentRaw ? { url: this.currentRaw, until: this.now() + STALE_PAGE_MS } : null;
    this.deps.loadUrl(url);
  }

  private toLogin(load: boolean): void {
    this.clearTimers();
    this.setPhase('login');
    if (load) this.deps.loadUrl(this.flow.loginUrl);
  }

  private enterStep(i: number, navigate: boolean): void {
    this.step = i;
    this.setPhase('reading');
    if (navigate) this.navigateTo(this.flow.steps[i].url(this.ctx));
    // Whatever happens next (no matching page, no injection), the step must end: the reader's own watchdog replaces this
    // timer once a script is injected.
    this.arm(NAV_TIMEOUT_MS, () => this.onNavTimeout());
  }

  /**
   * One injection per burst of events for a page (a load fires both `onNavigationStateChange` and `onLoadEnd`), but a new
   * document load of the same URL after the script already ran (a reload) is read again.
   */
  private scheduleInject(raw: string, isLoad: boolean): void {
    const at = this.now();
    const last = this.lastInject;
    if (last && last.url === raw && at - last.at < 2_000 && !(isLoad && last.ran)) return;
    if (this.injections >= MAX_INJECTIONS) return;
    this.lastInject = { url: raw, at, ran: false };
    this.clearInjectTimer();
    this.injectTimer = this.setTimer(() => this.injectNow(), INJECT_DELAY_MS);
  }

  private injectNow(): void {
    this.injectTimer = null;
    if (this.phase !== 'reading') return;
    this.injections += 1;
    if (this.lastInject) this.lastInject.ran = true;
    let script: string;
    try {
      script = this.flow.steps[this.step].script(this.ctx);
    } catch {
      void this.stepEmpty(undefined);
      return;
    }
    this.deps.inject(script);
    this.arm(READ_TIMEOUT_MS, () => void this.stepEmpty(undefined));
  }

  /** We opened the stats page but never landed on a page the reader could run on. */
  private onNavTimeout(): void {
    if (this.phase !== 'reading') return;
    // Platforms whose post-login pages are recognisable by URL prove the person is signed in: capture what is on screen.
    // For the others the evidence is weak: go back to waiting for the person to sign in.
    if (this.flow.strongSignedIn) void this.stepEmpty(undefined);
    else this.toLogin(false);
  }

  // ---- reader results ----------------------------------------------------------------------------------------------

  private onStepData(data: unknown): void {
    let outcome: StepOutcome;
    try {
      outcome = this.flow.steps[this.step].finish(data, this.ctx);
    } catch {
      outcome = { kind: 'empty' };
    }
    if (outcome.kind === 'read') {
      void this.finishParsed(outcome.read, outcome.confidence);
    } else if (outcome.kind === 'next' && this.step + 1 < this.flow.steps.length) {
      this.ctx = { ...this.ctx, ...outcome.ctx };
      this.enterStep(this.step + 1, true);
    } else {
      void this.stepEmpty(outcome.kind === 'empty' ? outcome.hint : undefined);
    }
  }

  /**
   * Signed in but nothing usable. A screenshot is worth sending when this step's page shows the numbers, or when the flow
   * names a page that does (Instagram/Reddit profile); otherwise give up.
   */
  private async stepEmpty(hint: unknown): Promise<void> {
    if (this.phase !== 'reading') return;
    this.clearTimers();
    const target = this.flow.fallbackUrl(this.ctx, hint);
    const t = parsePageUrl(target);
    if (!t && !this.flow.steps[this.step].showsNumbers) {
      await this.fail();
      return;
    }
    this.setPhase('fallback');
    this.fallbackTarget = t;
    if (target && t && !(this.currentUrl && this.currentUrl.host === t.host && samePath(this.currentUrl.path, t.path))) {
      this.navigateTo(target);
      this.arm(FALLBACK_LOAD_MS, () => void this.captureNow());
    } else {
      this.arm(300, () => void this.captureNow());
    }
  }

  /** "Screen capture": the WebView as a JPEG, read by Claude through the screenshot endpoint. */
  private async captureNow(): Promise<void> {
    if (!this.in('fallback')) return;
    this.clearTimers();
    this.setPhase('capturing');
    let base64: string;
    try {
      base64 = await this.deps.capture();
    } catch {
      if (this.in('capturing')) await this.fail();
      return;
    }
    if (!this.in('capturing')) return;
    this.setPhase('claude');
    let read: ScreenshotRead;
    try {
      read = await this.deps.readScreenshot(base64, 'image/jpeg');
    } catch {
      if (this.in('claude')) await this.fail();
      return;
    }
    if (!this.in('claude')) return;
    if (!read || !hasNumbers(read)) {
      await this.fail();
      return;
    }
    await this.end(() => this.deps.emitResult({ ...read, source: 'device' }));
  }

  // ---- endings -----------------------------------------------------------------------------------------------------

  private finishParsed(parsed: ParsedRead, confidence: 'high' | 'medium'): Promise<void> {
    const read = toScreenshotRead(this.deps.platform, parsed, confidence);
    return this.end(() => this.deps.emitResult({ ...read, source: 'device' }));
  }

  private fail(): Promise<void> {
    return this.end(() => this.deps.emitClose(AUTO_READ_FAILED));
  }

  /** Marks the run finished, drops the sign-in, then reports back once (unless the sheet went away meanwhile). */
  private async end(report: () => void): Promise<void> {
    if (this.isOver()) return;
    this.phase = 'done';
    this.clearTimers();
    try {
      await this.deps.clearSession?.();
    } catch {
      // best effort
    }
    if (!this.disposed) report();
  }

  // ---- plumbing ----------------------------------------------------------------------------------------------------

  /** Whatever goes wrong inside an input handler ends the run with the failure reason instead of throwing into the caller. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch {
      void this.fail();
    }
  }

  private isOver(): boolean {
    return this.disposed || this.phase === 'done';
  }

  /** `this.phase === x` through a call, so TypeScript does not keep a stale narrowing across an `await`. */
  private in(phase: Phase): boolean {
    return this.phase === phase;
  }

  private setPhase(phase: Exclude<Phase, 'done'>): void {
    this.phase = phase;
    this.deps.onStatus(STATUS[phase]);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Timer callbacks run through `guard` too: a throw inside a timer would otherwise reach the app as an uncaught error. */
  private setTimer(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((f, t) => setTimeout(f, t)))(() => this.guard(fn), ms);
  }

  private clearTimer(id: unknown): void {
    if (id === null || id === undefined) return;
    (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(id);
  }

  private arm(ms: number, fn: () => void): void {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(fn, ms);
  }

  private clearInjectTimer(): void {
    this.clearTimer(this.injectTimer);
    this.injectTimer = null;
  }

  private clearTimers(): void {
    this.clearTimer(this.timer);
    this.timer = null;
    this.clearInjectTimer();
  }
}
