/**
 * "Connect your real accounts" (docs/REAL.md): the 6 platforms, each with "Upload a screenshot" (no typed numbers).
 * One component used in onboarding, in the connect sheet and in Settings > Accounts. It renders a plain `View` (no scroll
 * view, no section header): the parent scrolls and titles it.
 *
 *   screenshot -> Claude reads it (POST /api/connections/{platform}/screenshot) -> saved at once = POST /api/metrics/ingest
 *   with source "screenshot". There is no confirm form.
 *   Android with the in-app reader (`src/autoRead`): "Connect with <Platform>" (or "Update" on a connected card) opens a
 *   sign-in sheet that reads the numbers on the phone -> saved at once with source "device". Its failure note on the card
 *   points to the screenshot upload.
 *   Pulse Desktop (`src/desktop`): the card's only action is "Connect with <Platform>" (its own login window); the upload
 *   appears after a failed connect, and a connected card has "Show <Platform>".
 *   A failed read or save (503: AI off or capped, too large, offline, no numbers) shows why on the card; nothing is typed by hand.
 *
 * Feedback is inline, never a toast: inside the sheet a native modal would hide it.
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { ActivityIndicator, Image, Linking, Platform as RNPlatform, StyleSheet, Text, View } from 'react-native';

import { androidDownloadUrl, api, getToken, publicBaseUrl } from '@/src/api';
import { AutoReadSheet, autoReadAvailable, type DeviceRead } from '@/src/autoRead';
import {
  checkForm,
  formFromRead,
  isConnected,
  latestIso,
  platformMismatch,
  postsToIngest,
  readFailure,
  saveFailure,
  savedSummary,
  updatedLabel,
} from '@/src/connect';
import { getDesktop } from '@/src/desktop';
import { pickScreenshot } from '@/src/pickImage';
import { colors, space, type as t } from '@/src/theme';
import type { Connection, HarvestStatus, IngestRequest, IngestResult, Platform, ScreenshotRead } from '@/src/types';
import { Button, Card, ErrorState, Skeleton } from '@/src/ui';
import { isLivePlatform } from '@/src/platforms';
import { PlatformCard, type CardNote } from './PlatformCard';
import { useConnectSheet } from './sheetContext';
import { useLoader } from './useLoader';

/** What a parent screen can call (pull to refresh / the web refresh button). */
export interface ConnectAccountsHandle {
  reload: () => Promise<void>;
}

export interface ConnectAccountsProps {
  /** Open this platform's panel on mount (a `#connect=` link, or a "Connect"/"Update" button elsewhere): it moves to the top. */
  initialPlatform?: Platform | null;
  /** Called after each successful save. */
  onSaved?: (platform: Platform, result: IngestResult) => void;
  handleRef?: Ref<ConnectAccountsHandle>;
}

/** The order the contract lists the platforms in. */
const ORDER: readonly Platform[] = (['instagram', 'linkedin', 'tiktok', 'x', 'reddit', 'facebook'] as const).filter(isLivePlatform);

type Flow =
  | { platform: Platform; step: 'reading'; thumb: string }
  /** Numbers in hand (a screenshot Claude read, or a page read on the phone): being saved. */
  | { platform: Platform; step: 'saving' };

const upsert = (list: Connection[] | undefined, conn: Connection): Connection[] => [
  ...(list ?? []).filter((c) => c.platform !== conn.platform),
  conn,
];

/** The connection as the person just saved it, for an instant update before the server's copy arrives. */
function connectedFrom(prev: Connection | null, req: IngestRequest, result: IngestResult): Connection {
  return {
    platform: req.platform,
    handle: req.handle ?? prev?.handle ?? '',
    status: 'connected',
    mode: 'live',
    followers: req.account?.followers ?? prev?.followers ?? 0,
    connected_at: prev?.connected_at || result.captured_at,
    profile_url: prev?.profile_url ?? null,
    last_harvested_at: result.captured_at,
    real_data: true,
  };
}

export function ConnectAccounts({ initialPlatform = null, onSaved, handleRef }: ConnectAccountsProps) {
  const { version, markSaved } = useConnectSheet();
  const connections = useLoader(() => api.listConnections(), []);
  // "Updated <time>" comes from here; a failure only means no time is shown.
  const harvest = useLoader(async (): Promise<HarvestStatus[]> => {
    try {
      return await api.getHarvestStatus();
    } catch {
      return [];
    }
  }, []);

  const { reload: reloadConnections } = connections;
  const { reload: reloadHarvest } = harvest;
  const reload = useCallback(async () => {
    await Promise.all([reloadConnections(), reloadHarvest()]);
  }, [reloadConnections, reloadHarvest]);
  useImperativeHandle(handleRef, () => ({ reload }), [reload]);

  // A save made somewhere else (the sheet over the Dashboard) refreshes this list too.
  const firstVersion = useRef(version);
  useEffect(() => {
    if (version !== firstVersion.current) void reload();
  }, [version, reload]);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [flow, setFlow] = useState<Flow | null>(null);
  const [expanded, setExpanded] = useState<Platform | null>(initialPlatform);
  const [notes, setNotes] = useState<Partial<Record<Platform, CardNote>>>({});
  const [savedAt, setSavedAt] = useState<Partial<Record<Platform, string>>>({});
  /** Ignores the answer of a read the person has cancelled or replaced. */
  const seq = useRef(0);

  const byPlatform = useMemo(() => {
    const map = new Map<Platform, Connection>();
    for (const c of connections.data ?? []) map.set(c.platform, c);
    return map;
  }, [connections.data]);
  const harvestBy = useMemo(() => {
    const map = new Map<Platform, HarvestStatus>();
    for (const h of harvest.data ?? []) map.set(h.platform, h);
    return map;
  }, [harvest.data]);

  const order = useMemo(
    () => (initialPlatform ? [initialPlatform, ...ORDER.filter((p) => p !== initialPlatform)] : ORDER),
    [initialPlatform],
  );

  const setNote = useCallback((platform: Platform, note: CardNote | null) => {
    setNotes((prev) => {
      const next = { ...prev };
      if (note) next[platform] = note;
      else delete next[platform];
      return next;
    });
  }, []);

  const busy = flow !== null;

  /** A phone app without the image picker: the web app does the upload, in the same workspace (`#ws=` link). */
  const openUploadPage = (platform: Platform) => {
    const token = getToken();
    if (!token) {
      setNote(platform, { tone: 'error', text: "Couldn't open the upload page. Reload Pulse and try again." });
      return;
    }
    setNote(platform, { tone: 'info', text: 'Opening the upload page in your browser' });
    Linking.openURL(`${publicBaseUrl()}/#ws=${token}&connect=${platform}`).catch(() => {
      setNote(platform, { tone: 'error', text: `Couldn't open your browser. Open ${publicBaseUrl()} there to upload.` });
    });
  };

  const upload = (platform: Platform) => {
    if (busy) return;
    // Open the picker right here, inside the tap: iOS Safari only opens a file picker for a synchronous click.
    const picked = pickScreenshot();
    setNote(platform, null);
    void (async () => {
      const res = await picked;
      if (!alive.current || res.status === 'cancelled') return;
      if (res.status === 'unavailable') {
        openUploadPage(platform);
        return;
      }
      if (res.status === 'error') {
        setNote(platform, { tone: 'error', text: res.message });
        return;
      }
      const id = ++seq.current;
      setFlow({ platform, step: 'reading', thumb: res.image.uri });
      try {
        const read = await api.readScreenshot(platform, { image_base64: res.image.base64, media_type: res.image.mediaType });
        if (!alive.current || id !== seq.current) return;
        // A screenshot of another platform is not saved on this card (it would show the wrong numbers here).
        const mismatch = platformMismatch(read);
        if (mismatch) {
          setFlow(null);
          setNote(platform, { tone: 'error', text: mismatch });
          return;
        }
        await persist(platform, read, 'screenshot', id);
      } catch (e) {
        if (!alive.current || id !== seq.current) return;
        // 503 (AI off or capped) and every other failure: say why on the card; the person tries another screenshot.
        setFlow(null);
        setNote(platform, { tone: 'error', text: readFailure(e) });
      }
    })();
  };

  /** The platform whose in-app sign-in sheet is open (`src/autoRead`). */
  const [auto, setAuto] = useState<Platform | null>(null);
  // Android only, and only when this build has both native modules (an older APK does not): web and iOS keep the upload.
  const desktop = getDesktop();
  const canAutoRead = (RNPlatform.OS === 'android' || desktop !== null) && autoReadAvailable();
  /** Desktop: platforms whose connect failed, so the screenshot upload is offered on their card. */
  const [offered, setOffered] = useState<Platform[]>([]);

  const connect = (platform: Platform) => {
    if (busy) return;
    setNote(platform, null);
    setOffered((cur) => cur.filter((p) => p !== platform));
    setAuto(platform);
  };

  // Web and iOS cannot sign in inside Pulse (a website cannot read another site, and the server is rate-limited by
  // Instagram, 2026-11-21): "Connect" still comes first and leads to the Android app; the screenshot stays the fallback.
  const androidBrowser =
    RNPlatform.OS === 'web' && typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent ?? '');
  const connectElsewhere = (platform: Platform) => {
    if (busy) return;
    if (androidBrowser) {
      setNote(platform, {
        tone: 'info',
        text: 'Opening the Pulse Android app download. Install it, open Pulse and tap Connect: you sign in once and your numbers are read for you.',
      });
      void Linking.openURL(androidDownloadUrl()).catch(() => undefined);
    } else {
      setNote(platform, {
        tone: 'info',
        text: `Connecting signs you in inside the Pulse Android app. On an Android phone, open ${publicBaseUrl()} and tap Connect to get it. On iPhone or a computer for now, upload a screenshot.`,
      });
    }
  };

  /** Numbers read on the phone: saved at once with source "device". */
  const autoResult = (platform: Platform, read: DeviceRead) => {
    if (!alive.current) return;
    setAuto(null);
    const id = ++seq.current;
    void persist(platform, read, 'device', id);
  };

  /** The sheet ended without numbers: `reason` (set when reading gave up) goes on the card; the screenshot upload stays. */
  const autoClose = (platform: Platform, reason?: string) => {
    if (!alive.current) return;
    setAuto(null);
    if (reason) {
      setNote(platform, { tone: 'error', text: reason });
      if (desktop) setOffered((cur) => (cur.includes(platform) ? cur : [...cur, platform]));
    }
  };

  const cancel = () => {
    seq.current += 1; // a read still in flight is ignored
    setFlow(null);
  };

  /**
   * Saves what was read, with the same `checkForm` + ingest call the old form's Save button made. No form is shown: a read
   * with no usable number, or a failed check or save, ends as an error note on the card (the card's buttons try again).
   */
  async function persist(platform: Platform, read: ScreenshotRead, source: 'screenshot' | 'device', id: number) {
    const form = formFromRead(read);
    const prev = byPlatform.get(platform) ?? null;
    // Updating an account: keep the saved handle when the read did not show one.
    if (!form.handle && isConnected(prev)) form.handle = prev.handle;
    const check = checkForm(platform, form, source, postsToIngest(read.posts));
    if (!check.ok) {
      setFlow(null);
      setNote(platform, { tone: 'error', text: "Couldn't read any numbers. Try again." });
      return;
    }
    setFlow({ platform, step: 'saving' });
    try {
      const result = await api.ingestMetrics(check.request);
      if (!alive.current || id !== seq.current) return;
      connections.setData((list) => upsert(list, connectedFrom(prev, check.request, result)));
      setSavedAt((cur) => ({ ...cur, [platform]: result.captured_at }));
      setNote(platform, { tone: 'success', text: savedSummary(platform, check.request) });
      setFlow(null);
      setExpanded(null);
      markSaved(); // the dashboard (and every other list) refetches by itself
      void reload(); // the server's copy replaces the instant one
      onSaved?.(platform, result);
    } catch (e) {
      if (!alive.current || id !== seq.current) return;
      setFlow(null);
      setNote(platform, { tone: 'error', text: saveFailure(e) });
    }
  }

  if (connections.loading && !connections.data) return <ConnectSkeleton />;
  if (connections.error && !connections.data) {
    return (
      <Card padded={false}>
        <ErrorState
          title="Couldn't load your accounts"
          message={connections.error.message}
          onRetry={() => void reload()}
        />
      </Card>
    );
  }

  return (
    <View style={styles.list} testID="connect-accounts">
      {order.map((platform) => {
        const conn = byPlatform.get(platform) ?? null;
        const mine = flow?.platform === platform ? flow : null;
        const updated = isConnected(conn)
          ? updatedLabel(latestIso(harvestBy.get(platform)?.last_harvest_at, conn.last_harvested_at, savedAt[platform], conn.connected_at))
          : null;
        return (
          <PlatformCard
            key={platform}
            platform={platform}
            conn={conn}
            updated={updated}
            highlighted={initialPlatform === platform}
            expanded={expanded === platform}
            busy={busy}
            open={mine !== null}
            note={notes[platform] ?? null}
            onUpdate={() => {
              // Android with the in-app reader: "Update" signs in and reads at once; elsewhere it opens the card's buttons.
              if (canAutoRead) connect(platform);
              else setExpanded((cur) => (cur === platform ? null : platform));
            }}
            onUpload={() => upload(platform)}
            onConnect={canAutoRead ? () => connect(platform) : () => connectElsewhere(platform)}
            desktop={desktop !== null}
            uploadOffered={offered.includes(platform)}
            onShow={desktop ? () => void desktop.social.openWindow(platform).catch(() => undefined) : undefined}
          >
            {mine?.step === 'reading' ? <Reading thumb={mine.thumb} onCancel={cancel} /> : null}
            {mine?.step === 'saving' ? <Saving /> : null}
          </PlatformCard>
        );
      })}
      {connections.error ? (
        <Text style={[t.small, styles.stale]}>{"Couldn't refresh your accounts. Showing the last known status."}</Text>
      ) : null}
      {auto ? (
        <AutoReadSheet
          platform={auto}
          visible
          handle={byPlatform.get(auto)?.handle ?? null}
          onResult={(read) => autoResult(auto, read)}
          onClose={(reason) => autoClose(auto, reason)}
          readScreenshot={(base64, mediaType) => api.readScreenshot(auto, { image_base64: base64, media_type: mediaType })}
        />
      ) : null}
    </View>
  );
}

function Reading({ thumb, onCancel }: { thumb: string; onCancel: () => void }) {
  return (
    <View style={styles.reading} accessibilityLiveRegion="polite" testID="connect-reading">
      <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" accessibilityLabel="Your screenshot" />
      <View style={styles.readingText}>
        <View style={styles.readingLine}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.readingTitle}>Claude is reading your screenshot</Text>
        </View>
        <Text style={t.small}>This takes a few seconds. Your numbers are saved when it is done.</Text>
      </View>
      <Button small variant="ghost" title="Cancel" onPress={onCancel} />
    </View>
  );
}

function Saving() {
  return (
    <View style={styles.readingLine} accessibilityLiveRegion="polite" testID="connect-saving">
      <ActivityIndicator size="small" color={colors.accent} />
      <Text style={styles.readingTitle}>Saving your numbers</Text>
    </View>
  );
}

function ConnectSkeleton() {
  return (
    <View style={styles.list}>
      {ORDER.map((p) => (
        <Card key={p} padded={false}>
          <View style={styles.skeletonRow}>
            <Skeleton width={40} height={40} rounded={20} />
            <View style={styles.readingText}>
              <Skeleton width="40%" height={14} />
              <Skeleton width="65%" height={12} />
            </View>
          </View>
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.md },
  stale: { textAlign: 'center' },
  reading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md },
  thumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: colors.cardHi },
  readingText: { flex: 1, minWidth: 160, gap: 2 },
  readingLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  readingTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
});
