jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('@react-native-async-storage/async-storage', () => ({}));

import { androidDownloadUrl, androidQrUrl, installPageUrl } from './http';

describe('install URLs', () => {
  it('derive from the public base and carry no token', () => {
    expect(androidDownloadUrl()).toMatch(/^https?:\/\/.+\/download\/android$/);
    expect(androidQrUrl()).toBe(`${androidDownloadUrl()}/qr.svg`);
    expect(installPageUrl()).toMatch(/^https?:\/\/.+\/get$/);
    expect(installPageUrl()).not.toMatch(/token|ws=/);
  });
});
