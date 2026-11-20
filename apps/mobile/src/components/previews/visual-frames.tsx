/**
 * The two hero image panels that show a post's visual plan (`media_prompt`):
 *  - `InstagramVisual`: a true 1:1 square, violet -> pink -> orange, "VISUAL PLAN" label, "1/1" carousel pill.
 *  - `LinkedInVisual`: a 1.91:1 banner (LinkedIn's image ratio), theme colour -> pink, flush with the card edges.
 * Both measure themselves and hand `PlanText` an exact text box, so the plan is auto-sized to fit and never clipped.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { DIAG } from './parts';
import { PILL_H, PLAN_ORANGE, PLAN_PINK, Pill, PlanLabel, PlanText, clamp, deepen, useSide } from './visual-plan';

export interface VisualProps {
  /** The visual plan (`media_prompt`). */
  plan: string;
  /** Theme colour: the gradient starts from it. */
  accentColor: string;
  /** Tapping the plan edits it in place. */
  editable: boolean;
  /** Shorter panel for list cards: the plan is clamped with an ellipsis instead of scrolling. */
  compact: boolean;
  onChangePlan?: (text: string) => void;
}

const SHADE = 'rgba(26, 11, 58, 0)';
const SHADE_DEEP = 'rgba(26, 11, 58, 0.34)';
const SHADE_SOFT = 'rgba(26, 11, 58, 0.22)';
const IG_COMPACT_MAX_HEIGHT = 220;

/** Instagram: square image whose content is the visual plan. */
export function InstagramVisual({ plan, accentColor, editable, compact, onChangePlan }: VisualProps) {
  const [side, onLayout] = useSide();
  const ratio = compact ? 16 / 9 : 1;
  const height = compact ? Math.min(side / ratio, IG_COMPACT_MAX_HEIGHT) : side;
  const padX = compact ? 16 : clamp(Math.round(side * 0.067), 20, 40);
  const padTop = compact ? 12 : clamp(Math.round(side * 0.045), 14, 26);
  const padBottom = compact ? 12 : clamp(Math.round(side * 0.06), 18, 34);
  const gap = compact ? 8 : 14;
  const textW = Math.max(40, side - 2 * padX);
  const textH = Math.max(PILL_H, height - padTop - PILL_H - gap - padBottom);
  const show = editable || plan.trim().length > 0;

  return (
    <View
      style={[styles.frame, { aspectRatio: ratio }, compact && styles.igCompact]}
      onLayout={onLayout}
      testID="visual-plan-instagram"
    >
      <LinearGradient
        colors={[deepen(accentColor), PLAN_PINK, PLAN_ORANGE]}
        locations={[0, 0.55, 1]}
        {...DIAG}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={[SHADE, SHADE_DEEP]}
        start={{ x: 0.5, y: 0.2 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.circle, styles.igBig]} />
      <View style={[styles.circle, styles.igLow]} />
      <View style={[styles.circle, styles.igRing]} />
      <View style={[styles.circle, styles.igDot]} />

      <View style={[StyleSheet.absoluteFill, { paddingHorizontal: padX, paddingTop: padTop, paddingBottom: padBottom }]}>
        <View style={[styles.topRow, { marginBottom: gap }]}>
          {show ? <PlanLabel editable={editable} /> : <View />}
          <Pill decorative>
            <Text style={styles.counter}>1/1</Text>
          </Pill>
        </View>
        <View style={styles.area}>
          {show ? (
            <PlanText
              value={plan}
              editable={editable}
              onChangeText={onChangePlan}
              width={textW}
              height={textH}
              maxSize={compact ? 15 : clamp(Math.round(side * 0.056), 17, 32)}
              minSize={compact ? 12 : clamp(Math.round(side * 0.034), 12, 18)}
              clamp={compact}
              testID="visual-plan-text-instagram"
            />
          ) : (
            <View style={styles.mark} aria-hidden>
              <Ionicons name="sparkles" size={compact ? 30 : 46} color="rgba(255, 255, 255, 0.72)" />
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

/** LinkedIn: 1.91:1 banner under the post text; the link strip (or nothing) sits right below it. */
export function LinkedInVisual({ plan, accentColor, editable, compact, onChangePlan }: VisualProps) {
  const [width, onLayout] = useSide();
  const ratio = compact ? 2.8 : 1.91;
  const height = width / ratio;
  const padX = compact ? 14 : clamp(Math.round(width * 0.056), 18, 36);
  const padTop = compact ? 10 : 14;
  const padBottom = compact ? 10 : 16;
  const gap = compact ? 6 : 10;
  const textW = Math.max(40, width - 2 * padX);
  const textH = Math.max(PILL_H, height - padTop - PILL_H - gap - padBottom);

  return (
    <View style={[styles.frame, { aspectRatio: ratio }]} onLayout={onLayout} testID="visual-plan-linkedin">
      <LinearGradient
        colors={[deepen(accentColor), PLAN_PINK]}
        {...DIAG}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={[SHADE, SHADE_SOFT]}
        start={{ x: 0.5, y: 0.2 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.circle, styles.liBig]} />
      <View style={[styles.circle, styles.liLow]} />

      <View style={[StyleSheet.absoluteFill, { paddingHorizontal: padX, paddingTop: padTop, paddingBottom: padBottom }]}>
        <View style={[styles.topRow, { marginBottom: gap }]}>
          <PlanLabel editable={editable} />
        </View>
        <View style={styles.area}>
          <PlanText
            value={plan}
            editable={editable}
            onChangeText={onChangePlan}
            width={textW}
            height={textH}
            maxSize={compact ? 14 : clamp(Math.round(width * 0.05), 15, 28)}
            minSize={compact ? 12 : clamp(Math.round(width * 0.034), 12, 16)}
            clamp={compact}
            testID="visual-plan-text-linkedin"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', overflow: 'hidden' },
  igCompact: { maxHeight: IG_COMPACT_MAX_HEIGHT },
  topRow: { height: PILL_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // Centres the plan while it is short; the text box inside caps its own height, so a long plan scrolls there.
  area: { flex: 1, minHeight: 0, justifyContent: 'center' },
  mark: { alignItems: 'center' },
  counter: { color: '#ffffff', fontSize: 12, lineHeight: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },

  circle: { position: 'absolute', aspectRatio: 1, borderRadius: 999 },
  igBig: { width: '64%', top: '-16%', right: '-18%', backgroundColor: 'rgba(255, 255, 255, 0.15)' },
  igLow: { width: '50%', bottom: '-20%', left: '-14%', backgroundColor: 'rgba(255, 255, 255, 0.11)' },
  igRing: { width: '24%', bottom: '15%', right: '7%', borderWidth: 2, borderColor: 'rgba(255, 255, 255, 0.2)' },
  igDot: { width: '8%', top: '36%', left: '4%', backgroundColor: 'rgba(255, 255, 255, 0.16)' },
  liBig: { width: '50%', top: '-45%', right: '-6%', backgroundColor: 'rgba(255, 255, 255, 0.14)' },
  liLow: { width: '30%', bottom: '-38%', left: '-4%', backgroundColor: 'rgba(255, 255, 255, 0.1)' },
});
