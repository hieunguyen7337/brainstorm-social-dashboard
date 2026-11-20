import { StyleSheet } from 'react-native';

import type { Trend } from '@/src/api';
import { Col, Grid } from '@/src/layout';
import { SourceHeader } from './SourceBadge';
import { TrendCard } from './TrendCard';
import type { TrendGroup } from './trendUtils';

export interface TrendGridProps {
  /** The visible groups (every non-empty source for "All", else just the chosen one), as the phone list shows them. */
  sections: { group: TrendGroup; start: number }[];
  /** Staggered entrance delay for card n of the whole list; null when the intro has already played. */
  enterDelay: (index: number) => number | null;
  /** Whether card n eases its bars in. */
  animateBars: (index: number) => boolean;
  onCreate: (trend: Trend) => void;
  onOpen: (trend: Trend) => void;
}

/**
 * Wide Trends: each source's header (full width) followed by its trends as cards, three per row (4 of 12 columns
 * each, auto-placed). Same grouping and order as the phone list.
 */
export function TrendGrid({ sections, enterDelay, animateBars, onCreate, onOpen }: TrendGridProps) {
  return (
    <Grid testID="trends-grid">
      {sections.flatMap(({ group, start }) => [
        <Col key={`${group.source}-header`} span={12} style={styles.header}>
          <SourceHeader source={group.source} count={group.items.length} />
        </Col>,
        ...group.items.map((trend, i) => (
          <Col key={trend.id} span={4}>
            <TrendCard
              trend={trend}
              rank={i + 1}
              enterDelay={enterDelay(start + i)}
              animateBars={animateBars(start + i)}
              onCreate={onCreate}
              onOpen={onOpen}
            />
          </Col>
        )),
      ])}
    </Grid>
  );
}

const styles = StyleSheet.create({
  // A little extra air above each source header on top of the grid gap.
  header: { marginTop: 8 },
});
