import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { OfflineView, SplashView } from '@/src/components/BootStates';
import { cleanRoomCode } from '@/src/components/room/roomStore';
import { useSession } from '@/src/session';

/** Web: the `?room=` on the URL the page was opened with (the router param is the source of truth, this is its backstop). */
function webRoomParam(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    return cleanRoomCode(new URLSearchParams(window.location.search).get('room'));
  } catch {
    return null;
  }
}

/**
 * Entry: route by session status.
 *
 * A room link (`/?room=CODE` on web, `pulse://?room=CODE` on native) skips onboarding entirely: with no session it creates
 * the guest workspace straight away (splash while it is in flight, no form), with a session it keeps that workspace; both
 * land on the Dashboard, which shows the welcome. Only if the workspace cannot be created does the person see onboarding.
 */
export default function Index() {
  const params = useLocalSearchParams<{ room?: string | string[] }>();
  const [urlRoom] = useState(webRoomParam);
  const room = cleanRoomCode(params.room) ?? urlRoom;
  const { status, joinRoom } = useSession();
  const joined = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!room || joined.current === room) return;
    // Wait for the saved token to be checked ('loading'); a saved but unreachable workspace ('offline') has its own screen.
    if (status !== 'anon' && status !== 'ready') return;
    joined.current = room;
    void joinRoom(room).then((ok) => {
      if (!ok) setFailed(true);
    });
  }, [room, status, joinRoom]);

  if (room) {
    if (status === 'ready') return <Redirect href="/dashboard" />;
    if (status === 'offline') return <OfflineView />;
    if (status === 'anon' && failed) return <Redirect href="/onboarding" />;
    return <SplashView />;
  }

  if (status === 'ready') return <Redirect href="/dashboard" />;
  if (status === 'anon') return <Redirect href="/onboarding" />;
  if (status === 'offline') return <OfflineView />;
  return <SplashView />;
}
