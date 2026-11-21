/**
 * Disconnect clears the platform's saved login and the in-app sign-in (docs/VAULT.md). Sign-out does the same for every
 * platform (session.tsx). Nothing else may clear them: the sign-in sheet's runner is never given a clearSession.
 */
jest.mock('@/src/autoRead', () => ({ forgetSignIns: jest.fn(async () => undefined) }));
jest.mock('@/src/vault', () => ({ deleteLogin: jest.fn(async () => undefined) }));

import fs from 'fs';
import path from 'path';

import { forgetSignIns } from '@/src/autoRead';
import { deleteLogin } from '@/src/vault';
import { forgetOnPhone } from '../forgetOnPhone';

const root = path.join(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

beforeEach(() => jest.clearAllMocks());

describe('forgetOnPhone', () => {
  it("deletes that platform's saved login and drops the in-app sign-in", async () => {
    await forgetOnPhone('linkedin');
    expect(deleteLogin).toHaveBeenCalledWith('linkedin');
    expect(deleteLogin).toHaveBeenCalledTimes(1);
    expect(forgetSignIns).toHaveBeenCalledTimes(1);
  });

  it('never throws, and still does the other half when one fails', async () => {
    const del = jest.fn(async () => {
      throw new Error('keystore');
    });
    const forget = jest.fn(() => {
      throw new Error('no webview');
    });
    await expect(forgetOnPhone('x', { deleteLogin: del, forgetSignIns: forget as never })).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith('x');
    expect(forget).toHaveBeenCalledTimes(1);
  });
});

describe('who clears a sign-in (source)', () => {
  it('Settings > Disconnect forgets the platform on this phone after the server disconnects it', () => {
    const src = read('src/components/settings/ConnectorsSection.tsx');
    const body = src.slice(src.indexOf('const disconnect = async'), src.indexOf('const openForm'));
    expect(body).toMatch(/await api\.disconnect\(platform\)[\s\S]*forgetOnPhone\(platform\)/);
  });

  it('workspace sign-out clears every saved login and the sign-ins', () => {
    const src = read('src/session.tsx');
    expect(src).toMatch(/forgetSignIns\(\)/);
    expect(src).toMatch(/clearVault\(\)/);
  });

  it('the sign-in sheet never drops the sign-in when a read ends', () => {
    expect(read('src/autoRead/index.tsx')).not.toMatch(/clearSession|incognito\s*(=\s*\{\s*true\s*\})?[\s/>]/);
  });
});
