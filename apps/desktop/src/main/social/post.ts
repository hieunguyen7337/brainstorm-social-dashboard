/**
 * The Instagram poster (docs/DESKTOP.md 4.5): the Android flow of `igPost/device.ts` in a hidden Instagram window.
 * The photo goes into the page in chunks, then `buildIgPostScript` uploads it and publishes it with the caption through
 * the person's own signed-in session. Only ever called after the in-app confirmation. Never retries.
 *
 * Value imports from `@/` live in `mcp/index.ts` and arrive as `logic`, so this module runs under plain Node in tests.
 * Nothing here logs or returns a cookie, token or the image.
 */
import type { WebContents } from 'electron';
import type * as IgLogic from '@/src/igPost/logic';
import type { SocialService } from './service.ts';

export type PostOutcome =
  | { ok: true; code: string | null; url: string | null }
  | { ok: false; stage: string; text: string };

export interface PostRequest {
  caption: string;
  imageBase64: string;
  mediaType: 'image/jpeg' | 'image/png';
}

export interface PosterOptions {
  /** PNG to JPEG (the upload endpoint takes JPEG); only called for PNG. */
  toJpeg?: (png: Buffer) => Buffer | null;
  /** How long to wait for the signed-in, settled page before giving up. */
  readyMs?: number;
  probeMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

type PageWc = Pick<WebContents, 'executeJavaScript' | 'isDestroyed'>;

/** Width and height of a JPEG or PNG, or null when the bytes are neither (or truncated). */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

const fail = (stage: string, text: string): PostOutcome => ({ ok: false, stage, text });

/** What Claude (and the person) read when posting failed. Nothing is retried automatically. */
export function failureText(stage: string, status: number): string {
  switch (stage) {
    case 'signed-out':
      return 'Instagram needs the person to sign in again: ask them to press Connect with Instagram in Pulse.';
    case 'image':
      return "The photo didn't reach Instagram whole. Nothing was posted; the person can try again.";
    case 'timeout':
      return "Instagram didn't answer. It may or may not have posted: ask the person to check their profile before trying again.";
    case 'upload':
    case 'configure':
      if (status === 401 || status === 403) return 'Instagram refused the post from here. Nothing was posted.';
      if (status === 429) return 'Instagram says to slow down. Nothing was posted; try again later.';
      return `Instagram refused the post (${stage}${status ? ` ${status}` : ''}). Nothing was posted.`;
    default:
      return "Couldn't post to Instagram from here. Nothing was posted.";
  }
}

export function createInstagramPoster(
  social: Pick<SocialService, 'runTask' | 'onPageMessage'>,
  logic: typeof IgLogic,
  opts: PosterOptions = {},
): (req: PostRequest) => Promise<PostOutcome> {
  const readyMs = opts.readyMs ?? 30_000;
  const probeMs = opts.probeMs ?? logic.IG_PROBE_MS;
  const timeoutMs = opts.timeoutMs ?? logic.IG_POST_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  const run = (wc: PageWc, image: Buffer, caption: string, size: { width: number; height: number }) =>
    new Promise<PostOutcome>((resolve) => {
      let started = false;
      let movedHome = false;
      let settled = false;
      const timers: NodeJS.Timeout[] = [];
      let off: () => void = () => undefined;
      const finish = (o: PostOutcome): void => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        clearInterval(probe);
        off();
        resolve(o);
      };
      const exec = (js: string): Promise<unknown> =>
        wc.isDestroyed() ? Promise.reject(new Error('gone')) : wc.executeJavaScript(js);

      const b64 = image.toString('base64');
      const start = async (): Promise<void> => {
        if (started) return;
        started = true;
        clearInterval(probe);
        clearTimeout(ready);
        timers.push(setTimeout(() => finish(fail('timeout', failureText('timeout', 0))), timeoutMs));
        try {
          const chunks = logic.imageChunkScripts(b64);
          const script = logic.buildIgPostScript({
            uploadId: logic.newUploadId(now()),
            width: size.width,
            height: size.height,
            bytes: image.length,
            b64Length: b64.length,
            caption,
          });
          for (const c of chunks) await exec(c);
          await exec(script);
        } catch {
          finish(fail('image', failureText('image', 0)));
        }
      };

      off = social.onPageMessage(wc as WebContents, (raw) => {
        const m = logic.parseIgMessage(raw);
        if (!m || settled) return;
        if (m.kind === 'result') {
          if (!started) return; // only the script we sent can answer
          if (m.ok) finish({ ok: true, code: m.code, url: logic.igPostUrl(m.code) });
          else finish(fail(m.stage, failureText(m.stage, m.status)));
          return;
        }
        if (started || !m.onIg) return;
        if (!m.signedIn) {
          finish(fail('signed-out', failureText('signed-out', 0)));
          return;
        }
        if (!m.settled) {
          // Signed in but on a page that navigates on by itself: go to the feed first, once.
          if (!movedHome) {
            movedHome = true;
            exec(`location.href = ${JSON.stringify(`${logic.IG_HOME_URL}?pulse=1`)};true;`).catch(() => undefined);
          }
          return;
        }
        void start();
      });

      const ask = (): void => void exec(logic.IG_STATE_PROBE_JS).catch(() => undefined);
      const probe = setInterval(ask, probeMs);
      const ready = setTimeout(() => {
        if (!started) finish(fail('page', "Instagram didn't load. Nothing was posted."));
      }, readyMs);
      timers.push(ready);
      ask();
    });

  return async (req) => {
    try {
      let image: Buffer = Buffer.from(req.imageBase64, 'base64');
      if (req.mediaType === 'image/png') {
        const jpeg = opts.toJpeg?.(image) ?? null;
        if (!jpeg) return fail('image', 'Instagram needs a JPEG photo. Nothing was posted.');
        image = jpeg;
      }
      if (image.length === 0 || image.length > logic.IG_MAX_BYTES) return fail('image', failureText('image', 0));
      const size = imageSize(image);
      if (!size) return fail('image', failureText('image', 0));
      const problem = logic.igImageProblem({ ...size, bytes: image.length });
      if (problem) return fail('image', `${problem} Nothing was posted.`);
      return await social.runTask('instagram', { url: logic.IG_HOME_URL, visible: false }, (wc) =>
        run(wc, image, req.caption, size),
      );
    } catch {
      return fail('page', "Couldn't open Instagram. Nothing was posted.");
    }
  };
}
