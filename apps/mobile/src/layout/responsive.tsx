/**
 * Responsive layout primitives for the wide (desktop web) board.
 *
 * Phones keep the single scrolling column exactly as it was: every screen renders its existing tree when
 * `useWide()` is false and only switches to a `<Grid>` board at >= 1024 px.
 *
 * `Grid` is a 12-column board. On web it is a real CSS grid (so `Col` can span rows); on native (tablet landscape)
 * it falls back to a wrapping flex row with percentage widths and ignores `rowSpan`.
 */
import type { ReactNode } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';

export const WIDE_BREAKPOINT = 1024;
export const BOARD_MAX_WIDTH = 1440;
export const BOARD_GAP = 16;
export const GRID_COLUMNS = 12;

/** True when the window is >= 1024 px wide (updates on resize / rotation). */
export function useWide(): boolean {
  const { width } = useWindowDimensions();
  return width >= WIDE_BREAKPOINT;
}

/** Style props React Native's types do not know but react-native-web passes to CSS. */
const web = (style: Record<string, unknown>): ViewStyle => style as unknown as ViewStyle;
const isWeb = Platform.OS === 'web';

export interface GridProps {
  children: ReactNode;
  /** Gap between cells in px (default 16). */
  gap?: number;
  /** Max width of the board (default 1440), centred. */
  maxWidth?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** 12-column board, `width: 100%` up to `maxWidth`, centred. Place children with `<Col>`. */
export function Grid({ children, gap = BOARD_GAP, maxWidth = BOARD_MAX_WIDTH, style, testID }: GridProps) {
  if (isWeb) {
    return (
      <View
        testID={testID}
        style={[
          styles.board,
          { maxWidth },
          web({ display: 'grid', gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`, gap }),
          style,
        ]}
      >
        {children}
      </View>
    );
  }
  return (
    <View
      testID={testID}
      style={[styles.board, styles.nativeRow, { maxWidth, marginHorizontal: -gap / 2 }, style]}
      // Cells carry gap/2 padding (see Col), so the row is widened by the same amount.
      collapsable={false}
    >
      {children}
    </View>
  );
}

export interface ColProps {
  children?: ReactNode;
  /** Columns to span, 1..12. */
  span: number;
  /** 1-based first column. Omit for auto-placement. */
  start?: number;
  /** 1-based grid row to start in. Omit for auto-placement. */
  row?: number;
  /** Rows to span (web only). */
  rowSpan?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * One cell of the board. It is a plain View with `minWidth: 0`; make its child a `Card` with `flex: 1` /
 * `alignSelf: 'stretch'` when it should fill the cell height (grid items stretch by default on web).
 */
export function Col({ children, span, start, row, rowSpan, style, testID }: ColProps) {
  const n = Math.min(GRID_COLUMNS, Math.max(1, Math.round(span)));
  if (isWeb) {
    const placement: Record<string, unknown> = {
      gridColumn: start ? `${start} / span ${n}` : `span ${n}`,
    };
    if (row || rowSpan) placement.gridRow = `${row ?? 'auto'} / span ${rowSpan ?? 1}`;
    return (
      <View testID={testID} style={[styles.cell, web(placement), style]}>
        {children}
      </View>
    );
  }
  return (
    <View
      testID={testID}
      style={[styles.cell, { width: `${(n / GRID_COLUMNS) * 100}%`, padding: BOARD_GAP / 2 }, style]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  board: { width: '100%', alignSelf: 'center' },
  nativeRow: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { minWidth: 0 },
});
