/**
 * Which platforms are live in Pulse and which are "coming soon". The app's single source of truth.
 * Mirrors `apps/api/app/platforms.py`: to flip a platform live, move its name from UPCOMING_PLATFORMS to
 * LIVE_PLATFORMS here (one line) and do the same in the API file. Every screen follows these two lists.
 */
import type { Platform } from './types';

export const LIVE_PLATFORMS: readonly Platform[] = ['linkedin', 'instagram'];
export const UPCOMING_PLATFORMS: readonly Platform[] = ['x', 'tiktok', 'facebook', 'reddit'];

const NAMES: Record<Platform, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  x: 'X',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  reddit: 'Reddit',
};

export const isLivePlatform = (p: string): p is Platform => (LIVE_PLATFORMS as readonly string[]).includes(p);
export const isUpcomingPlatform = (p: string): boolean => (UPCOMING_PLATFORMS as readonly string[]).includes(p);
export const platformName = (p: Platform): string => NAMES[p];
/** "X is coming soon to Pulse" (the same wording the API refuses with). */
export const comingSoonReason = (p: Platform): string => `${NAMES[p]} is coming soon to Pulse`;
/** "Coming soon: X, TikTok, Facebook, Reddit" or '' when nothing is upcoming. */
export const comingSoonLine = (): string =>
  UPCOMING_PLATFORMS.length ? `Coming soon: ${UPCOMING_PLATFORMS.map((p) => NAMES[p]).join(', ')}` : '';
