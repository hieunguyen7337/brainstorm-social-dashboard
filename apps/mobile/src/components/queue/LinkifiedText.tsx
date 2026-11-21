import { Linking, Text, type StyleProp, type TextStyle } from 'react-native';

import { colors } from '@/src/theme';
import { splitLinks } from './linkify';

/** Text whose http(s) URLs are tappable links (opens the browser). Everything else renders as before. */
export function LinkifiedText({
  children,
  style,
  selectable,
  onPressUrl,
}: {
  children: string;
  style?: StyleProp<TextStyle>;
  selectable?: boolean;
  /** Override how a URL opens (default: Linking.openURL). */
  onPressUrl?: (url: string) => void;
}) {
  const open = (url: string) => {
    if (onPressUrl) onPressUrl(url);
    else void Linking.openURL(url).catch(() => undefined);
  };
  return (
    <Text style={style} selectable={selectable}>
      {splitLinks(children).map((p, i) =>
        p.url ? (
          <Text
            key={i}
            accessibilityRole="link"
            style={{ color: colors.accent, textDecorationLine: 'underline' }}
            onPress={() => open(p.url as string)}
          >
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}
