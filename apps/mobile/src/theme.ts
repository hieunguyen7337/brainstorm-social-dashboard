/** Design tokens. Dark, vibrant: deep navy canvas, violet -> pink accent, platform brand colours for series. */
import type { TextStyle } from 'react-native';

import type { Platform } from './types';

export const colors = {
  bg: '#0b1020',
  card: '#141a2e',
  cardHi: '#1b2340', // raised surface inside a card (inputs, chips)
  border: '#232b47',
  borderHi: '#35406a',
  text: '#f4f6ff',
  textDim: '#a8b0cf',
  textMute: '#6f7899',
  accent: '#7c5cff', // violet
  accent2: '#ff5c8a', // pink
  success: '#2fe0a3',
  warn: '#ffb648',
  danger: '#ff5d73',
  info: '#4cc3ff',
  overlay: 'rgba(5, 8, 20, 0.72)',
  white: '#ffffff',
} as const;

/** expo-linear-gradient props for the signature accent. */
export const gradient = {
  colors: [colors.accent, colors.accent2] as readonly [string, string],
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
} as const;

export const radius = { sm: 10, md: 16, lg: 22, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Text styles (system font; weight and tracking carry the personality). */
export const type = {
  hero: { fontSize: 38, fontWeight: '800', letterSpacing: -1, color: colors.text, lineHeight: 42 } as TextStyle,
  h1: { fontSize: 28, fontWeight: '800', letterSpacing: -0.6, color: colors.text } as TextStyle,
  h2: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, color: colors.text } as TextStyle,
  h3: { fontSize: 16, fontWeight: '700', color: colors.text } as TextStyle,
  body: { fontSize: 15, lineHeight: 22, color: colors.text } as TextStyle,
  dim: { fontSize: 14, lineHeight: 20, color: colors.textDim } as TextStyle,
  small: { fontSize: 12.5, lineHeight: 17, color: colors.textDim } as TextStyle,
  label: {
    fontSize: 11.5,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.textMute,
  } as TextStyle,
  mono: { fontFamily: 'monospace', fontSize: 12.5, lineHeight: 18, color: colors.text } as TextStyle,
};

export interface PlatformMeta {
  label: string;
  /** Brand colour used for chips, chart series and borders. */
  color: string;
  /** Font Awesome 6 brand glyph name (used through `PlatformIcon`). */
  icon: string;
  /** Soft guidance for the editor's character counter. */
  maxChars: number;
}

export const platformMeta: Record<Platform, PlatformMeta> = {
  linkedin: { label: 'LinkedIn', color: '#0a66c2', icon: 'linkedin-in', maxChars: 3000 },
  instagram: { label: 'Instagram', color: '#e1306c', icon: 'instagram', maxChars: 2200 },
  x: { label: 'X', color: '#e7e9ea', icon: 'x-twitter', maxChars: 280 },
  tiktok: { label: 'TikTok', color: '#25f4ee', icon: 'tiktok', maxChars: 2200 },
  reddit: { label: 'Reddit', color: '#ff4500', icon: 'reddit-alien', maxChars: 10000 },
  facebook: { label: 'Facebook', color: '#1877f2', icon: 'facebook-f', maxChars: 5000 },
};

/** Brand-colour text/icon on a coloured fill (X and TikTok are light colours). */
export const onPlatformColor = (p: Platform): string =>
  p === 'x' || p === 'tiktok' ? '#0b1020' : '#ffffff';

/** `#rrggbb` + alpha (0..1) -> `rgba(...)`. Falls back to the input for non-hex strings. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const trendSourceMeta = {
  hackernews: { label: 'Hacker News', color: '#ff6600', icon: 'hacker-news' },
  reddit: { label: 'Reddit r/popular', color: '#ff4500', icon: 'reddit-alien' },
  google: { label: 'Google Trends AU', color: '#4cc3ff', icon: 'google' },
} as const;

/** Theme swatches offered when creating or recolouring a content pillar. */
export const swatches = [
  '#7c5cff',
  '#ff5c8a',
  '#2fe0a3',
  '#ffb648',
  '#4cc3ff',
  '#ff7a45',
  '#c36bff',
  '#6ee7f9',
] as const;
