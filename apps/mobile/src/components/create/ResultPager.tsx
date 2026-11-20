import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from 'react-native';

import { colors, platformMeta, space } from '@/src/theme';
import type { Post } from '@/src/types';
import { IconButton, haptic } from '@/src/ui';

import { clamp } from './logic';
import { PlatformTabs } from './PlatformTabs';

export interface ResultPagerProps {
  posts: Post[];
  /** The selected page. The pager keeps the chips, the cards and the dots in step and reports changes. */
  index: number;
  onIndexChange: (index: number) => void;
  dirtyIds: ReadonlySet<string>;
  /** The card for one post. */
  renderPage: (post: Post) => ReactNode;
}

const DOT = 8;
const DOT_ACTIVE = 22;

function Dot({ active, color, label, onPress }: { active: boolean; color: string; label: string; onPress: () => void }) {
  const width = useRef(new Animated.Value(active ? DOT_ACTIVE : DOT)).current;
  useEffect(() => {
    Animated.timing(width, { toValue: active ? DOT_ACTIVE : DOT, duration: 180, useNativeDriver: false }).start();
  }, [active, width]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      hitSlop={8}
      onPress={onPress}
      style={styles.dotHit}
    >
      <Animated.View style={[styles.dot, { width, backgroundColor: active ? color : colors.borderHi }]} />
    </Pressable>
  );
}

/** Page dots, with prev/next arrows on web (swiping is awkward with a mouse). */
function PagerDots({ posts, index, onSelect }: { posts: Post[]; index: number; onSelect: (i: number) => void }) {
  const web = Platform.OS === 'web';
  if (posts.length < 2) return null;
  return (
    <View style={styles.dotsRow}>
      {web ? (
        <IconButton icon="chevron-back" label="Previous post" disabled={index <= 0} onPress={() => onSelect(index - 1)} />
      ) : null}
      <View style={styles.dots}>
        {posts.map((p, i) => (
          <Dot
            key={p.id}
            active={i === index}
            color={platformMeta[p.platform].color}
            label={`Show the ${platformMeta[p.platform].label} post`}
            onPress={() => onSelect(i)}
          />
        ))}
      </View>
      {web ? (
        <IconButton
          icon="chevron-forward"
          label="Next post"
          disabled={index >= posts.length - 1}
          onPress={() => onSelect(index + 1)}
        />
      ) : null}
    </View>
  );
}

/**
 * Platform chips + a horizontally paged set of cards + page dots, all kept in step:
 *  - tapping a chip, a dot or an arrow animates the pager to that card;
 *  - swiping the pager moves the selected chip (and scrolls the chip strip to it);
 *  - the pager is as tall as the card on screen (it morphs between cards of different heights while swiping).
 */
export function ResultPager({ posts, index, onIndexChange, dirtyIds, renderPage }: ResultPagerProps) {
  const count = posts.length;
  const [pageW, setPageW] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>({});

  const scroller = useRef<ScrollView>(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  /** The page the scroller is on (or animating to). Lets scroll events be told apart from our own scrolls. */
  const shown = useRef(index);
  /** Set while a programmatic scroll is animating, so its in-between offsets don't select other chips. */
  const heading = useRef<number | null>(null);
  const headingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToPage = (page: number, animated: boolean) => {
    scroller.current?.scrollTo({ x: page * pageW, y: 0, animated });
  };

  const goTo = (target: number) => {
    const next = clamp(target, 0, count - 1);
    if (pageW <= 0 || next === shown.current) return;
    shown.current = next;
    heading.current = next;
    if (headingTimer.current) clearTimeout(headingTimer.current);
    // Safety net in case the animation is interrupted before it lands.
    headingTimer.current = setTimeout(() => {
      heading.current = null;
    }, 900);
    scrollToPage(next, true);
    onIndexChange(next);
  };

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (pageW <= 0 || count === 0) return;
    const x = e.nativeEvent.contentOffset.x;
    if (heading.current !== null) {
      if (Math.abs(x - heading.current * pageW) <= 2) heading.current = null;
      return;
    }
    const page = clamp(Math.round(x / pageW), 0, count - 1);
    if (page !== shown.current) {
      shown.current = page;
      haptic.select();
      onIndexChange(page);
    }
  };

  // `Animated.event` is created once; it always calls the latest handler.
  const handlerRef = useRef(handleScroll);
  handlerRef.current = handleScroll;
  const onScroll = useMemo(
    () =>
      Animated.event<NativeScrollEvent>([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
        useNativeDriver: false,
        listener: (e) => handlerRef.current(e),
      }),
    [scrollX],
  );

  // The parent moved the selection (a discarded card, say): follow it without animating.
  useEffect(() => {
    if (pageW <= 0 || shown.current === index) return;
    shown.current = index;
    scrollToPage(index, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, pageW]);

  // The column was resized (rotation, desktop window): keep the same card in view.
  useEffect(() => {
    if (pageW > 0) scrollToPage(shown.current, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageW]);

  useEffect(
    () => () => {
      if (headingTimer.current) clearTimeout(headingTimer.current);
    },
    [],
  );

  const onPageHeight = useCallback((id: string, h: number) => {
    setHeights((prev) => (Math.abs((prev[id] ?? -1) - h) < 0.5 ? prev : { ...prev, [id]: h }));
  }, []);

  // Height of the pager: the card's own height; interpolated by scroll position when the cards differ.
  const heightStyle = useMemo(() => {
    if (pageW <= 0 || count === 0) return undefined;
    const hs = posts.map((p) => heights[p.id] ?? 0);
    if (hs.some((h) => h <= 0)) return undefined;
    const lo = Math.min(...hs);
    const hi = Math.max(...hs);
    if (count === 1 || hi - lo < 2) return { height: hi };
    return {
      height: scrollX.interpolate({
        inputRange: hs.map((_, i) => i * pageW),
        outputRange: hs,
        extrapolate: 'clamp',
      }),
    };
  }, [posts, heights, pageW, count, scrollX]);

  return (
    <View style={styles.root}>
      <PlatformTabs posts={posts} index={index} dirtyIds={dirtyIds} onSelect={goTo} />
      <View
        style={styles.pager}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          setPageW((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
        }}
      >
        {pageW > 0 ? (
          <Animated.ScrollView
            ref={scroller}
            horizontal
            pagingEnabled
            bounces={false}
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={16}
            onScroll={onScroll}
            onScrollBeginDrag={() => {
              heading.current = null;
            }}
            style={heightStyle}
            contentContainerStyle={styles.content}
          >
            {posts.map((p) => (
              <View
                key={p.id}
                style={{ width: pageW }}
                onLayout={(e) => onPageHeight(p.id, e.nativeEvent.layout.height)}
              >
                {renderPage(p)}
              </View>
            ))}
          </Animated.ScrollView>
        ) : null}
      </View>
      <PagerDots posts={posts} index={index} onSelect={goTo} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.md },
  pager: { width: '100%' },
  // Pages keep their natural height (the scroller's own height is set from the active card).
  content: { alignItems: 'flex-start' },
  dotsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.md },
  dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  dotHit: { height: 24, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center' },
  dot: { height: DOT, borderRadius: DOT / 2 },
});
