/**
 * Settings > Themes: the content pillars that steer what Claude writes. List with an optimistic active switch, an
 * inline editor per row (edit, recolour, delete) and an "Add theme" card. Rows and their drafts are keyed by theme id.
 * The building blocks live in `themes-parts.tsx`.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { api, ApiError } from '@/src/api';
import { useAsync } from '@/src/hooks';
import { space } from '@/src/theme';
import type { Theme, ThemeCreate, ThemePatch } from '@/src/types';
import { Button, Card, EmptyState, ErrorState, SectionHeader, confirm, haptic, useToast } from '@/src/ui';
import { ThemeCreateCard, ThemeRow, ThemeRowSkeleton } from './themes-parts';

const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : 'Something went wrong');

export function ThemesSection() {
  const { show } = useToast();
  const { data, error, loading, refreshing, reload, setData } = useAsync(() => api.listThemes(), []);

  const [adding, setAdding] = useState(false);
  /** The row whose editor is open (one at a time). */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Themes created in this visit: listed first, and they stay there when the list is re-read from the server. */
  const [freshIds, setFreshIds] = useState<string[]>([]);

  const dataRef = useRef<Theme[] | undefined>(data);
  dataRef.current = data;

  const items = useMemo(() => {
    if (!data) return [];
    if (freshIds.length === 0) return data;
    const fresh = freshIds.map((id) => data.find((th) => th.id === id)).filter((th): th is Theme => !!th);
    return [...fresh, ...data.filter((th) => !freshIds.includes(th.id))];
  }, [data, freshIds]);

  const toggleExpand = useCallback((id: string) => setEditingId((cur) => (cur === id ? null : id)), []);

  /** Flip `active` at once; the server's answer confirms it, a failure puts it back. Touches that one field only. */
  const toggleActive = useCallback(
    async (id: string, next: boolean) => {
      const setActive = (active: boolean) =>
        setData((prev) => prev?.map((th) => (th.id === id ? { ...th, active } : th)));
      setActive(next);
      try {
        const saved = await api.patchTheme(id, { active: next });
        if (typeof saved?.active === 'boolean') setActive(saved.active);
      } catch (e) {
        setActive(!next);
        show(messageOf(e), 'error');
      }
    },
    [setData, show],
  );

  /** Save the editor's changes. Applies only the patched fields from the answer, so a switch flipped meanwhile survives. */
  const saveTheme = useCallback(
    async (id: string, patch: ThemePatch): Promise<boolean> => {
      try {
        const saved = await api.patchTheme(id, patch);
        setData((prev) =>
          prev?.map((th) =>
            th.id === id
              ? {
                  ...th,
                  name: patch.name != null ? (saved?.name ?? patch.name) : th.name,
                  description: patch.description != null ? (saved?.description ?? patch.description) : th.description,
                  color: patch.color != null ? (saved?.color ?? patch.color) : th.color,
                }
              : th,
          ),
        );
        haptic.success();
        show('Theme saved');
        return true;
      } catch (e) {
        show(messageOf(e), 'error');
        return false;
      }
    },
    [setData, show],
  );

  const createTheme = useCallback(
    async (body: ThemeCreate): Promise<boolean> => {
      try {
        const created = await api.createTheme(body);
        if (created?.id) {
          setData((prev) => [...(prev ?? []), created]);
          setFreshIds((ids) => [created.id, ...ids]);
        } else {
          void reload(); // saved, but the answer was unusable: read the list back instead
        }
        haptic.success();
        show('Theme added');
        return true;
      } catch (e) {
        show(messageOf(e), 'error');
        return false;
      }
    },
    [setData, reload, show],
  );

  /** Confirm, remove from the list at once, and put it back where it was if the server says no. */
  const deleteTheme = useCallback(
    async (theme: Theme) => {
      const ok = await confirm('Delete this theme?', `"${theme.name}" will be removed from your themes.`, 'Delete', true);
      if (!ok) return;
      const index = dataRef.current?.findIndex((th) => th.id === theme.id) ?? -1;
      setEditingId((cur) => (cur === theme.id ? null : cur));
      setData((prev) => prev?.filter((th) => th.id !== theme.id));
      try {
        await api.deleteTheme(theme.id);
        haptic.success();
        show('Theme deleted');
      } catch (e) {
        setData((prev) => {
          if (!prev || prev.some((th) => th.id === theme.id)) return prev;
          const next = [...prev];
          next.splice(index < 0 ? next.length : Math.min(index, next.length), 0, theme);
          return next;
        });
        show(messageOf(e), 'error');
      }
    },
    [setData, show],
  );

  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);

  let body;
  if (!data) {
    body =
      loading || refreshing ? (
        <View style={styles.list}>
          {[0, 1, 2].map((i) => (
            <ThemeRowSkeleton key={i} />
          ))}
        </View>
      ) : (
        <Card>
          <ErrorState message={error?.message ?? 'Something went wrong.'} onRetry={() => void reload()} />
        </Card>
      );
  } else if (items.length === 0 && !adding) {
    body = (
      <Card>
        <EmptyState
          icon="color-palette-outline"
          title="No themes yet"
          message="Add your first content pillar"
          action={<Button title="Add theme" icon="add" small onPress={openAdd} />}
        />
      </Card>
    );
  } else {
    body = (
      <View style={styles.list}>
        {items.map((theme) => (
          <ThemeRow
            key={theme.id}
            theme={theme}
            expanded={editingId === theme.id}
            onToggleExpand={toggleExpand}
            onToggleActive={toggleActive}
            onSave={saveTheme}
            onDelete={deleteTheme}
          />
        ))}
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <SectionHeader
        title="Themes"
        subtitle="Content pillars that steer what Claude writes"
        right={
          data ? (
            <Button
              title={adding ? 'Close' : 'Add theme'}
              icon={adding ? 'close' : 'add'}
              variant="ghost"
              small
              onPress={() => setAdding((a) => !a)}
            />
          ) : undefined
        }
      />
      {adding ? <ThemeCreateCard onCreate={createTheme} onClose={closeAdd} /> : null}
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  list: { gap: 10 },
});
