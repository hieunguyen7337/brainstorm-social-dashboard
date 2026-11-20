import type { MutableRefObject } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, platformMeta, radius, space, withAlpha } from '@/src/theme';
import type { Connection, Platform } from '@/src/types';
import { EmptyState, PlatformBadge } from '@/src/ui';

import { GeneratingState } from './GeneratingState';
import type { Batch } from './logic';
import { ResultGrid } from './ResultGrid';

/** Before anything is generated: where the posts will land, and which platforms are lined up. */
function ResultPlaceholder({ platforms }: { platforms: readonly Platform[] }) {
  return (
    <View style={styles.placeholder}>
      <EmptyState
        icon="sparkles-outline"
        title="Your posts will appear here"
        message="Pick your platforms, add a brief if you like, and press Generate. Each platform gets its own native post."
      />
      {platforms.length > 0 ? (
        <View style={styles.lineup} accessibilityLabel={`Lined up: ${platforms.map((p) => platformMeta[p].label).join(', ')}`}>
          {platforms.map((p) => (
            <PlatformBadge key={p} platform={p} size={34} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export interface ResultPaneProps {
  /** The finished batch, or null while the form is being filled in / Claude writes. */
  batch: Batch | null;
  generating: boolean;
  platforms: readonly Platform[];
  hasTrend: boolean;
  themeName?: string | null;
  connections: Connection[] | undefined;
  brandName: string;
  onBack: () => void;
  unsavedRef?: MutableRefObject<boolean>;
}

/** The right-hand side of the wide board: placeholder, the generating skeletons, or the generated post cards. */
export function ResultPane({
  batch,
  generating,
  platforms,
  hasTrend,
  themeName,
  connections,
  brandName,
  onBack,
  unsavedRef,
}: ResultPaneProps) {
  if (generating) {
    return <GeneratingState layout="grid" platforms={platforms} hasTrend={hasTrend} themeName={themeName} />;
  }
  if (batch) {
    return (
      <ResultGrid
        key={batch.id}
        batch={batch}
        connections={connections}
        brandName={brandName}
        onBack={onBack}
        unsavedRef={unsavedRef}
      />
    );
  }
  return <ResultPlaceholder platforms={platforms} />;
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    minHeight: 360,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    padding: space.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderHi,
    backgroundColor: withAlpha(colors.card, 0.5),
  },
  lineup: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm },
});
