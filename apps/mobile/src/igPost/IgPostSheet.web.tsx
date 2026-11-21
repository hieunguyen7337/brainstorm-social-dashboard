/** Web build of IgPostSheet.tsx: auto-posting is Android only, and this keeps react-native-webview out of the web bundle. */
import type { PostPhoto } from './device';

export type IgPostOutcome =
  | { ok: true; url: string | null }
  | { ok: false; stage: string; status: number }
  | { ok: null; whilePosting: boolean };

export interface IgPostSheetProps {
  photo: PostPhoto;
  caption: string;
  onDone: (outcome: IgPostOutcome) => void;
}

export function igAutoPostAvailable(): boolean {
  return false;
}

export function IgPostSheet(_props: IgPostSheetProps) {
  return null;
}
