import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Alert, Platform, type TextStyle } from 'react-native';

/** Spread into a raw `TextInput` style to remove the browser focus outline (no-op on native). */
export const webNoOutline: TextStyle =
  Platform.OS === 'web' ? ({ outlineStyle: 'none', outlineWidth: 0 } as unknown as TextStyle) : {};

/** Cross-platform confirm: `window.confirm` on web (Alert.alert is a no-op there), a native alert elsewhere. */
export function confirm(
  title: string,
  message: string,
  confirmLabel = 'OK',
  destructive = false,
): Promise<boolean> {
  if (Platform.OS === 'web') {
    const ok = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(`${title}\n\n${message}`) : true;
    return Promise.resolve(ok);
  }
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** Copy text to the clipboard (with a legacy fallback for non-secure web contexts). Resolves true on success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    haptic.success();
    return true;
  } catch {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      try {
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(el);
        return ok;
      } catch {
        return false;
      }
    }
    return false;
  }
}

const safe = (fn: () => Promise<unknown>) => {
  if (Platform.OS === 'web') return;
  fn().catch(() => undefined);
};

/** Haptics are native-only and fire-and-forget. */
export const haptic = {
  tap: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  select: () => safe(() => Haptics.selectionAsync()),
  success: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warn: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
};

/** Easing used by the hand-rolled rAF tweens. */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
