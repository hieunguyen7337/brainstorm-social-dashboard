import { assistantTabVisible } from './visibility';
import { handoffRoute, confirmLabel } from './post';

describe('assistantTabVisible', () => {
  it('shows on desktop and on the native apps, hides on plain web', () => {
    expect(assistantTabVisible({ desktop: true, os: 'web' })).toBe(true);
    expect(assistantTabVisible({ desktop: false, os: 'android' })).toBe(true);
    expect(assistantTabVisible({ desktop: false, os: 'ios' })).toBe(true);
    expect(assistantTabVisible({ desktop: false, os: 'web' })).toBe(false);
  });
});

describe('handoffRoute', () => {
  const base = { os: 'android', autopost: false, autopostAvailable: false, canShare: true, hasPhoto: true };
  it('shares the photo through the share sheet by default (Android and iOS)', () => {
    expect(handoffRoute(base)).toBe('share');
    expect(handoffRoute({ ...base, os: 'ios' })).toBe('share');
  });
  it('auto-posts only on Android with the flag on and the WebView present', () => {
    expect(handoffRoute({ ...base, autopost: true, autopostAvailable: true })).toBe('autopost');
    expect(handoffRoute({ ...base, os: 'ios', autopost: true, autopostAvailable: true })).toBe('share');
    expect(handoffRoute({ ...base, autopost: true, autopostAvailable: false })).toBe('share');
  });
  it('opens the Instagram app when there is no photo or no sharing', () => {
    expect(handoffRoute({ ...base, hasPhoto: false })).toBe('open_app');
    expect(handoffRoute({ ...base, canShare: false })).toBe('open_app');
  });
  it('labels the button by what it does', () => {
    expect(confirmLabel('autopost')).toBe('Post to Instagram');
    expect(confirmLabel('share')).toBe('Share to Instagram');
    expect(confirmLabel('open_app')).toBe('Open Instagram');
  });
});
