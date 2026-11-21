import type { Ref } from 'react';
import { StyleSheet, View } from 'react-native';

import { ConnectAccounts, type ConnectAccountsHandle } from '@/src/components/connect/ConnectAccounts';
import { useIsDemoWorkspace } from '@/src/session';
import { space } from '@/src/theme';
import { SectionHeader } from '@/src/ui';

/**
 * Settings > Accounts (real workspaces): the same "Upload a screenshot" cards as onboarding and the connect
 * sheet. `ConnectAccounts` renders no header and no scroll view of its own, so the title lives here and the screen scrolls.
 * Old sample workspaces keep `ConnectorsSection` instead.
 */
export function AccountsSection({ handleRef }: { handleRef?: Ref<ConnectAccountsHandle> }) {
  const demo = useIsDemoWorkspace();
  return (
    <View style={styles.section}>
      <SectionHeader
        title="Accounts"
        subtitle={demo ? 'Demo accounts: sign in with the demo account for synthetic numbers.' : 'Your real numbers, from a screenshot or typed in.'}
      />
      <ConnectAccounts handleRef={handleRef} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
});
