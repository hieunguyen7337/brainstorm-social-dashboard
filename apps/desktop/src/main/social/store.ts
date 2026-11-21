/** lastReadAt per platform, kept as JSON in the app's userData folder. No credentials, only timestamps. */
import fs from 'node:fs';
import type { Platform } from '@/src/desktop/types';

export interface ReadStore {
  get(platform: Platform): string | null;
  set(platform: Platform, iso: string): void;
  clear(platform: Platform): void;
}

export function createStore(file: string): ReadStore {
  let data: Record<string, string> | null = null;
  const load = (): Record<string, string> => {
    if (data) return data;
    data = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') data[k] = v;
      }
    } catch {
      // missing or corrupt file: start empty
    }
    return data;
  };
  const save = (): void => {
    try {
      fs.writeFileSync(file, JSON.stringify(load()), { mode: 0o600 });
    } catch {
      // best effort: a failed write only loses the "last read" label
    }
  };
  return {
    get: (p) => load()[p] ?? null,
    set(p, iso) {
      load()[p] = iso;
      save();
    },
    clear(p) {
      delete load()[p];
      save();
    },
  };
}
