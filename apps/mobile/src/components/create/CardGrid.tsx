import { Children, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { space } from '@/src/theme';

/** Style props React Native's types do not know but react-native-web passes to CSS. */
const web = (style: Record<string, unknown>): ViewStyle => style as unknown as ViewStyle;

export interface CardGridProps {
  children: ReactNode;
  /** Narrowest a card may get; the grid fits as many equal columns as that allows (2 on the wide board, 1 when squeezed). */
  minCardWidth?: number;
  gap?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Equal-width card columns for the wide Create board. On web it is a CSS grid (`auto-fill` columns, rows stretch to the
 * tallest card); on native (tablet landscape) it is a wrapping flex row. The children are the cards themselves: give
 * each `flex: 1` when it should fill its cell.
 */
export function CardGrid({ children, minCardWidth = 280, gap = space.lg, style }: CardGridProps) {
  if (Platform.OS === 'web') {
    return (
      <View
        style={[
          { width: '100%' },
          web({ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${minCardWidth}px), 1fr))`, gap }),
          style,
        ]}
      >
        {children}
      </View>
    );
  }
  return (
    <View style={[styles.row, { gap }, style]}>
      {Children.map(children, (child) =>
        child ? <View style={{ flexBasis: minCardWidth, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{child}</View> : null,
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { width: '100%', flexDirection: 'row', flexWrap: 'wrap' },
});
