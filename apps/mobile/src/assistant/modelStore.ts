/** The chosen Assistant model: not a secret, so plain AsyncStorage. Unknown stored values read as the default. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { DEFAULT_MODEL, resolveModel, type ModelId } from './models';

const KEY = 'pulse.assistant.model';
const listeners = new Set<(id: ModelId) => void>();

export async function readModel(): Promise<ModelId> {
  try {
    return resolveModel(await AsyncStorage.getItem(KEY));
  } catch {
    return DEFAULT_MODEL;
  }
}

export async function saveModel(id: ModelId): Promise<void> {
  const next = resolveModel(id);
  try {
    await AsyncStorage.setItem(KEY, next);
  } catch {
    // not persisted: this session still uses it
  }
  for (const fn of listeners) fn(next);
}

/** The model in use, kept in step between Settings and the Assistant tab. */
export function useModel(): ModelId {
  const [id, setId] = useState<ModelId>(DEFAULT_MODEL);
  useEffect(() => {
    let alive = true;
    void readModel().then((m) => alive && setId(m));
    listeners.add(setId);
    return () => {
      alive = false;
      listeners.delete(setId);
    };
  }, []);
  return id;
}
