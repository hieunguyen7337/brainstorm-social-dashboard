import { useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { androidDownloadUrl, androidQrUrl, installPageUrl } from '@/src/http';
import { colors, radius, space, type as t } from '@/src/theme';
import { Button, Card, SectionHeader, copyText, useToast } from '@/src/ui';

/** Open a public page in the system browser. On web `window.open` must run synchronously inside the click. */
function openUrl(url: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener');
    return;
  }
  Linking.openURL(url).catch(() => undefined);
}

/** "Share Pulse": the public Android install QR, drawn in-app, with a button for the big-screen page. */
export function InstallQr({ compact }: { compact?: boolean }) {
  const toast = useToast();
  const [xml, setXml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const size = compact ? 132 : 164;

  useEffect(() => {
    let alive = true;
    setFailed(false);
    fetch(androidQrUrl())
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => alive && setXml(text))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const link = androidDownloadUrl();
  const copy = async () => {
    const ok = await copyText(link);
    toast.show(ok ? 'Link copied' : 'Could not copy');
  };

  return (
    <Card>
      <SectionHeader title="Share Pulse" subtitle="Friends scan this to install Pulse on Android" />
      <View style={styles.row}>
        <View style={[styles.qr, { width: size, height: size }]}>
          {xml ? <SvgXml xml={xml} width="100%" height="100%" /> : null}
        </View>
        <View style={styles.side}>
          {failed ? (
            <>
              <Text style={t.small}>Could not load the QR. Share this link instead:</Text>
              <Text selectable style={t.mono}>{link}</Text>
              <Button title="Copy" small variant="secondary" onPress={copy} />
              <Button title="Retry" small variant="secondary" onPress={() => setAttempt((n) => n + 1)} />
            </>
          ) : (
            <Button title="Show big" small onPress={() => openUrl(installPageUrl())} />
          )}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md, alignItems: 'center', flexWrap: 'wrap' },
  qr: { backgroundColor: '#fff', borderRadius: radius.md, padding: 6 },
  side: { flex: 1, minWidth: 140, gap: space.sm },
});
