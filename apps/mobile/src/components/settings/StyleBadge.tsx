import { StyleSheet } from 'react-native';

import { useSession } from '@/src/session';
import { Badge } from '@/src/ui';

/** "Writing in your style": shown on the Generate screens once the person's writing style has been learned. */
export function StyleBadge() {
  const { workspace } = useSession();
  if (!workspace?.writing_style) return null;
  return <Badge label="Writing in your style" tone="accent" icon="sparkles" style={styles.badge} />;
}

const styles = StyleSheet.create({
  badge: { alignSelf: 'flex-start' },
});
