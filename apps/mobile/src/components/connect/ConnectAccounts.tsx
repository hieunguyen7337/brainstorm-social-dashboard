/**
 * "Connect your real accounts" (docs/REAL.md): the 6 platforms, each with "Upload a screenshot" and "Type numbers".
 * One component used in onboarding, in the connect sheet and in Settings > Accounts. It renders a plain `View` (no scroll
 * view, no section header): the parent scrolls and titles it.
 *
 *   screenshot -> Claude reads it (POST /api/connections/{platform}/screenshot, nothing saved) -> the person checks and
 *   edits the numbers -> Save = POST /api/metrics/ingest with source "screenshot".
 *   Type numbers -> Save = the same call with source "manual". A failed read (503: AI off or capped) falls back to typing.
 *
 * Feedback is inline, never a toast: inside the sheet a native modal would hide it.
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { ActivityIndicator, Image, Linking, StyleSheet, Text, View } from 'react-native';

import { api, getToken, publicBaseUrl } from '@/src/api';
import {
  checkForm,
  formFromConnection,
  formFromRead,
  isConnected,
  latestIso,
  postsToIngest,
  readFailure,
  saveFailure,
  savedSummary,
  updatedLabel,
  type FormErrors,
  type NumbersForm,
} from '@/src/connect';
import { pickScreenshot } from '@/src/pickImage';
import { colors, space, type as t } from '@/src/theme';
import type { Connection, HarvestStatus, IngestPost, IngestRequest, IngestResult, Platform, ScreenshotRead } from '@/src/types';
import { Button, Card, ErrorState, Skeleton } from '@/src/ui';
import { NumbersFormView } from './NumbersFormView';
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
const ORDER: readonly Platform[] = ['instagram', 'linkedin', 'tiktok', 'x', 'reddit', 'facebook'];

type Flow =
  | { platform: Platform; step: 'reading'; thumb: string }
  | {
      platform: Platform;
      step: 'form';
      /** What Claude read; null while typing. */
      read: ScreenshotRead | null;
      form: NumbersForm;
      /** Recent posts from the screenshot, ready for the ingest call. */
      posts: IngestPost[];
      thumb: string | null;
      /** Why we fell back to typing. */
      notice: string | null;
      errors: FormErrors;
      saving: boolean;
      saveError: string | null;
    };

type FormFlow = Extract<Flow, { step: 'form' }>;

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

  const patchForm = useCallback((patch: Partial<FormFlow>) => {
    setFlow((cur) => (cur && cur.step === 'form' ? { ...cur, ...patch } : cur));
  }, []);

  const busy = flow?.step === 'reading' || (flow?.step === 'form' && flow.saving);

  /** A phone app without the image picker: the web app does the upload, in the same workspace (`#ws=` link). */
  const openUploadPage = (platform: Platform) => {
    const token = getToken();
    if (!token) {
      setNote(platform, { tone: 'error', text: "Couldn't open the upload page. Type the numbers instead." });
      return;
    }
    setNote(platform, { tone: 'info', text: 'Opening the upload page in your browser' });
    Linking.openURL(`${publicBaseUrl()}/#ws=${token}&connect=${platform}`).catch(() => {
      setNote(platform, { tone: 'error', text: "Couldn't open your browser. Type the numbers instead." });
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
      const prev = byPlatform.get(platform) ?? null;
      setFlow({ platform, step: 'reading', thumb: res.image.uri });
      try {
        const read = await api.readScreenshot(platform, { image_base64: res.image.base64, media_type: res.image.mediaType });
        if (!alive.current || id !== seq.current) return;
        const form = formFromRead(read);
        // Updating an account: keep the saved handle when the image did not show one.
        if (!form.handle && isConnected(prev)) form.handle = prev.handle;
        setFlow({
          platform,
          step: 'form',
          read,
          form,
          posts: postsToIngest(read.posts),
          thumb: res.image.uri,
          notice: null,
          errors: {},
          saving: false,
          saveError: null,
        });
      } catch (e) {
        if (!alive.current || id !== seq.current) return;
        // 503 (AI off or capped) and every other failure: say why, and let the person type the numbers.
        setFlow({
          platform,
          step: 'form',
          read: null,
          form: formFromConnection(prev),
          posts: [],
          thumb: res.image.uri,
          notice: readFailure(e),
          errors: {},
          saving: false,
          saveError: null,
        });
      }
    })();
  };

  const type = (platform: Platform) => {
    if (busy) return;
    seq.current += 1;
    setNote(platform, null);
    setFlow({
      platform,
      step: 'form',
      read: null,
      form: formFromConnection(byPlatform.get(platform)),
      posts: [],
      thumb: null,
      notice: null,
      errors: {},
      saving: false,
      saveError: null,
    });
  };

  const cancel = () => {
    seq.current += 1; // a read still in flight is ignored
    setFlow(null);
  };

  const save = async () => {
    if (!flow || flow.step !== 'form' || flow.saving) return;
    const { platform } = flow;
    const check = checkForm(platform, flow.form, flow.read ? 'screenshot' : 'manual', flow.read ? flow.posts : []);
    if (!check.ok) {
      patchForm({ errors: check.errors, saveError: null });
      return;
    }
    patchForm({ saving: true, errors: {}, saveError: null });
    try {
      const result = await api.ingestMetrics(check.request);
      if (!alive.current) return;
      connections.setData((list) => upsert(list, connectedFrom(byPlatform.get(platform) ?? null, check.request, result)));
      setSavedAt((prev) => ({ ...prev, [platform]: result.captured_at }));
      setNote(platform, { tone: 'success', text: savedSummary(platform, check.request) });
      setFlow(null);
      setExpanded(null);
      markSaved();
      void reload(); // the server's copy replaces the instant one
      onSaved?.(platform, result);
    } catch (e) {
      if (!alive.current) return;
      patchForm({ saving: false, saveError: saveFailure(e) });
    }
  };

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
            onUpdate={() => setExpanded((cur) => (cur === platform ? null : platform))}
            onUpload={() => upload(platform)}
            onType={() => type(platform)}
          >
            {mine?.step === 'reading' ? <Reading thumb={mine.thumb} onCancel={cancel} /> : null}
            {mine?.step === 'form' ? (
              <NumbersFormView
                platform={platform}
                form={mine.form}
                errors={mine.errors}
                read={mine.read}
                postsCount={mine.read ? mine.posts.length : 0}
                thumb={mine.thumb}
                notice={mine.notice}
                saving={mine.saving}
                saveError={mine.saveError}
                onChange={(patch) => patchForm({ form: { ...mine.form, ...patch }, errors: {}, saveError: null })}
                onSave={() => void save()}
                onCancel={cancel}
              />
            ) : null}
          </PlatformCard>
        );
      })}
      {connections.error ? (
        <Text style={[t.small, styles.stale]}>{"Couldn't refresh your accounts. Showing the last known status."}</Text>
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
        <Text style={t.small}>This takes a few seconds. Nothing is saved until you check the numbers.</Text>
      </View>
      <Button small variant="ghost" title="Cancel" onPress={onCancel} />
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
