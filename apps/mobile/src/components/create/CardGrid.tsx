import { Children, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { space } from '@/src/theme';

export interface CardGridProps {
  children: ReactNode;
  /** Narrowest a card may get; the grid fits as many equal columns as that allows (2 on the wide board, 1 when squeezed). */
  minCardWidth?: number;
  gap?: number;
  style?: StyleProp<ViewStyle>;
}

/** Columns that fit `width` px with `gap` between them, at least 1. */
export function columnsFor(width: number, minCardWidth: number, gap: number): number {
  if (width <= 0) return 2;
  return Math.max(1, Math.floor((width + gap) / (minCardWidth + gap)));
}

/**
 * Equal-width card columns for the wide Create board (2 when there is room for two cards of `minCardWidth`, 1 when the
 * pane is squeezed). Cards are dealt out to the columns in turn (1st left, 2nd right, 3rd left, ...) and each column
 * stacks its cards at their own height, so a short X card never leaves a hole next to a tall TikTok card. The children
 * are the cards themselves; they fill their column's width.
 */
export function CardGrid({ children, minCardWidth = 280, gap = space.lg, style }: CardGridProps) {
  const [width, setWidth] = useState(0);
  const cards = Children.toArray(children);
  const count = columnsFor(width, minCardWidth, gap);
  const columns: ReactNode[][] = Array.from({ length: count }, () => []);
  cards.forEach((card, i) => columns[i % count].push(card));

  return (
    <View
      style={[styles.row, { gap }, style]}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
      }}
    >
      {columns.map((column, i) => (
        <View key={i} style={[styles.column, { gap }]}>
          {column}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { width: '100%', flexDirection: 'row', alignItems: 'flex-start' },
  column: { flex: 1, minWidth: 0 },
});
