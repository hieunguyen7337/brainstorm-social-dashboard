import { StyleSheet, View } from 'react-native';

import { space } from '@/src/theme';
import { Card, Skeleton } from '@/src/ui';

/** Placeholder shaped like a post card (header, three text lines, link row, buttons). */
export function PostCardSkeleton() {
  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <Skeleton width={36} height={36} rounded={18} />
        <View style={styles.titles}>
          <Skeleton width="38%" height={14} />
          <Skeleton width="52%" height={11} />
        </View>
        <Skeleton width={74} height={22} rounded={11} />
      </View>
      <View style={styles.lines}>
        <Skeleton height={13} />
        <Skeleton height={13} />
        <Skeleton width="70%" height={13} />
      </View>
      <Skeleton height={52} rounded={12} />
      <View style={styles.row}>
        <Skeleton width={104} height={36} rounded={12} />
        <Skeleton width={84} height={36} rounded={12} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  titles: { flex: 1, gap: 6 },
  lines: { gap: space.sm },
});
