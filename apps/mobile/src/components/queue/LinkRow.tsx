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
export function LinkRow({
  url,
  onCopy,
  onOpen,
  compact = false,
}: {
  url: string;
  onCopy: () => void;
  onOpen: () => void;
  /** A narrow kanban column: the copy / Open buttons drop under the link instead of squeezing it. */
  compact?: boolean;
}) {
  // Shorten from the host side to however many characters fit (the code at the end is what people recognise).
  const [chars, setChars] = useState(22);
  const copy = <IconButton icon="copy-outline" size={18} label="Copy tracked link" onPress={onCopy} />;
  const open = (
    <Button
      title="Open"
      icon="open-outline"
      variant="secondary"
      small
      onPress={onOpen}
      accessibilityLabel="Open tracked link"
    />
  );
  return (
    <View style={[styles.box, compact && styles.boxCompact]}>
      <Ionicons name="link" size={15} color={colors.accent} />
      <View
        style={[styles.urlWrap, compact && styles.urlWrapCompact]}
        onLayout={(e) => setChars(Math.max(10, Math.floor(e.nativeEvent.layout.width / CHAR_W)))}
      >
        <Text style={styles.url} numberOfLines={1}>
          {shortLink(url, chars)}
        </Text>
      </View>
      {compact ? (
        <View style={styles.buttons}>
          {copy}
          {open}
        </View>
      ) : (
        <>
          {copy}
          {open}
        </>
      )}
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
  boxCompact: { flexWrap: 'wrap', rowGap: 4 },
  urlWrap: { flex: 1, minWidth: 0 },
  // Wraps below ~150 px of room: the buttons then sit on their own line, right-aligned.
  urlWrapCompact: { flexGrow: 1, flexShrink: 1, flexBasis: 150 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  url: { fontFamily: MONO, fontSize: URL_SIZE, color: colors.textDim },
});
