const start = jest.fn();
const share = jest.fn();

jest.mock('expo-intent-launcher', () => ({ startActivityAsync: (...a: unknown[]) => start(...a) }), { virtual: true });
jest.mock('react-native', () => ({ Share: { share: (...a: unknown[]) => share(...a), dismissedAction: 'dismissedAction' } }));

import { LINKEDIN_PACKAGE, LINKEDIN_POST_ACTIVITY, shareToLinkedInAndroid } from './androidShare';

beforeEach(() => {
  start.mockReset();
  share.mockReset();
});

test('opens LinkedIn\'s post composer with the text', async () => {
  start.mockResolvedValue({ resultCode: 0 });
  await expect(shareToLinkedInAndroid('TEST https://x.dev/r/abc')).resolves.toBe(true);
  expect(start).toHaveBeenCalledWith('android.intent.action.SEND', {
    type: 'text/plain',
    extra: { 'android.intent.extra.TEXT': 'TEST https://x.dev/r/abc' },
    packageName: LINKEDIN_PACKAGE,
    className: LINKEDIN_POST_ACTIVITY,
  });
  expect(share).not.toHaveBeenCalled();
});

test('falls back to the share sheet when LinkedIn cannot be opened', async () => {
  start.mockRejectedValue(new Error('ActivityNotFound'));
  share.mockResolvedValue({ action: 'sharedAction' });
  await expect(shareToLinkedInAndroid('hello')).resolves.toBe(true);
  expect(share).toHaveBeenCalledWith({ message: 'hello' });
});

test('a dismissed share sheet is not a post', async () => {
  start.mockRejectedValue(new Error('nope'));
  share.mockResolvedValue({ action: 'dismissedAction' });
  await expect(shareToLinkedInAndroid('hello')).resolves.toBe(false);
});
