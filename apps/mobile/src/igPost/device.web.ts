/** Web build of `device.ts`: the Instagram photo flow is Android only, so nothing here is ever called on web. */
export interface PostPhoto {
  uri: string;
  base64: string;
  width: number;
  height: number;
}

export type PhotoResult =
  | { status: 'ok'; photo: PostPhoto }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

export async function pickPostPhoto(): Promise<PhotoResult> {
  return { status: 'unavailable' };
}

export function canSharePhoto(): boolean {
  return false;
}

export async function sharePhoto(_uri: string): Promise<boolean> {
  return false;
}

export async function openInstagramApp(): Promise<boolean> {
  return false;
}
