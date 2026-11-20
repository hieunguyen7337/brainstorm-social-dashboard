import { useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet, View, type DimensionValue } from 'react-native';

import { Col, Grid } from '@/src/layout';
import { colors, radius, space } from '@/src/theme';

const Block = ({ w, h, r = 8 }: { w: DimensionValue; h: number; r?: number }) => (
  <View style={{ width: w, height: h, borderRadius: r, backgroundColor: colors.cardHi }} />
);

function RowSkeleton({ titleLines }: { titleLines: 1 | 2 | 3 }) {
  return (
    <View style={styles.row}>
      <Block w={26} h={26} r={13} />
      <View style={styles.rowBody}>
        <Block w="94%" h={14} />
        {titleLines > 1 ? <Block w="78%" h={14} /> : null}
        {titleLines > 2 ? <Block w="52%" h={14} /> : null}
        <View style={styles.barRow}>
          <View style={styles.barFill}>
            <Block w="100%" h={8} r={4} />
          </View>
          <Block w={64} h={10} />
        </View>
        <View style={styles.metaRow}>
          <Block w={20} h={20} r={10} />
          <Block w="38%" h={10} />
        </View>
      </View>
    </View>
  );
}

/** Placeholder shaped like a card of the wide grid: source line, title, meters, button. */
function CardSkeleton({ titleLines }: { titleLines: 2 | 3 }) {
  return (
    <View style={styles.card}>
      <View style={styles.metaRow}>
        <Block w={26} h={26} r={13} />
        <Block w={20} h={20} r={10} />
        <Block w="40%" h={10} />
      </View>
      <View style={styles.cardTitle}>
        <Block w="94%" h={14} />
        <Block w="80%" h={14} />
        {titleLines > 2 ? <Block w="55%" h={14} /> : null}
      </View>
      <Block w="100%" h={8} r={4} />
      <Block w="100%" h={36} r={12} />
    </View>
  );
}

/**
 * Loading placeholder shaped like the real screen: filter chips, a group header and a few trend rows (`wide`: a
 * 3-column grid of cards). One shared pulse drives every block (a single animation instead of one per block).
 */
export function TrendsSkeleton({ wide = false }: { wide?: boolean }) {
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const native = Platform.OS !== 'web';
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: native }),
        Animated.timing(pulse, { toValue: 0.55, duration: 800, useNativeDriver: native }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View style={[styles.wrap, { opacity: pulse }]} aria-hidden>
      <View style={styles.chips}>
        <Block w={64} h={36} r={18} />
        <Block w={116} h={36} r={18} />
        <Block w={92} h={36} r={18} />
      </View>
      <View style={styles.group}>
        <View style={styles.header}>
          <Block w={32} h={32} r={16} />
          <Block w={140} h={16} />
        </View>
        {wide ? (
          <Grid>
            {([2, 3, 2, 3, 2, 3] as const).map((lines, i) => (
              <Col key={i} span={4}>
                <CardSkeleton titleLines={lines} />
              </Col>
            ))}
          </Grid>
        ) : (
          <>
            <RowSkeleton titleLines={2} />
            <RowSkeleton titleLines={3} />
            <RowSkeleton titleLines={2} />
          </>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.lg },
  chips: { flexDirection: 'row', gap: 8 },
  group: { gap: space.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    padding: space.lg,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  card: {
    flex: 1,
    gap: space.md,
    padding: space.lg,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { gap: 8 },
  rowBody: { flex: 1, gap: 10 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 460 },
  barFill: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
