/**
 * Web stub of the secure vault (same API as `index.ts`). There is no vault on web, on purpose: the web app is where a
 * browser agent (Claude in Chrome) may be working, so no saved login ever exists, is typed or is filled there. Saved
 * logins live only in the phone app (docs/VAULT.md).
 */
import type { Platform } from '@/src/types';

export { canFill, takeVaultFill, type FillMessage, type FillStatus } from './fill';

export const MAX_FIELD = 512;

export interface VaultEntryInfo {
  savedAt: string;
  bio: boolean;
}

export type VaultIndex = Partial<Record<Platform, VaultEntryInfo>>;

export function vaultAvailable(): boolean {
  return false;
}

export async function vaultIndex(): Promise<VaultIndex> {
  return {};
}

export async function hasLogin(_platform: Platform): Promise<boolean> {
  return false;
}

export function biometricsAvailable(): boolean {
  return false;
}

export async function saveLogin(
  _platform: Platform,
  _username: string,
  _password: string,
  _opts?: { bio?: boolean },
): Promise<void> {
  throw new Error('Saved logins live only in the Pulse phone app.');
}

export async function setLoginBio(_platform: Platform, _on: boolean): Promise<void> {
  throw new Error('Saved logins live only in the Pulse phone app.');
}

export async function deleteLogin(_platform: Platform): Promise<void> {}

export async function clearVault(): Promise<void> {}

export async function fillScriptFor(_platform: Platform): Promise<string | null> {
  return null;
}

export function useVaultStatus(): { available: boolean; saved: VaultIndex; loaded: boolean; refresh(): void } {
  return { available: false, saved: {}, loaded: true, refresh: () => undefined };
}
