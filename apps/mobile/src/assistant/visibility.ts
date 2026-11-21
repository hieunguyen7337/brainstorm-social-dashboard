/** Who gets the Assistant tab: Pulse Desktop (local Claude Code) and the native phone apps (the person's own API key). */
export function assistantTabVisible(o: { desktop: boolean; os: string }): boolean {
  return o.desktop || o.os === 'android' || o.os === 'ios';
}
