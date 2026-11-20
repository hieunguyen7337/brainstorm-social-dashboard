import { useState, type ReactNode } from 'react';
import { Platform, View, useWindowDimensions, type ViewStyle } from 'react-native';

import { Col, Grid } from '@/src/layout';
import { space } from '@/src/theme';

/** Style props React Native's types do not know but react-native-web passes to CSS. */
const web = (style: Record<string, unknown>): ViewStyle => style as unknown as ViewStyle;

/** Keeps the form in view while a long result scrolls past (web only; see `CreateBoard`). */
const STICKY: ViewStyle = Platform.OS === 'web' ? web({ position: 'sticky', top: space.lg, alignSelf: 'flex-start' }) : {};

/**
 * The wide (>= 1024 px) Create screen: the form in columns 1-5, the generated result in columns 6-12 of the 12-column
 * board. Layout only: the screen builds both panes.
 */
export function CreateBoard({ form, result }: { form: ReactNode; result: ReactNode }) {
  const { height: windowH } = useWindowDimensions();
  const [formH, setFormH] = useState(0);
  // The form is pinned while a long result scrolls past, but only when it fits the window: a taller form (a short
  // window, an open trend list) would otherwise leave its Generate button out of reach until the end of the page.
  const sticky = formH > 0 && formH <= windowH - 3 * space.lg;
  return (
    <Grid>
      <Col span={5} start={1} row={1} style={sticky ? STICKY : undefined}>
        <View onLayout={(e) => setFormH(e.nativeEvent.layout.height)}>{form}</View>
      </Col>
      <Col span={7} start={6} row={1}>
        {result}
      </Col>
    </Grid>
  );
}
