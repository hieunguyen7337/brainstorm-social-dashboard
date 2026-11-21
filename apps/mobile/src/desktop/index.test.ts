/** Unit tests for src/desktop/index.ts (the bridge lookup): `npx jest --ci src/desktop`. */
import { desktopApiUrl, desktopTitleBarInset, getDesktop, isDesktop } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (v: unknown) => any;

const g = globalThis as any;

describe('desktop bridge', () => {
  it('is absent without window.pulseDesktop', () => {
    delete g.window;
    expect(getDesktop()).toBe(null);
    g.window = {};
    expect(isDesktop()).toBe(false);
    expect(desktopApiUrl()).toBe(null);
    delete g.window;
  });

  it('is found by its version and gives the API base without a trailing slash', () => {
    g.window = { pulseDesktop: { version: 1, apiUrl: 'https://pulse.example.fly.dev//' } };
    expect(isDesktop()).toBe(true);
    expect(desktopApiUrl()).toBe('https://pulse.example.fly.dev');
    delete g.window;
  });

  it('reserves the title bar strip on macOS and Windows only', () => {
    delete g.window;
    expect(desktopTitleBarInset()).toBe(0);
    for (const [platform, inset] of [['darwin', 40], ['win32', 40], ['linux', 0]] as const) {
      g.window = { pulseDesktop: { version: 1, apiUrl: 'x', platform } };
      expect(desktopTitleBarInset()).toBe(inset);
    }
    delete g.window;
  });
});
