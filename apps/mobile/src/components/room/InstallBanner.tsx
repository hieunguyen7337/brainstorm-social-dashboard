import { useMemo } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { androidDownloadUrl } from '@/src/api';
import { APP_NAME } from '@/src/config';
import { colors, radius, space, withAlpha } from '@/src/theme';
import { BannerClose } from './RoomWelcome';
import { useInstallDismissed } from './roomStore';

export type InstallKind = 'android' | 'ios';

/** True when the web app already runs as an installed home-screen app (no point showing install hints). */
export function isStandaloneWebApp(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true;
    return standalone || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** Browsers on iOS that cannot "Add to Home Screen" from a Share sheet (Firefox, in-app browsers of social apps). */
const IOS_NO_INSTALL = /FxiOS|FBAN|FBAV|Instagram|LinkedInApp|Line\/|MicroMessenger|Snapchat|Twitter/i;

/** Which install hint fits this browser: the Android download, the iOS home-screen steps, or none (desktop, installed). */
export function detectInstallKind(): InstallKind | null {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return null;
  try {
    if (isStandaloneWebApp()) return null;
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'android';
    // iPadOS 13+ Safari reports a Mac user agent, but has a touch screen.
    const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
    if (ios && !IOS_NO_INSTALL.test(ua)) return 'ios';
  } catch {
    // unknown browser: show nothing
  }
  return null;
}

/** The install hint to show, or null (native app, desktop browser, already installed or dismissed). */
export function useInstallBanner(): { kind: InstallKind | null; dismiss: () => void } {
  const { ready, dismissed, dismiss } = useInstallDismissed();
  const kind = useMemo(detectInstallKind, []);
  return { kind: ready && !dismissed ? kind : null, dismiss };
}

/** Web only: slim, dismissible install tip. Never a modal and never over the content. */
export function InstallBanner() {
  const { kind, dismiss } = useInstallBanner();
  if (!kind) return null;
  return <InstallBar kind={kind} onDismiss={dismiss} />;
}

/** One line, two spaces between the steps, exactly as the room flow words it. */
const IOS_STEPS = '1. Tap Share  2. Tap Add to Home Screen';

/** iOS Share glyph (box with an arrow out of the top), drawn as SVG so the banner's text stays just its words. */
const ShareGlyph = ({ color, size = 18 }: { color: string; size?: number }) => (
  <Svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    accessibilityElementsHidden
    importantForAccessibility="no"
  >
    <Path d="M8.5 10H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1.5M12 15V3M8.5 6.5L12 3l3.5 3.5" />
  </Svg>
);

const AndroidGlyph = ({ color, size = 18 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14" />
  </Svg>
);

export function InstallBar({ kind, onDismiss }: { kind: InstallKind; onDismiss: () => void }) {
  // A real anchor (react-native-web renders `href` on Text as <a>) so the browser starts the download in this tab.
  const link = { href: androidDownloadUrl(), role: 'link' } as object;
  return (
    <View testID="install-banner" style={styles.bar}>
      <View style={styles.icon}>{kind === 'android' ? <AndroidGlyph color={colors.info} /> : <ShareGlyph color={colors.info} />}</View>

      {kind === 'android' ? (
        <>
          <View style={styles.body}>
            <Text style={styles.title} numberOfLines={2}>{`Install ${APP_NAME}`}</Text>
          </View>
          <Text {...link} style={styles.cta}>
            Get the app
          </Text>
        </>
      ) : (
        <View style={styles.body}>
          <Text style={styles.title}>{`Install ${APP_NAME}`}</Text>
          <Text style={styles.step}>{IOS_STEPS}</Text>
        </View>
      )}

      <BannerClose label="Close install tip" onPress={onDismiss} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 8,
    paddingLeft: space.md,
    paddingRight: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: withAlpha(colors.info, 0.4),
    backgroundColor: withAlpha(colors.info, 0.1),
  },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.info, 0.16),
  },
  body: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: colors.text, fontSize: 14, lineHeight: 19, fontWeight: '600' },
  step: { color: colors.textDim, fontSize: 12.5, lineHeight: 17, fontWeight: '600' },
  cta: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: 14,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.accent,
    color: colors.white,
    fontSize: 13.5,
    fontWeight: '700',
    textDecorationLine: 'none',
  },
});
