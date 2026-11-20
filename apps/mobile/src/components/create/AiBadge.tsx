import { View } from 'react-native';

import { Badge } from '@/src/ui';

/**
 * Who wrote this batch. When Claude was busy the API fell back to its templates: that is information, not a failure,
 * so it is a calm blue chip (never the danger tone, never an error state) with the one sentence people should read.
 */
export function AiBadge({ aiUsed }: { aiUsed: boolean }) {
  if (aiUsed) return <Badge label="Written by Claude" tone="accent" icon="sparkles" />;
  return (
    <View testID="ai-busy" style={{ maxWidth: '100%' }}>
      <Badge label="AI busy, using a template" tone="info" icon="information-circle-outline" style={{ maxWidth: '100%' }} />
    </View>
  );
}
