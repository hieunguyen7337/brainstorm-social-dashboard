/**
 * The desktop bridge (docs/DESKTOP.md 4.3): what the Electron preload exposes as `window.pulseDesktop`.
 *
 * Lead-owned contract, shared by both sides: `apps/desktop` imports this file (path alias) for its preload and IPC
 * handlers, and the app reads it through `src/desktop`. Pure types and constants only: no react-native import.
 */
import type { DeviceRead } from '@/src/autoRead/types';
import type { Platform } from '@/src/types';

export type { DeviceRead, Platform };

/** Bumped when the shape below changes in a way the app must check for. */
export const DESKTOP_BRIDGE_VERSION = 1;

/** Platforms whose login + read runs in a desktop session window (every platform with an autoRead flow). */
export const DESKTOP_READ_PLATFORMS: readonly Platform[] = ['instagram', 'linkedin', 'tiktok', 'x', 'reddit', 'facebook'];
/** Platforms `social_publish` can post to (v1: Instagram only). */
export const DESKTOP_PUBLISH_PLATFORMS: readonly Platform[] = ['instagram'];

export interface SocialStatus {
  /** A session cookie for the platform exists (checked by cookie name only; values are never read). */
  signedIn: boolean;
  /** ISO time of the last successful read in this app, or null. */
  lastReadAt: string | null;
}

export type ConnectResult =
  | { ok: true; read: DeviceRead }
  /** `reason` is shown on the card; omitted when the person closed the login window. */
  | { ok: false; reason?: string };

/** One event of a Claude run. `json` is one parsed line of `claude -p --output-format stream-json`. */
export type ClaudeEvent =
  | { type: 'json'; data: unknown }
  | { type: 'stderr'; line: string }
  | { type: 'done'; code: number | null };

export type ClaudeState =
  | { state: 'ready'; version: string; account?: string }
  | { state: 'not_found' }
  | { state: 'signed_out'; version: string }
  | { state: 'too_old'; version: string; minimum: string };

export interface ClaudeRunRequest {
  prompt: string;
  /** Continue this conversation (`--resume`). */
  sessionId?: string;
}

/**
 * The main process asks the app to confirm a real post (`social_publish`). The app shows its own dialog with the account,
 * the caption and a photo picker (Instagram needs a photo), then calls `confirm.respond`. Nothing is posted without it.
 */
export interface PublishConfirmRequest {
  id: string;
  platform: Platform;
  /** The signed-in handle, when known. */
  handle: string | null;
  caption: string;
  pulsePostId: string | null;
}

export type PublishConfirmAnswer =
  | { ok: true; caption: string; imageBase64: string; mediaType: 'image/jpeg' | 'image/png' }
  | { ok: false };

export interface PulseDesktop {
  version: number;
  /** Fly API base (no trailing slash) for the bundled renderer, which is served from `app://pulse/`. */
  apiUrl: string;
  social: {
    status(): Promise<Record<Platform, SocialStatus>>;
    /** First time (or signed out): a visible login window; afterwards a hidden read. One task at a time. */
    connect(platform: Platform): Promise<ConnectResult>;
    /** "Show <Platform>": the signed-in site, visible, until the person closes it. */
    openWindow(platform: Platform): Promise<void>;
    /** Clears that platform's session (or every platform's). */
    signOut(platform?: Platform): Promise<void>;
  };
  claude: {
    status(): Promise<ClaudeState>;
    /** Starts `claude -p`; events arrive through `onEvent`. Rejects when a run is already going. */
    run(req: ClaudeRunRequest): Promise<{ runId: string }>;
    /** Returns an unsubscribe function. */
    onEvent(runId: string, cb: (e: ClaudeEvent) => void): () => void;
    stop(runId: string): Promise<void>;
    /** The person picked the claude binary by hand (saved as CLAUDE_BIN). Returns the new state. */
    chooseBinary(): Promise<ClaudeState>;
  };
  confirm: {
    /** Returns an unsubscribe function. The app mounts one listener (the publish dialog). */
    onRequest(cb: (req: PublishConfirmRequest) => void): () => void;
    respond(id: string, answer: PublishConfirmAnswer): Promise<void>;
  };
  /** The workspace token, so the main process can call the API (screenshot fallback, MCP config). Null on sign-out. */
  setWorkspaceToken(token: string | null): Promise<void>;
}

/** IPC channel names (main <-> preload). */
export const IPC = {
  socialStatus: 'pulse:social:status',
  socialConnect: 'pulse:social:connect',
  socialOpen: 'pulse:social:open',
  socialSignOut: 'pulse:social:signOut',
  claudeStatus: 'pulse:claude:status',
  claudeRun: 'pulse:claude:run',
  claudeEvent: 'pulse:claude:event', // main -> renderer: (runId, ClaudeEvent)
  claudeStop: 'pulse:claude:stop',
  claudeChoose: 'pulse:claude:choose',
  confirmRequest: 'pulse:confirm:request', // main -> renderer: PublishConfirmRequest
  confirmRespond: 'pulse:confirm:respond',
  setToken: 'pulse:token:set',
  /** Social window preload -> main: the reader's `PageMessage` JSON string. */
  pageMessage: 'pulse:social:pageMessage',
} as const;
