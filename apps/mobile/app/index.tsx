import { Redirect } from 'expo-router';

import { OfflineView, SplashView } from '@/src/components/BootStates';
import { useSession } from '@/src/session';

/** Entry: route by session status. */
export default function Index() {
  const { status } = useSession();
  if (status === 'ready') return <Redirect href="/dashboard" />;
  if (status === 'anon') return <Redirect href="/onboarding" />;
  if (status === 'offline') return <OfflineView />;
  return <SplashView />;
}
