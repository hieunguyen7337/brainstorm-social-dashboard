import Ionicons from '@expo/vector-icons/Ionicons';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, withAlpha } from '@/src/theme';

type Tone = 'success' | 'error' | 'info';
interface ToastApi {
  show: (message: string, tone?: Tone) => void;
}

const Ctx = createContext<ToastApi>({ show: () => undefined });

/** Mount once at the root. `useToast().show('Copied')` anywhere below. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; tone: Tone } | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();

  const show = useCallback(
    (text: string, tone: Tone = 'success') => {
      if (timer.current) clearTimeout(timer.current);
      setMsg({ text, tone });
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: Platform.OS !== 'web' }).start();
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 260, useNativeDriver: Platform.OS !== 'web' }).start(() =>
          setMsg(null),
        );
      }, 2200);
    },
    [opacity],
  );

  const api = useMemo(() => ({ show }), [show]);
  const c = msg?.tone === 'error' ? colors.danger : msg?.tone === 'info' ? colors.info : colors.success;

  return (
    <Ctx.Provider value={api}>
      {children}
      {msg ? (
        <View pointerEvents="none" style={[styles.host, { bottom: insets.bottom + 84 }]}>
          <Animated.View style={[styles.toast, { opacity, borderColor: withAlpha(c, 0.5) }]}>
            <Ionicons
              name={msg.tone === 'error' ? 'alert-circle' : msg.tone === 'info' ? 'information-circle' : 'checkmark-circle'}
              size={18}
              color={c}
            />
            <Text style={styles.text} numberOfLines={2}>
              {msg.text}
            </Text>
          </Animated.View>
        </View>
      ) : null}
    </Ctx.Provider>
  );
}

export const useToast = (): ToastApi => useContext(Ctx);

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 16 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: 560,
    backgroundColor: '#1d2547',
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  text: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
});
