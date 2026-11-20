import { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Post } from '@/src/api';
import { PostPreview } from '@/src/components/previews';
import { space, type as t } from '@/src/theme';
import { handleFromBrand, type Account } from './queueModel';

/** The platform-native card is another unit's code: if it ever throws, the Queue must keep working. */
class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <Text style={t.small}>Preview unavailable.</Text> : this.props.children;
  }
}

/** Optional "Preview" expansion of a queue card: the post as it would look on its platform. */
export function PreviewBlock({
  post,
  brandName,
  account,
  timeLabel,
}: {
  post: Post;
  brandName: string;
  account?: Account;
  timeLabel: string;
}) {
  const handle = account?.handle
    ? account.handle.startsWith('@')
      ? account.handle
      : `@${account.handle}`
    : handleFromBrand(brandName);
  const published = post.status === 'published';

  return (
    <View style={styles.wrap}>
      <PreviewBoundary>
        <PostPreview
          platform={post.platform}
          content={post.content}
          hashtags={post.hashtags ?? []}
          mediaPrompt={post.media_prompt ?? ''}
          brandName={brandName}
          handle={handle}
          followers={account?.followers}
          link={post.link_url}
          timeLabel={timeLabel}
          stats={
            published
              ? { views: post.views, engagements: post.engagements, clicks: post.clicks, conversions: post.conversions }
              : null
          }
        />
      </PreviewBoundary>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: space.xs },
});
