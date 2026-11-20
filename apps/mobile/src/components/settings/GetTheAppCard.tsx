import Ionicons from '@expo/vector-icons/Ionicons';
import { Fragment, useMemo, type ComponentProps, type ReactNode } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { androidDownloadUrl } from '@/src/api';
import { APP_NAME } from '@/src/config';
import { colors, space, type as t, withAlpha } from '@/src/theme';
import { Button, Card, SectionHeader, useToast } from '@/src/ui';

type IconName = ComponentProps<typeof Ionicons>['name'];

interface Step {
  icon: IconName;
  label: string;
}

/** True when the web app is already running as an installed home-screen app (no point showing install hints). */
function isInstalledWebApp(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true;
    return standalone || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** "Get the app": the Android download (everywhere) plus, on the web only, how to install the PWA on a phone. */
export function GetTheAppCard() {
  const toast = useToast();
  const showWebHints = useMemo(() => Platform.OS === 'web' && !isInstalledWebApp(), []);

  // `window.open` must run synchronously inside the tap, or browsers treat it as a blocked popup.
  const openDownload = () => {
    const url = androidDownloadUrl();
    try {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
      } else {
        Linking.openURL(url).catch(() => toast.show("Couldn't open the download link.", 'error'));
      }
    } catch {
      toast.show("Couldn't open the download link.", 'error');
    }
  };

  return (
    <View style={styles.section}>
      <SectionHeader title="Get the app" subtitle="Keep your dashboard one tap away on your phone." />

      <Card style={styles.card}>
        <View style={styles.head}>
          <Art name="logo-android" tint={colors.success} />
          <View style={styles.headText}>
            <Text style={t.h3}>Android app</Text>
            <Text style={t.dim}>
              {`Install ${APP_NAME} on your Android phone. Open the downloaded file and allow the install if asked.`}
            </Text>
          </View>
        </View>
        <Button title="Get the Android app" icon="download-outline" onPress={openDownload} full />
      </Card>

      {showWebHints ? (
        <>
          <HintCard
            art={<Art name="phone-portrait-outline" badge="add-circle" tint={colors.accent} />}
            title="Add to iPhone home screen"
            text="Open this page in Safari, tap Share, then choose Add to Home Screen."
            steps={[
              { icon: 'compass-outline', label: 'Open in Safari' },
              { icon: 'share-outline', label: 'Tap Share' },
              { icon: 'add-circle-outline', label: 'Add to Home Screen' },
            ]}
          />
          <HintCard
            art={<Art name="logo-chrome" badge="download" tint={colors.info} />}
            title="Install app"
            text="On Android in Chrome, open the menu, then tap Install app."
            steps={[
              { icon: 'ellipsis-vertical', label: 'Menu' },
              { icon: 'download-outline', label: 'Install app' },
            ]}
          />
        </>
      ) : null}
    </View>
  );
}

/** Rounded tile with a big glyph and an optional small badge in the corner. */
function Art({ name, badge, tint }: { name: IconName; badge?: IconName; tint: string }) {
  return (
    <View style={[styles.art, { backgroundColor: withAlpha(tint, 0.14) }]}>
      <Ionicons name={name} size={28} color={tint} />
      {badge ? (
        <View style={styles.artBadge}>
          <Ionicons name={badge} size={18} color={colors.success} />
        </View>
      ) : null}
    </View>
  );
}

function HintCard({ art, title, text, steps }: { art: ReactNode; title: string; text: string; steps: Step[] }) {
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        {art}
        <View style={styles.headText}>
          <Text style={t.h3}>{title}</Text>
          <Text style={t.dim}>{text}</Text>
        </View>
      </View>
      <View style={styles.steps} accessible accessibilityLabel={steps.map((s) => s.label).join(', then ')}>
        {steps.map((s, i) => (
          <Fragment key={s.label}>
            {i > 0 ? <Ionicons name="chevron-forward" size={16} color={colors.textMute} style={styles.chevron} /> : null}
            <View style={styles.step}>
              <View style={styles.tile}>
                <Ionicons name={s.icon} size={22} color={colors.text} />
              </View>
              <Text style={styles.stepLabel} numberOfLines={2}>
                {s.label}
              </Text>
            </View>
          </Fragment>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  card: { gap: space.lg },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  art: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  artBadge: {
    position: 'absolute',
    right: -5,
    bottom: -5,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  steps: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: space.xs,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    borderRadius: 12,
    backgroundColor: colors.bg,
  },
  step: { width: 84, alignItems: 'center', gap: 6 },
  tile: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cardHi,
    borderWidth: 1,
    borderColor: colors.borderHi,
  },
  stepLabel: { fontSize: 11.5, lineHeight: 15, fontWeight: '600', textAlign: 'center', color: colors.textDim },
  chevron: { marginTop: 15 },
});
