/**
 * What happens when the user comes back from a checkout page: the `?billing=` redirect, and refreshing the plan when
 * the window regains focus.
 */
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { haptic, useToast } from '@/src/ui';
import { peekBilling, subscribeBilling } from './plan-state';

/** Stripe's webhook can lag behind the redirect: look every 2 s, for up to 20 s. */
const POLL_MS = 2000;
const MAX_POLLS = 10;

/** A repeated `?billing=a&billing=b` arrives as an array. */
const firstParam = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Handles `/settings?billing=success|cancelled`. Says what happened and clears the param right away, so a page refresh
 * does not repeat it. After a payment it re-fetches the plan every 2 s until it is Pro, then welcomes the user;
 * `reload` is the card's own refresh, so the header pill follows through the shared store.
 */
export function useCheckoutReturn(reload: () => Promise<void>): void {
  const { show } = useToast();
  const showRef = useRef(show);
  showRef.current = show;

  const params = useLocalSearchParams<{ billing?: string }>();
  const flag = firstParam(params.billing);
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    if (flag !== 'success' && flag !== 'cancelled') return;
    if (flag === 'success') {
      showRef.current('Payment received, activating Pro...');
      setActivating(true);
    } else {
      showRef.current('Checkout cancelled', 'info');
    }
    try {
      router.setParams({ billing: undefined });
    } catch {
      // The router is not ready: the param stays, which is harmless (the flag above only reacts to a change).
    }
    // On the web the address bar keeps `?billing=...` after setParams: strip it so a refresh does not repeat the toast.
    // (Delayed: the router writes the URL itself a moment after setParams and would put the param back.)
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const strip = () => {
        try {
          const url = new URL(window.location.href);
          if (url.searchParams.has('billing')) {
            url.searchParams.delete('billing');
            window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
          }
        } catch {
          // ignore
        }
      };
      setTimeout(strip, 400);
      setTimeout(strip, 1500);
    }
  }, [flag]);

  useEffect(() => {
    if (!activating) return undefined;
    let over = false;
    let polls = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const finish = (outcome: 'pro' | 'late' | 'quiet') => {
      if (over) return;
      over = true;
      if (timer) clearInterval(timer);
      setActivating(false);
      if (outcome === 'pro') {
        haptic.success();
        showRef.current('Welcome to Pro');
      } else if (outcome === 'late') {
        showRef.current('Still activating Pro. This can take a minute.', 'info');
      }
    };
    // Reads the store, not React state, so it is right the instant a response lands (and on the very first look).
    const check = () => {
      const billing = peekBilling();
      if (billing === null) finish('quiet'); // this server has no billing: nothing to wait for
      else if (billing?.plan === 'pro') finish('pro');
    };

    const unsubscribe = subscribeBilling(check);
    check();
    if (!over) {
      timer = setInterval(() => {
        polls += 1;
        // A response that says "pro" has already finished us (through the store) before this resolves.
        void reload().then(() => {
          if (polls >= MAX_POLLS) finish('late');
        });
      }, POLL_MS);
    }
    return () => {
      over = true;
      if (timer) clearInterval(timer);
      unsubscribe();
    };
  }, [activating, reload]);
}

/**
 * Web: refresh the plan whenever this window regains focus. `useAsync` already refreshes when the browser tab becomes
 * visible again, but not when focus moves between two visible windows (a checkout opened as a popup window).
 */
export function useReloadOnWindowFocus(reload: () => Promise<void>): void {
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused || Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [focused, reload]);
}
