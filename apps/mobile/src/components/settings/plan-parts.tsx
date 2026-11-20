import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';

import { colors, space, type as t } from '@/src/theme';

/** "A$29/mo" -> ["A$29", "/mo"]. A label without a slash stays whole. */
export function splitPrice(label: string): [string, string] {
  const slash = label.indexOf('/');
  return slash > 0 ? [label.slice(0, slash), label.slice(slash)] : [label, ''];
}

/** The price as a big figure, its period ("/mo") small beside it. */
export function PriceFigure({ label }: { label: string }) {
  const [amount, period] = splitPrice(label);
  return (
    <View style={styles.price} accessible accessibilityLabel={`Price: ${label}`}>
      <Text style={[t.hero, styles.amount]}>{amount}</Text>
      {period ? <Text style={styles.period}>{period}</Text> : null}
    </View>
  );
}

/** Tick list. The ticks are decoration, so screen readers get just the sentences. */
export function FeatureList({ items, tint }: { items: readonly string[]; tint: string }) {
  if (items.length === 0) return null;
  return (
    <View style={styles.list}>
      {items.map((text, i) => (
        <View key={`${i}-${text}`} style={styles.item}>
          <Ionicons name="checkmark-circle" size={18} color={tint} style={styles.tick} aria-hidden />
          <Text style={[t.body, styles.itemText]}>{text}</Text>
        </View>
      ))}
    </View>
  );
}

/** What kind of money (none) this checkout moves. Null for a mode we cannot vouch for. */
export function modeNote(mode: string, pro: boolean): string | null {
  if (mode === 'demo') {
    return pro ? 'Demo mode: nothing was charged.' : 'Demo checkout: no card needed, no money moves.';
  }
  if (mode === 'stripe_test') {
    return pro
      ? 'Stripe test mode: nothing was charged.'
      : 'Stripe test mode: use card 4242 4242 4242 4242. No real money moves.';
  }
  return null;
}

export function ModeNote({ text }: { text: string }) {
  return (
    <View style={styles.note}>
      <Ionicons
        name="information-circle-outline"
        size={14}
        color={colors.textMute}
        style={styles.noteIcon}
        aria-hidden
      />
      <Text style={[t.small, styles.noteText]} selectable>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  price: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: space.xs },
  amount: { fontVariant: ['tabular-nums'] },
  period: { fontSize: 16, fontWeight: '600', color: colors.textDim },
  list: { gap: space.sm },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  tick: { marginTop: 2 },
  itemText: { flex: 1, minWidth: 0 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  noteIcon: { marginTop: 2 },
  noteText: { flex: 1, color: colors.textMute },
});
