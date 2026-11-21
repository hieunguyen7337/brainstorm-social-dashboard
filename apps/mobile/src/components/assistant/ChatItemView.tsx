/** One line of the assistant chat (user bubble, Claude text, tool call, tool error, result). Shared by the desktop and phone Assistants. */
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type as t } from '@/src/theme';
import type { ChatItem } from './events';

export function ChatItemView({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <View style={[styles.bubble, styles.user]}>
        <Text style={t.body} selectable>
          {item.text}
        </Text>
      </View>
    );
  }
  if (item.kind === 'text') {
    return (
      <Text style={t.body} selectable>
        {item.text}
      </Text>
    );
  }
  if (item.kind === 'tool') return <Text style={[t.small, styles.tool]}>{item.text}</Text>;
  if (item.kind === 'stderr') return <Text style={[t.mono, styles.stderr]}>{item.text}</Text>;
  return <Text style={[t.small, styles.result]}>{item.text}</Text>;
}

const styles = StyleSheet.create({
  bubble: { padding: space.md, borderRadius: radius.sm, alignSelf: 'flex-end', maxWidth: '85%' },
  user: { backgroundColor: colors.cardHi },
  tool: { color: colors.info },
  stderr: { color: colors.danger },
  result: { color: colors.textMute, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: space.xs },
});
