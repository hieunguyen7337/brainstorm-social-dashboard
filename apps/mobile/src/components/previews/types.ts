import type { Platform } from '@/src/types';

/** Props shared by every platform-native preview card. */
export interface PreviewProps {
  platform: Platform;
  content: string;
  /** Without the leading "#". */
  hashtags: string[];
  /** Image / video brief; Instagram and TikTok render it on a gradient placeholder. */
  mediaPrompt: string;
  /** Profile / page display name (the workspace brand name). */
  brandName: string;
  /** Account handle shown on the card, e.g. "@brewandbloom" (from the connection; fall back to the brand). */
  handle: string;
  followers?: number;
  /** Tracked link (absolute). Shown as the card's link / call to action. */
  link?: string | null;
  /** Theme colour, used to tint placeholders. Default accent violet. */
  accentColor?: string;
  /** "Just now", "2h", or a scheduled time. Default "Just now". */
  timeLabel?: string;
  /** When true the card text is editable in place. */
  editable?: boolean;
  onChangeContent?: (text: string) => void;
  onChangeHashtags?: (tags: string[]) => void;
  onChangeMediaPrompt?: (text: string) => void;
  /** Live counters to show in the card's engagement row (published posts). */
  stats?: { views: number; engagements: number; clicks: number; conversions: number } | null;

  // ---- optional additions (the previews unit) ----------------------------------------------------

  /** Shorter card for lists such as the Queue: clamps long text and trims media. Ignored while `editable`. */
  compact?: boolean;
  /** Called when the link card / "link in bio" pill is tapped (e.g. `() => openTrackedLink(post)`).
   *  Without it the link affordance is display-only and never swallows taps meant for the parent. */
  onPressLink?: () => void;
  /** Reddit only: community name without "r/". Default "smallbusiness". */
  subreddit?: string;
}
