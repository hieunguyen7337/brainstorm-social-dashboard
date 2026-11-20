import type { ReactNode } from 'react';
import { Platform, type ViewStyle } from 'react-native';

import { Col, Grid } from '@/src/layout';
import { space } from '@/src/theme';

/** Style props React Native's types do not know but react-native-web passes to CSS. */
const web = (style: Record<string, unknown>): ViewStyle => style as unknown as ViewStyle;

/** Keeps the form in view while a long result scrolls past (web only). */
const STICKY: ViewStyle = Platform.OS === 'web' ? web({ position: 'sticky', top: space.lg, alignSelf: 'flex-start' }) : {};

/**
 * The wide (>= 1024 px) Create screen: the form in columns 1-5, the generated result in columns 6-12 of the 12-column
 * board. Layout only: the screen builds both panes.
 */
export function CreateBoard({
  form,
  result,
  stickyForm = true,
}: {
  form: ReactNode;
  result: ReactNode;
  /** Pin the form while the page scrolls. Turn off when the form can outgrow the window (an open trend list). */
  stickyForm?: boolean;
}) {
  return (
    <Grid>
      <Col span={5} start={1} row={1} style={stickyForm ? STICKY : undefined}>
        {form}
      </Col>
      <Col span={7} start={6} row={1}>
        {result}
      </Col>
    </Grid>
  );
}
