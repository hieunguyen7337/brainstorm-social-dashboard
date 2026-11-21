/**
 * The vault store (src/vault/index.ts) against an in-memory secure store and AsyncStorage. The rule under test: nothing
 * but the fill script ever carries a saved value, and the non-secret index holds no username.
 */
import fs from 'fs';
import path from 'path';

const secure = new Map<string, { value: string; opts: any }>();
let bioCapable = false;
let failReads = false;
let storeMissing = false;

const fakeStore = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
  canUseBiometricAuthentication: jest.fn(() => bioCapable),
  setItemAsync: jest.fn(async (k: string, v: string, opts: any) => void secure.set(k, { value: v, opts })),
  getItemAsync: jest.fn(async (k: string, _opts: any) => {
    if (failReads) throw new Error('User canceled the authentication');
    return secure.get(k)?.value ?? null;
  }),
  deleteItemAsync: jest.fn(async (k: string, _opts: any) => void secure.delete(k)),
};

jest.mock('../native', () => ({ loadSecureStore: () => (storeMissing ? null : fakeStore) }));

const async = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (k: string) => async.get(k) ?? null,
    setItem: async (k: string, v: string) => void async.set(k, v),
    removeItem: async (k: string) => void async.delete(k),
  },
}));

import * as vault from '../index';

const USER = 'jane.doe@example.com';
const PASS = 'correct horse battery staple';

beforeEach(() => {
  secure.clear();
  async.clear();
  bioCapable = false;
  failReads = false;
  storeMissing = false;
  jest.clearAllMocks();
});

describe('saving', () => {
  it('stores the login encrypted-at-rest and only a non-secret index in AsyncStorage', async () => {
    await vault.saveLogin('linkedin', `  ${USER} `, PASS);
    expect(await vault.hasLogin('linkedin')).toBe(true);
    expect(await vault.hasLogin('instagram')).toBe(false);
    const idx = await vault.vaultIndex();
    expect(Object.keys(idx)).toEqual(['linkedin']);
    expect(typeof idx.linkedin!.savedAt).toBe('string');
    const plain = [...async.values()].join('|');
    expect(plain).not.toContain(USER);
    expect(plain).not.toContain(PASS);
    expect(JSON.parse(secure.get('pulse.vault.v1.linkedin')!.value)).toEqual({ v: 1, u: USER, p: PASS });
    expect(secure.get('pulse.vault.v1.linkedin')!.opts).toMatchObject({ keychainAccessible: 7, requireAuthentication: false });
  });

  it('asks for biometrics on every read when the phone has them', async () => {
    bioCapable = true;
    await vault.saveLogin('instagram', USER, PASS);
    expect(secure.get('pulse.vault.v1.instagram')!.opts.requireAuthentication).toBe(true);
    await vault.fillScriptFor('instagram');
    expect(fakeStore.getItemAsync).toHaveBeenCalledWith(
      'pulse.vault.v1.instagram',
      expect.objectContaining({ requireAuthentication: true, authenticationPrompt: 'Unlock your saved Instagram login' }),
    );
  });

  it.each([
    ['', PASS],
    ['   ', PASS],
    [USER, ''],
    ['x'.repeat(513), PASS],
    [USER, 'y'.repeat(513)],
  ])('refuses unusable input (%#)', async (u, p) => {
    await expect(vault.saveLogin('x', u, p)).rejects.toThrow();
    expect(secure.size).toBe(0);
    expect(await vault.hasLogin('x')).toBe(false);
  });

  it('replacing a login overwrites the old one', async () => {
    await vault.saveLogin('x', USER, PASS);
    await vault.saveLogin('x', 'new_user', 'new pass');
    expect(JSON.parse(secure.get('pulse.vault.v1.x')!.value)).toMatchObject({ u: 'new_user', p: 'new pass' });
  });

  it('a failed write leaves no stale "saved" entry behind', async () => {
    await vault.saveLogin('x', USER, PASS);
    fakeStore.setItemAsync.mockRejectedValueOnce(new Error('keystore'));
    await expect(vault.saveLogin('x', 'other', 'other pass')).rejects.toThrow("Couldn't save");
    expect(await vault.hasLogin('x')).toBe(false);
  });
});

describe('reading back', () => {
  it('no exported function returns or exposes a saved value, except the fill script', async () => {
    await vault.saveLogin('reddit', USER, PASS);
    const results: unknown[] = [
      vault.vaultAvailable(),
      await vault.vaultIndex(),
      await vault.hasLogin('reddit'),
    ];
    const text = JSON.stringify(results);
    expect(text).not.toContain(USER);
    expect(text).not.toContain(PASS);
    // Every export is accounted for: a new one has to be added to this test (and must not return a value).
    expect(Object.keys(vault).sort()).toEqual(
      [
        'MAX_FIELD',
        'biometricsAvailable',
        'canFill',
        'clearVault',
        'deleteLogin',
        'fillScriptFor',
        'hasLogin',
        'saveLogin',
        'setLoginBio',
        'takeVaultFill',
        'useVaultStatus',
        'vaultAvailable',
        'vaultIndex',
      ].sort(),
    );
  });

  it('the fill script is the one place the values go, as escaped literals', async () => {
    await vault.saveLogin('reddit', USER, 'pa"ss</script>');
    const script = await vault.fillScriptFor('reddit');
    expect(script).toContain(USER);
    expect(script).not.toContain('</script>');
    expect(script!.startsWith('(function () {')).toBe(true);
  });

  it('gives null when there is no login, when the prompt is cancelled, or when the entry is unreadable', async () => {
    expect(await vault.fillScriptFor('tiktok')).toBeNull();
    await vault.saveLogin('tiktok', USER, PASS);
    failReads = true;
    expect(await vault.fillScriptFor('tiktok')).toBeNull();
    failReads = false;
    secure.set('pulse.vault.v1.tiktok', { value: '{broken', opts: {} });
    expect(await vault.fillScriptFor('tiktok')).toBeNull();
  });
});

describe('biometric choice per login', () => {
  const FAKE_PASS = 'hunter2-fake';
  const KEY = 'pulse.vault.v1.linkedin';
  const OLD_DAY = '2026-01-02T03:04:05.000Z';
  const backdate = (bio: boolean) =>
    async.set('pulse.vault.meta', JSON.stringify({ linkedin: { savedAt: OLD_DAY, bio } }));

  it('saveLogin with { bio: false } on a phone with biometrics saves it without the prompt', async () => {
    bioCapable = true;
    await vault.saveLogin('linkedin', USER, FAKE_PASS, { bio: false });
    expect(secure.get(KEY)!.opts.requireAuthentication).toBe(false);
    expect((await vault.vaultIndex()).linkedin!.bio).toBe(false);
  });

  it('saveLogin with { bio: true } on a phone without biometrics saves it without the prompt', async () => {
    await vault.saveLogin('linkedin', USER, FAKE_PASS, { bio: true });
    expect(secure.get(KEY)!.opts.requireAuthentication).toBe(false);
    expect((await vault.vaultIndex()).linkedin!.bio).toBe(false);
  });

  it('biometricsAvailable needs the secure store and biometrics, and never throws', () => {
    expect(vault.biometricsAvailable()).toBe(false);
    bioCapable = true;
    expect(vault.biometricsAvailable()).toBe(true);
    fakeStore.canUseBiometricAuthentication.mockImplementationOnce(() => {
      throw new Error('no hardware');
    });
    expect(vault.biometricsAvailable()).toBe(false);
    storeMissing = true;
    expect(vault.biometricsAvailable()).toBe(false);
  });

  it('setLoginBio(true) rewrites the same value behind the prompt and keeps savedAt', async () => {
    bioCapable = true;
    await vault.saveLogin('linkedin', USER, FAKE_PASS, { bio: false });
    backdate(false);
    const before = secure.get(KEY)!.value;
    jest.clearAllMocks();
    await vault.setLoginBio('linkedin', true);
    expect(fakeStore.getItemAsync).toHaveBeenCalledWith(KEY, expect.objectContaining({ requireAuthentication: false }));
    expect(fakeStore.deleteItemAsync).toHaveBeenCalledWith(KEY, expect.objectContaining({ requireAuthentication: false }));
    expect(fakeStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(fakeStore.deleteItemAsync.mock.invocationCallOrder[0]).toBeLessThan(
      fakeStore.setItemAsync.mock.invocationCallOrder[0],
    );
    expect(secure.get(KEY)!.value).toBe(before);
    expect(secure.get(KEY)!.opts).toMatchObject({ keychainAccessible: 7, requireAuthentication: true });
    expect((await vault.vaultIndex()).linkedin).toEqual({ savedAt: OLD_DAY, bio: true });
    expect(await vault.fillScriptFor('linkedin')).toContain(USER);
    expect(fakeStore.getItemAsync).toHaveBeenLastCalledWith(KEY, expect.objectContaining({ requireAuthentication: true }));
  });

  it('setLoginBio(false) unlocks with the prompt, then writes without it', async () => {
    bioCapable = true;
    await vault.saveLogin('linkedin', USER, FAKE_PASS);
    backdate(true);
    jest.clearAllMocks();
    await vault.setLoginBio('linkedin', false);
    expect(fakeStore.getItemAsync).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ requireAuthentication: true, authenticationPrompt: 'Unlock your saved LinkedIn login' }),
    );
    expect(fakeStore.deleteItemAsync).toHaveBeenCalledWith(KEY, expect.objectContaining({ requireAuthentication: true }));
    expect(fakeStore.setItemAsync).toHaveBeenCalledWith(KEY, expect.any(String), expect.objectContaining({ requireAuthentication: false }));
    expect(JSON.parse(secure.get(KEY)!.value)).toEqual({ v: 1, u: USER, p: FAKE_PASS });
    expect((await vault.vaultIndex()).linkedin).toEqual({ savedAt: OLD_DAY, bio: false });
  });

  it('asking for the state it already has changes nothing and shows no prompt', async () => {
    bioCapable = true;
    await vault.saveLogin('linkedin', USER, FAKE_PASS, { bio: false });
    jest.clearAllMocks();
    await vault.setLoginBio('linkedin', false);
    expect(fakeStore.getItemAsync).not.toHaveBeenCalled();
    expect(fakeStore.setItemAsync).not.toHaveBeenCalled();
    expect(fakeStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('a cancelled prompt or an unreadable entry throws and leaves the old entry and index alone', async () => {
    bioCapable = true;
    await vault.saveLogin('linkedin', USER, FAKE_PASS);
    backdate(true);
    const before = { ...secure.get(KEY)! };
    jest.clearAllMocks();
    failReads = true;
    await expect(vault.setLoginBio('linkedin', false)).rejects.toThrow("Couldn't unlock the saved login.");
    failReads = false;
    expect(fakeStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(fakeStore.setItemAsync).not.toHaveBeenCalled();
    expect(secure.get(KEY)).toEqual(before);
    expect((await vault.vaultIndex()).linkedin).toEqual({ savedAt: OLD_DAY, bio: true });

    secure.set(KEY, { value: '{broken', opts: before.opts });
    await expect(vault.setLoginBio('linkedin', false)).rejects.toThrow("Couldn't unlock the saved login.");
    expect(secure.get(KEY)!.value).toBe('{broken');
    expect((await vault.vaultIndex()).linkedin).toEqual({ savedAt: OLD_DAY, bio: true });
  });

  it('a failed write puts the old entry back and leaves the index alone', async () => {
    bioCapable = true;
    await vault.saveLogin('linkedin', USER, FAKE_PASS, { bio: false });
    backdate(false);
    const before = secure.get(KEY)!.value;
    fakeStore.setItemAsync.mockRejectedValueOnce(new Error('User canceled the authentication'));
    await expect(vault.setLoginBio('linkedin', true)).rejects.toThrow("Couldn't change the saved login. Try again.");
    expect(secure.get(KEY)!.value).toBe(before);
    expect(secure.get(KEY)!.opts.requireAuthentication).toBe(false);
    expect((await vault.vaultIndex()).linkedin).toEqual({ savedAt: OLD_DAY, bio: false });
    expect(await vault.fillScriptFor('linkedin')).toContain(USER);
  });

  it('refuses a platform with no login, and the prompt on a phone without biometrics', async () => {
    await expect(vault.setLoginBio('linkedin', true)).rejects.toThrow('No login saved for this platform.');
    await vault.saveLogin('linkedin', USER, FAKE_PASS);
    jest.clearAllMocks();
    await expect(vault.setLoginBio('linkedin', true)).rejects.toThrow("This phone can't ask for a fingerprint or face.");
    expect(fakeStore.getItemAsync).not.toHaveBeenCalled();
    expect((await vault.vaultIndex()).linkedin!.bio).toBe(false);
  });

  it('nothing these return or throw carries the saved login', async () => {
    bioCapable = true;
    const out: unknown[] = [
      vault.biometricsAvailable(),
      await vault.saveLogin('linkedin', USER, FAKE_PASS, { bio: false }),
      await vault.setLoginBio('linkedin', true),
      await vault.setLoginBio('linkedin', false),
    ];
    failReads = true;
    await vault.setLoginBio('linkedin', true).catch((e: Error) => out.push(e.message));
    failReads = false;
    fakeStore.setItemAsync.mockRejectedValueOnce(new Error('keystore'));
    await vault.setLoginBio('linkedin', true).catch((e: Error) => out.push(e.message));
    expect(out).toHaveLength(6);
    const text = JSON.stringify(out) + JSON.stringify([...async.values()]);
    expect(text).not.toContain(USER);
    expect(text).not.toContain(FAKE_PASS);
  });
});

describe('forgetting', () => {
  it('deleteLogin removes the secret and the index entry', async () => {
    await vault.saveLogin('facebook', USER, PASS);
    await vault.saveLogin('x', USER, PASS);
    await vault.deleteLogin('facebook');
    expect(secure.has('pulse.vault.v1.facebook')).toBe(false);
    expect(await vault.hasLogin('facebook')).toBe(false);
    expect(await vault.hasLogin('x')).toBe(true);
  });

  it('clearVault removes every login and the index', async () => {
    await vault.saveLogin('facebook', USER, PASS);
    await vault.saveLogin('x', USER, PASS);
    await vault.clearVault();
    expect(secure.size).toBe(0);
    expect(async.size).toBe(0);
  });
});

describe('without the native module (old APK) ', () => {
  it('reports unavailable and refuses to save', async () => {
    storeMissing = true;
    expect(vault.vaultAvailable()).toBe(false);
    await expect(vault.saveLogin('x', USER, PASS)).rejects.toThrow('latest version');
    expect(await vault.hasLogin('x')).toBe(false);
    expect(await vault.fillScriptFor('x')).toBeNull();
    await expect(vault.clearVault()).resolves.toBeUndefined();
  });
});

describe('source hygiene', () => {
  const dir = path.join(__dirname, '..');
  const sources = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f));

  it.each(sources)('%s never logs and never touches the clipboard or the network', (f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/Clipboard|expo-clipboard/);
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|@\/src\/(api|http|realApi)/);
  });

  it('expo-secure-store is only ever required lazily, in native.ts', () => {
    for (const f of sources) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (f === 'native.ts') {
        expect(src).not.toMatch(/^import .*expo-secure-store/m);
        expect(src).toMatch(/require\('expo-secure-store'\)/);
      } else {
        expect(src).not.toMatch(/from 'expo-secure-store'|require\('expo-secure-store'\)/);
      }
    }
  });
});
