import type { Ref } from 'react';
import { StyleSheet, View } from 'react-native';

import { ConnectAccounts, type ConnectAccountsHandle } from '@/src/components/connect/ConnectAccounts';
import { space } from '@/src/theme';
import { SectionHeader } from '@/src/ui';

/**
 * Settings > Accounts (real workspaces): the same "Upload a screenshot / Type numbers" cards as onboarding and the connect
 * sheet. `ConnectAccounts` renders no header and no scroll view of its own, so the title lives here and the screen scrolls.
 * Old sample workspaces keep `ConnectorsSection` instead.
 */
export function AccountsSection({ handleRef }: { handleRef?: Ref<ConnectAccountsHandle> }) {
  return (
    <View style={styles.section}>
      <SectionHeader title="Accounts" subtitle="Your real numbers, from a screenshot or typed in." />
      <ConnectAccounts handleRef={handleRef} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
});
