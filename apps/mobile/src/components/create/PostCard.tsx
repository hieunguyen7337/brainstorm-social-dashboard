import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, platformMeta, space } from '@/src/theme';
import { Card, PlatformBadge } from '@/src/ui';

import { PostActions, type PostActionsProps } from './PostActions';
import { PostPage, type PostPageProps } from './PostPage';

/** Card width from which Publish / Schedule / Copy link / Discard fit on one row. */
const ONE_ROW_ACTIONS = 440;

export interface PostCardProps {
  page: PostPageProps;
  actions: Omit<PostActionsProps, 'wide'>;
}

/**
 * One generated post on the wide board: platform label, the platform-native preview (editable while it is a draft) and
 * its own Publish / Schedule / Save actions, in a single card. The actions sit at the card's foot so a row of cards
 * lines up even when the previews differ in height.
 */
export function PostCard({ page, actions }: PostCardProps) {
  const [width, setWidth] = useState(0);
  const label = platformMeta[page.post.platform].label;
  return (
    <Card style={styles.card}>
      <View style={styles.body} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <View style={styles.head}>
          <PlatformBadge platform={page.post.platform} size={28} />
          <Text style={styles.title} numberOfLines={1}>
            {`${label} post`}
          </Text>
        </View>
        <PostPage {...page} />
        <View style={styles.spacer} />
        <PostActions {...actions} wide={width >= ONE_ROW_ACTIONS} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: 0 },
  body: { flex: 1, gap: space.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '700', color: colors.textDim },
  spacer: { flex: 1 },
});
