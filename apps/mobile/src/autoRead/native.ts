/**
 * The two native modules (react-native-webview, react-native-view-shot), loaded at call time and never at the top level.
 *
 * OTA safety: the installed 1.0.0 APK has neither native module. Both libraries throw while being imported when their
 * native side is missing, and Metro reports an exception thrown by a lazy `require` as a FATAL error (it does not reach a
 * try/catch). So the native modules are probed first (`TurboModuleRegistry.get` returns null instead of throwing), and the
 * JS packages are required only when both are present.
 */
import { NativeModules, Platform, TurboModuleRegistry } from 'react-native';

type WebViewModule = typeof import('react-native-webview');
type ViewShotModule = typeof import('react-native-view-shot');

export type WebViewComponent = WebViewModule['WebView'];
export type WebViewRef = InstanceType<WebViewComponent>;

export interface NativeBits {
  WebView: WebViewComponent;
  captureRef: ViewShotModule['captureRef'];
}

/** `TurboModuleRegistry.get` returns null (it never throws) for a module that is not in the native binary. */
function nativeModulePresent(name: string): boolean {
  try {
    return TurboModuleRegistry.get(name) != null || (NativeModules as Record<string, unknown>)[name] != null;
  } catch {
    return false;
  }
}

let loaded: NativeBits | null | undefined;

/** Both native modules, or null. Probes the native side first, then requires the JS packages. */
export function loadNative(): NativeBits | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (Platform.OS === 'web') return loaded;
  // react-native-view-shot registers 'RNViewShot' and react-native-webview 'RNCWebViewModule' (both TurboModule names).
  if (!nativeModulePresent('RNViewShot') || !nativeModulePresent('RNCWebViewModule')) return loaded;
  try {
    const { WebView } = require('react-native-webview') as WebViewModule;
    const { captureRef } = require('react-native-view-shot') as ViewShotModule;
    if (WebView && typeof captureRef === 'function') loaded = { WebView, captureRef };
  } catch {
    loaded = null;
  }
  return loaded;
}

/** True only on native when both native modules are present and load. Cheap: safe to call on every render. */
export function autoReadAvailable(): boolean {
  return Platform.OS !== 'web' && loadNative() !== null;
}
