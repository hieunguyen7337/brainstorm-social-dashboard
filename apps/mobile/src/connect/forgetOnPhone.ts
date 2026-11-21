/**
 * Disconnecting a platform also forgets it on this phone (docs/VAULT.md, "What clears a sign-in"): the saved login for
 * that platform and the in-app sign-in (cookies). Those two, and the workspace sign-out, are the only things that clear
 * them.
 *
 * react-native-webview has no per-site cookie API, so `forgetSignIns()` clears the in-app cookie store for every platform
 * (an Android incognito WebView). The other platforms keep their saved logins and the sign-in sheet fills them back in by
 * itself the next time it opens; dropping only one site's cookies would need a native cookie module in a new APK.
 */
import { forgetSignIns } from '@/src/autoRead';
import type { Platform } from '@/src/types';
import { deleteLogin } from '@/src/vault';

export interface ForgetDeps {
  deleteLogin(platform: Platform): Promise<void>;
  forgetSignIns(): Promise<void>;
}

/** Never throws; resolves when both are done. */
export async function forgetOnPhone(platform: Platform, deps: ForgetDeps = { deleteLogin, forgetSignIns }): Promise<void> {
  await Promise.all([
    Promise.resolve().then(() => deps.deleteLogin(platform)).catch(() => undefined),
    Promise.resolve().then(() => deps.forgetSignIns()).catch(() => undefined),
  ]);
}
