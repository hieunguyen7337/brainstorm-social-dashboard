/** Unit tests for src/desktop/index.ts (the bridge lookup): `npx jest --ci src/desktop`. */
import { desktopApiUrl, getDesktop, isDesktop } from './index';

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
});
