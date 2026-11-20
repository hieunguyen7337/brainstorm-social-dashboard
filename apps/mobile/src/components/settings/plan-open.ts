/**
 * Opening a checkout or billing-portal page.
 *
 * The URL only exists after an API call, and browsers block `window.open` outside the tap that asked for it. So on the
 * web a placeholder tab is opened inside the tap and pointed at the URL once it arrives. (`window.open(url, '_blank',
 * 'noopener')` cannot be used: with `noopener` it always returns null, so a blocked popup is indistinguishable from an
 * opened one.) If the placeholder could not be opened, the URL opens in a new tab and, if popups are blocked, in this
 * one.
 */
import { Linking, Platform } from 'react-native';

import type { CheckoutRequest } from '@/src/api';
import { APP_NAME } from '@/src/config';
import { colors } from '@/src/theme';

const onWeb = (): boolean => Platform.OS === 'web' && typeof window !== 'undefined';

/** Web: where Stripe / the demo checkout sends the browser back to. Native uses the server's defaults. */
export function checkoutRequest(): CheckoutRequest | undefined {
  if (!onWeb()) return undefined;
  const { origin } = window.location;
  return { success_url: `${origin}/settings?billing=success`, cancel_url: `${origin}/settings?billing=cancelled` };
}

/**
 * Web only: open a dark "Opening checkout..." tab right now, inside the tap. Null on native, or when even this is
 * blocked (the URL is then opened later in this tab).
 */
export function openPlaceholderTab(): Window | null {
  if (!onWeb()) return null;
  try {
    const tab = window.open('about:blank', '_blank');
    if (!tab) return null;
    try {
      tab.opener = null; // the page we are about to send it to must not be able to reach back into this app
      const doc = tab.document;
      doc.title = `${APP_NAME} checkout`;
      const viewport = doc.createElement('meta');
      viewport.name = 'viewport';
      viewport.content = 'width=device-width, initial-scale=1';
      doc.head.appendChild(viewport);
      Object.assign(doc.body.style, {
        margin: '0',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: colors.bg,
        color: colors.textDim,
        font: '600 15px system-ui, -apple-system, sans-serif',
      });
      doc.body.textContent = 'Opening checkout...';
    } catch {
      // Could not paint it: a blank tab works just as well.
    }
    return tab;
  } catch {
    return null;
  }
}

export function closeTab(tab: Window | null): void {
  try {
    tab?.close();
  } catch {
    // already gone
  }
}

/** Send the user to `url`. Resolves false (and closes the placeholder tab) when it could not be opened. */
export async function openUrl(url: string, tab: Window | null = null): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) {
    closeTab(tab);
    return false;
  }
  try {
    if (!onWeb()) {
      await Linking.openURL(url);
      return true;
    }
    if (tab) {
      if (!tab.closed) tab.location.replace(url); // closed by the user meanwhile: they changed their mind
      return true;
    }
    const opened = window.open(url, '_blank');
    if (opened) {
      try {
        opened.opener = null;
      } catch {
        // already navigated: nothing to detach
      }
    } else {
      window.location.assign(url); // popups are blocked: leave this page instead
    }
    return true;
  } catch {
    closeTab(tab);
    return false;
  }
}
