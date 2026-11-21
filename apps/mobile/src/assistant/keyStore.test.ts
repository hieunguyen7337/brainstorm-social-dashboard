const store: Record<string, string> = {};
const fake = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void (store[k] = v)),
  deleteItemAsync: jest.fn(async (k: string) => void delete store[k]),
};
let available = true;
jest.mock('@/src/vault/native', () => ({ loadSecureStore: () => (available ? fake : null) }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { deleteApiKey, keyStoreAvailable, readApiKey, saveApiKey } from './keyStore';

const FAKE = `sk-ant-api03-${'A1b2C3d4'.repeat(10)}WXYZ`;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  available = true;
  jest.clearAllMocks();
});

describe('keyStore', () => {
  it('saves, reads and deletes through the secure store, device-only', async () => {
    await saveApiKey(`  ${FAKE}\n`);
    expect(fake.setItemAsync).toHaveBeenCalledWith(expect.any(String), FAKE, { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' });
    expect(await readApiKey()).toBe(FAKE);
    await deleteApiKey();
    expect(await readApiKey()).toBeNull();
  });

  it('refuses a malformed key without touching the store', async () => {
    await expect(saveApiKey('hello')).rejects.toThrow(/sk-ant-/);
    expect(fake.setItemAsync).not.toHaveBeenCalled();
  });

  it('never uses AsyncStorage', async () => {
    await saveApiKey(FAKE);
    await readApiKey();
    await deleteApiKey();
    for (const fn of Object.values(AsyncStorage as unknown as Record<string, jest.Mock>)) expect(fn).not.toHaveBeenCalled();
  });

  it('reports an old binary without the module as unavailable, with a clear error', async () => {
    available = false;
    expect(keyStoreAvailable()).toBe(false);
    expect(await readApiKey()).toBeNull();
    await expect(saveApiKey(FAKE)).rejects.toThrow(/latest version/);
  });

  it('ignores a corrupt stored value', async () => {
    store['pulse.assistant.anthropic.v1'] = 'garbage';
    expect(await readApiKey()).toBeNull();
  });
});
