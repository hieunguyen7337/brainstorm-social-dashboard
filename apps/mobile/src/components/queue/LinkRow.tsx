import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/src/theme';
import { Button, IconButton } from '@/src/ui';
import { shortLink } from './queueModel';

const MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
});
const URL_SIZE = 12;
/** Monospace advance is ~0.6em; keep a little headroom so the last character never gets clipped. */
const CHAR_W = URL_SIZE * 0.62;

/**
 * The tracked link of a post: short monospace URL, a copy button and an "Open" button. "Open" goes through
 * `openTrackedLink`, so the click lands in the funnel like a real visitor's.
 */
export function LinkRow({ url, onCopy, onOpen }: { url: string; onCopy: () => void; onOpen: () => void }) {
  // Shorten from the host side to however many characters fit (the code at the end is what people recognise).
  const [chars, setChars] = useState(22);
  return (
    <View style={styles.box}>
      <Ionicons name="link" size={15} color={colors.accent} />
      <View
        style={styles.urlWrap}
        onLayout={(e) => setChars(Math.max(10, Math.floor(e.nativeEvent.layout.width / CHAR_W)))}
      >
        <Text style={styles.url} numberOfLines={1}>
          {shortLink(url, chars)}
        </Text>
      </View>
      <IconButton icon="copy-outline" size={18} label="Copy tracked link" onPress={onCopy} />
      <Button
        title="Open"
        icon="open-outline"
        variant="secondary"
        small
        onPress={onOpen}
        accessibilityLabel="Open tracked link"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 6,
  },
  urlWrap: { flex: 1, minWidth: 0 },
  url: { fontFamily: MONO, fontSize: URL_SIZE, color: colors.textDim },
});
