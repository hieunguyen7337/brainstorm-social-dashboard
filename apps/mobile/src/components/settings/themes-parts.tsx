/**
 * Building blocks of the Themes section: colour swatches, the shared name/description/colour form, the expandable
 * theme row with its inline editor, the "new theme" card and the loading skeleton.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, swatches, type as t, withAlpha } from '@/src/theme';
import type { Theme, ThemeCreate, ThemePatch } from '@/src/types';
import { Button, Card, Skeleton, TextField, Toggle, haptic } from '@/src/ui';

const NATIVE = Platform.OS !== 'web';
const NAME_MAX = 60;
const DESC_MAX = 500;
const DEFAULT_COLOR = '#7c5cff';
const SWATCH_NAMES = ['Violet', 'Pink', 'Green', 'Amber', 'Blue', 'Orange', 'Purple', 'Cyan'];

const HEX = /^#[0-9a-f]{6}$/i;
/** A usable `#rrggbb` (the API stores whatever it was given): anything else falls back to the accent. */
const safeHex = (c: string | null | undefined): string => {
  const s = (c ?? '').trim();
  return HEX.test(s) ? s : colors.accent;
};

/** Dark or white, whichever reads on this swatch colour. */
function onColor(hex: string): string {
  if (!HEX.test(hex.trim())) return colors.white;
  const n = parseInt(hex.trim().slice(1), 16);
  const luma = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma > 150 ? colors.bg : colors.white;
}

/** Fade + short slide-in on mount. */
function Reveal({ children }: { children: ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(v, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE });
    anim.start();
    return () => anim.stop();
  }, [v]);
  const translateY = useMemo(() => v.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }), [v]);
  return <Animated.View style={{ opacity: v, transform: [{ translateY }] }}>{children}</Animated.View>;
}

// ---- colour ---------------------------------------------------------------------------------------------------

/** The theme's colour dot: 14px with a soft ring. */
function ColorDot({ color, dim }: { color: string; dim?: boolean }) {
  const c = safeHex(color);
  return (
    <View style={[styles.dotRing, { backgroundColor: withAlpha(c, 0.2) }, dim && styles.faded]}>
      <View style={[styles.dot, { backgroundColor: c }]} />
    </View>
  );
}

/**
 * One row of colour swatches; the selected one gets a check inside a ring. `extra` is the theme's current colour when
 * it is not one of the swatches, so a custom colour stays selectable while editing.
 */
function SwatchPicker({ value, onChange, extra }: { value: string; onChange: (hex: string) => void; extra?: string }) {
  const options = useMemo(() => {
    const list = swatches.map((hex, i) => ({ hex: hex as string, name: SWATCH_NAMES[i] ?? hex }));
    if (extra && HEX.test(extra.trim()) && !list.some((o) => o.hex.toLowerCase() === extra.trim().toLowerCase())) {
      list.push({ hex: extra.trim(), name: 'Current colour' });
    }
    return list;
  }, [extra]);
  const current = value.trim().toLowerCase();

  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Theme colour" style={styles.swatchRow}>
      {options.map((o) => {
        const selected = o.hex.toLowerCase() === current;
        return (
          <Pressable
            key={o.hex}
            accessibilityRole="radio"
            accessibilityLabel={o.name}
            accessibilityState={{ selected, checked: selected }}
            hitSlop={2}
            onPress={() => {
              haptic.select();
              onChange(o.hex);
            }}
            style={({ pressed }) => [styles.swatchHit, pressed && styles.pressed]}
          >
            <View style={[styles.swatchRing, selected && styles.swatchRingOn]}>
              <View style={[styles.swatch, { backgroundColor: o.hex }]}>
                {selected ? <Ionicons name="checkmark" size={15} color={onColor(o.hex)} /> : null}
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---- the form shared by "new theme" and the inline editor --------------------------------------------------------

interface FieldsProps {
  name: string;
  onName: (v: string) => void;
  onNameBlur?: () => void;
  nameError?: string | null;
  description: string;
  onDescription: (v: string) => void;
  color: string;
  onColor: (hex: string) => void;
  extraColor?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
}

function ThemeFields(p: FieldsProps) {
  const left = NAME_MAX - p.name.length;
  return (
    <View style={styles.fields}>
      <TextField
        label="Name"
        value={p.name}
        onChangeText={p.onName}
        onBlur={p.onNameBlur}
        placeholder="e.g. Customer stories"
        maxLength={NAME_MAX}
        autoFocus={p.autoFocus}
        returnKeyType="done"
        onSubmitEditing={p.onSubmit}
        error={p.nameError}
        right={left <= 10 ? <Text style={styles.counter}>{left}</Text> : undefined}
      />
      <TextField
        label="Description"
        value={p.description}
        onChangeText={p.onDescription}
        placeholder="What should posts under this theme talk about?"
        multiline
        maxLength={DESC_MAX}
        inputStyle={styles.descInput}
      />
      <View>
        <Text style={[t.label, styles.colorLabel]}>Colour</Text>
        <SwatchPicker value={p.color} onChange={p.onColor} extra={p.extraColor} />
      </View>
    </View>
  );
}

/** Low-emphasis destructive action: red text and icon, no fill. */
function GhostDanger({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      hitSlop={4}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => [styles.danger, pressed && styles.pressed, disabled && styles.faded]}
    >
      <Ionicons name="trash-outline" size={16} color={colors.danger} />
      <Text style={styles.dangerText}>{title}</Text>
    </Pressable>
  );
}

// ---- inline editor ---------------------------------------------------------------------------------------------

interface EditorProps {
  theme: Theme;
  onSave: (id: string, patch: ThemePatch) => Promise<boolean>;
  onDelete: (theme: Theme) => void;
  onClose: () => void;
}

/** Mounted only while its row is open, so the draft always starts from the saved theme and dies with the editor. */
function ThemeEditor({ theme, onSave, onDelete, onClose }: EditorProps) {
  const savedDescription = (theme.description ?? '').trim();
  const savedColor = (theme.color ?? '').trim().toLowerCase();
  const [name, setName] = useState(theme.name ?? '');
  const [description, setDescription] = useState(theme.description ?? '');
  const [color, setColor] = useState(theme.color ?? DEFAULT_COLOR);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const trimmedName = name.trim();
  const patch: ThemePatch = {};
  if (trimmedName !== theme.name) patch.name = trimmedName;
  if (description.trim() !== savedDescription) patch.description = description.trim();
  if (color.trim().toLowerCase() !== savedColor) patch.color = color;
  const dirty = Object.keys(patch).length > 0;
  const nameError = (touched || dirty) && !trimmedName ? 'Give your theme a name' : null;

  const save = async () => {
    setTouched(true);
    if (saving || !dirty || !trimmedName) return;
    setSaving(true);
    const ok = await onSave(theme.id, patch);
    if (ok) onClose();
    else setSaving(false);
  };

  return (
    <View style={styles.editor}>
      <ThemeFields
        name={name}
        onName={setName}
        onNameBlur={() => setTouched(true)}
        nameError={nameError}
        description={description}
        onDescription={setDescription}
        color={color}
        onColor={setColor}
        extraColor={theme.color ?? undefined}
        onSubmit={() => void save()}
      />
      <View style={styles.actions}>
        <Button
          title="Save"
          icon="checkmark"
          loading={saving}
          disabled={!dirty || !trimmedName}
          onPress={() => void save()}
          style={styles.flex}
        />
        <Button title="Cancel" variant="secondary" disabled={saving} onPress={onClose} style={styles.flex} />
      </View>
      <GhostDanger title="Delete theme" disabled={saving} onPress={() => onDelete(theme)} />
    </View>
  );
}

// ---- a theme row ----------------------------------------------------------------------------------------------

interface RowProps {
  theme: Theme;
  expanded: boolean;
  onToggleExpand: (id: string) => void;
  /** Optimistic; never rejects (it reverts and toasts by itself). */
  onToggleActive: (id: string, next: boolean) => Promise<void>;
  /** Resolves true when saved. */
  onSave: (id: string, patch: ThemePatch) => Promise<boolean>;
  onDelete: (theme: Theme) => void;
}

/**
 * Colour dot, name, two lines of description, an active switch and a chevron. The dot + text and the chevron open the
 * editor; the switch is a sibling of them (not nested) so toggling never also expands the row.
 */
export const ThemeRow = memo(function ThemeRow({ theme, expanded, onToggleExpand, onToggleActive, onSave, onDelete }: RowProps) {
  const [switching, setSwitching] = useState(false);

  const turn = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  useEffect(() => {
    const anim = Animated.timing(turn, {
      toValue: expanded ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: NATIVE,
    });
    anim.start();
    return () => anim.stop();
  }, [expanded, turn]);
  const rotate = useMemo(() => turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] }), [turn]);

  const toggleExpand = useCallback(() => onToggleExpand(theme.id), [onToggleExpand, theme.id]);

  const toggleActive = useCallback(
    async (next: boolean) => {
      setSwitching(true);
      try {
        await onToggleActive(theme.id, next);
      } finally {
        setSwitching(false);
      }
    },
    [onToggleActive, theme.id],
  );

  const paused = !theme.active;
  return (
    <Card padded={false} style={expanded ? { borderColor: withAlpha(safeHex(theme.color), 0.55) } : undefined}>
      <View style={styles.head}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${theme.name}, ${paused ? 'paused' : 'active'}`}
          accessibilityHint={expanded ? 'Closes the editor' : 'Opens the editor'}
          accessibilityState={{ expanded }}
          onPress={toggleExpand}
          style={({ pressed }) => [styles.headMain, pressed && styles.pressed]}
        >
          <ColorDot color={theme.color} dim={paused} />
          <View style={styles.headText}>
            <Text style={[styles.name, paused && styles.nameOff]} numberOfLines={1}>
              {theme.name}
            </Text>
            <Text style={[styles.desc, !theme.description && styles.descEmpty]} numberOfLines={2}>
              {theme.description || 'No description yet'}
            </Text>
          </View>
        </Pressable>
        <View pointerEvents={switching ? 'none' : 'auto'}>
          <Toggle value={theme.active} onValueChange={(v) => void toggleActive(v)} />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? `Close editor for ${theme.name}` : `Edit ${theme.name}`}
          hitSlop={8}
          onPress={toggleExpand}
          style={({ pressed }) => [styles.chevron, pressed && styles.pressed]}
        >
          <Animated.View style={{ transform: [{ rotate }] }}>
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </Animated.View>
        </Pressable>
      </View>
      {expanded ? (
        <Reveal>
          <ThemeEditor theme={theme} onSave={onSave} onDelete={onDelete} onClose={toggleExpand} />
        </Reveal>
      ) : null}
    </Card>
  );
});

// ---- new theme ------------------------------------------------------------------------------------------------

interface CreateProps {
  /** Resolves true when the theme was created. */
  onCreate: (body: ThemeCreate) => Promise<boolean>;
  onClose: () => void;
}

/** Collapsible creation card shown above the list. Unmounting it (cancel or success) resets the form. */
export function ThemeCreateCard({ onCreate, onClose }: CreateProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const trimmed = name.trim();
  const nameError = touched && !trimmed ? 'Give your theme a name (1 to 60 characters)' : null;

  const submit = async () => {
    setTouched(true);
    if (saving || !trimmed) return;
    setSaving(true);
    const ok = await onCreate({ name: trimmed, description: description.trim(), color });
    if (ok) onClose();
    else setSaving(false);
  };

  return (
    <Reveal>
      <Card>
        <View style={styles.createStack}>
          <Text style={t.h3}>New content pillar</Text>
          <ThemeFields
            name={name}
            onName={setName}
            onNameBlur={() => setTouched(true)}
            nameError={nameError}
            description={description}
            onDescription={setDescription}
            color={color}
            onColor={setColor}
            autoFocus
            onSubmit={() => void submit()}
          />
          <View style={styles.actions}>
            <Button title="Add theme" icon="add" loading={saving} onPress={() => void submit()} style={styles.flex} />
            <Button title="Cancel" variant="secondary" disabled={saving} onPress={onClose} style={styles.flex} />
          </View>
        </View>
      </Card>
    </Reveal>
  );
}

// ---- loading ----------------------------------------------------------------------------------------------------

export function ThemeRowSkeleton() {
  return (
    <Card padded={false}>
      <View style={styles.skeleton}>
        <Skeleton width={24} height={24} rounded={12} />
        <View style={styles.skeletonText}>
          <Skeleton width="42%" height={15} />
          <Skeleton width="86%" height={12} />
        </View>
        <Skeleton width={44} height={26} rounded={13} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.85 },
  faded: { opacity: 0.5 },

  dotRing: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 14, height: 14, borderRadius: 7 },

  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.sm, maxWidth: 420 },
  swatchHit: { width: 36, height: 36 },
  swatchRing: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchRingOn: { borderColor: colors.text },
  swatch: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },

  fields: { gap: space.lg },
  descInput: { minHeight: 72 },
  colorLabel: { marginBottom: space.sm },
  counter: { color: colors.textMute, fontSize: 12, fontWeight: '700', marginLeft: space.sm, fontVariant: ['tabular-nums'] },

  danger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: 44,
    borderRadius: radius.md,
  },
  dangerText: { color: colors.danger, fontSize: 14.5, fontWeight: '700' },

  head: { flexDirection: 'row', alignItems: 'center', paddingRight: space.sm },
  headMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, paddingRight: space.sm },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: colors.text, fontSize: 15.5, fontWeight: '800', letterSpacing: -0.1 },
  nameOff: { color: colors.textDim },
  desc: { color: colors.textDim, fontSize: 13.5, lineHeight: 18 },
  descEmpty: { color: colors.textMute, fontStyle: 'italic' },
  chevron: { width: 30, height: 44, alignItems: 'center', justifyContent: 'center' },

  editor: {
    gap: space.lg,
    padding: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actions: { flexDirection: 'row', gap: space.md },
  createStack: { gap: space.lg },

  skeleton: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: 14 },
  skeletonText: { flex: 1, gap: 8 },
});
