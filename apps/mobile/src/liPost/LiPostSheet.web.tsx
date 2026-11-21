/** Web build of LiPostSheet.tsx: auto-posting is Android only, and this keeps react-native-webview out of the web bundle. */
export type LiPostOutcome =
  | { ok: true; url: string | null }
  | {
      ok: false;
      stage: string;
      status: number;
      firstStatus: number | null;
      message: string | null;
      firstMessage: string | null;
    }
  | { ok: null; whilePosting: boolean };

export interface LiPostSheetProps {
  text: string;
  onDone: (outcome: LiPostOutcome) => void;
}

export function liAutoPostAvailable(): boolean {
  return false;
}

export function LiPostSheet(_props: LiPostSheetProps) {
  return null;
}
