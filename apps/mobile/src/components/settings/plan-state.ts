/**
 * Billing state shared by `PlanCard` and `PlanBadge` (the pill in the Settings header), so the two can never disagree:
 * upgrading flips both at once, and so does the `?billing=success` polling.
 *
 * A tiny module-level store keeps the last answer of `api.getBilling()`, keyed by the session token so a reset
 * workspace never inherits the previous workspace's plan. Every `useBilling()` still loads through `useAsync`
 * (loading / error / quiet refresh when the screen regains focus) and publishes each response to the store.
 */
import { useSyncExternalStore } from 'react';

import { api, currentToken, type BillingInfo } from '@/src/api';
import { useAsync } from '@/src/hooks';
import { useSession } from '@/src/session';

interface Entry {
  /** Session token the answer belongs to. */
  key: string | null;
  /** `null`: this server has no billing API. */
  value: BillingInfo | null;
}

let entry: Entry | undefined;
let issued = 0;
let applied = 0;
const listeners = new Set<() => void>();

const getEntry = (): Entry | undefined => entry;

export function subscribeBilling(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Latest answer for the current workspace, read without React. `undefined`: not loaded yet. `null`: no billing API. */
export function peekBilling(): BillingInfo | null | undefined {
  return entry && entry.key === currentToken() ? entry.value : undefined;
}

/** One `GET /api/billing`. An answer a newer request has already overtaken is dropped: the store only moves forward. */
async function fetchBilling(): Promise<BillingInfo | null> {
  const id = ++issued;
  const key = currentToken();
  const value = await api.getBilling();
  if (id > applied) {
    applied = id;
    entry = { key, value };
    listeners.forEach((listener) => listener());
  }
  return value;
}

export interface BillingState {
  /** `undefined`: nothing for this workspace yet. `null`: this server has no billing API. */
  billing: BillingInfo | null | undefined;
  /** Nothing to show yet and no failure so far: a request is on its way. */
  loading: boolean;
  /** Nothing to show yet and the request failed. A failed refresh never hides data we already have. */
  error: Error | null;
  /** A manual `reload()` is in flight. */
  refreshing: boolean;
  /** Re-fetch quietly; resolves when done, never throws. */
  reload: () => Promise<void>;
}

export function useBilling(): BillingState {
  const { token } = useSession(); // a different workspace (new token) loads its own plan
  const shared = useSyncExternalStore(subscribeBilling, getEntry, getEntry);
  const { error, refreshing, reload } = useAsync(fetchBilling, [token]);

  const known = shared !== undefined && shared.key === currentToken();
  const billing = known ? shared.value : undefined;
  return {
    billing,
    loading: !known && error === null,
    error: known ? null : error,
    refreshing,
    reload,
  };
}
