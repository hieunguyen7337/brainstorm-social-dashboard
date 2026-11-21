import { isLivePlatform } from '@/src/platforms';
import { FacebookPreview } from './FacebookPreview';
import { InstagramPreview } from './InstagramPreview';
import { LinkedInPreview } from './LinkedInPreview';
import { RedditPreview } from './RedditPreview';
import { TikTokPreview } from './TikTokPreview';
import { XPreview } from './XPreview';
import type { PreviewProps } from './types';

/** Platform-native post card for `props.platform`; every prop is passed straight through. */
export function PostPreview(props: PreviewProps) {
  if (!isLivePlatform(props.platform)) return null; // "coming soon": no preview is reachable
  switch (props.platform) {
    case 'x':
      return <XPreview {...props} />;
    case 'linkedin':
      return <LinkedInPreview {...props} />;
    case 'instagram':
      return <InstagramPreview {...props} />;
    case 'tiktok':
      return <TikTokPreview {...props} />;
    case 'reddit':
      return <RedditPreview {...props} />;
    case 'facebook':
      return <FacebookPreview {...props} />;
    default:
      return null; // a platform this build does not know yet: render nothing rather than crash
  }
}
