/** True when an IPC sender frame URL belongs to the bundled Pulse app. Pure: no electron import. */
export function isAppSender(url: string | undefined | null): boolean {
  return typeof url === 'string' && url.startsWith('app://pulse/');
}
