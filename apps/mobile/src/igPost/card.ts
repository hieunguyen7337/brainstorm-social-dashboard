/**
 * The post as a 1080x1080 JPEG card from the API (`GET /api/posts/{id}/card.jpg`), so "Post to Instagram" needs no photo
 * pick. Plain fetch + FileReader: no native module, so it works as an OTA on shipped APKs. Null on any failure.
 */
import { apiBase, getToken, isMock } from '@/src/http';

import type { PostPhoto } from './device';

export const CARD_SIDE = 1080;

/** "data:image/jpeg;base64,XXXX" -> "XXXX"; null when it is not a JPEG data URL. */
export function jpegBase64(dataUrl: unknown): string | null {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:image\/jpe?g;base64,(.+)$/i.exec(dataUrl);
  return m ? m[1] : null;
}

export async function fetchPostCard(postId: string, timeoutMs = 20000): Promise<PostPhoto | null> {
  const token = getToken();
  if (!postId || !token || isMock()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase()}/api/posts/${encodeURIComponent(postId)}/card.jpg`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    const dataUrl = await new Promise<unknown>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    // RN's FileReader may label the blob without a type; normalise to JPEG.
    const fixed = typeof dataUrl === 'string' ? dataUrl.replace(/^data:[^;,]*;base64,/, 'data:image/jpeg;base64,') : null;
    const base64 = jpegBase64(fixed);
    if (!base64) return null;
    return { uri: fixed as string, base64, width: CARD_SIDE, height: CARD_SIDE };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
