/** Turns a capture of the social window into a JPEG that fits the screenshot endpoint (same limits as the Android sheet). */
export interface ImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(opts: { width: number; height: number }): ImageLike;
  toJPEG(quality: number): { length: number; toString(encoding: 'base64'): string };
}

export interface CaptureLimits {
  maxWidth: number;
  quality: number; // 0..1
  retryWidth: number;
  retryQuality: number;
  maxBytes: number;
}

/** JPEG base64 (no data: prefix), width at most `maxWidth`; a second, smaller try when it is too large. */
export function imageToJpegBase64(image: ImageLike, limits: CaptureLimits): string {
  if (image.isEmpty()) throw new Error('empty capture');
  const { width, height } = image.getSize();
  const tries = [
    { width: limits.maxWidth, quality: limits.quality },
    { width: limits.retryWidth, quality: limits.retryQuality },
  ];
  for (const t of tries) {
    const scale = Math.min(1, t.width / Math.max(1, width));
    const img = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : image;
    const jpeg = img.toJPEG(Math.round(t.quality * 100));
    if (jpeg.length > 0 && jpeg.length <= limits.maxBytes) return jpeg.toString('base64');
  }
  throw new Error('capture too large');
}
