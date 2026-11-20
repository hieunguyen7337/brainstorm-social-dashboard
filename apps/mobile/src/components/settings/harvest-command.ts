/**
 * The text users copy out of the "How to sync real stats" sheet: the sync-script command and the example prompt for
 * Claude in Chrome. Pure strings (no React, no imports) so the wording lives in one place.
 */

/**
 * PROVISIONAL: the script name `scripts/harvest.py` and its `--base-url` / `--token` flags are the lead's agreed
 * default, not yet checked against the harvest unit (the script is not in the repo yet). When that unit lands, change
 * the script name and flags HERE only: the sheet, its Copy button and the masked display all build from this template.
 * `{baseUrl}` and `{token}` are filled in by `harvestCommand`.
 */
export const HARVEST_COMMAND_TEMPLATE = 'python3 scripts/harvest.py --base-url {baseUrl} --token {token}';

/**
 * The one-line command to run the sync script against this workspace. A missing token shows as `<token>`.
 * Replacement functions, not strings, so a `$` in a token is never read as a replacement pattern.
 */
export function harvestCommand(baseUrl: string, token: string | null): string {
  return HARVEST_COMMAND_TEMPLATE.replace('{baseUrl}', () => baseUrl).replace('{token}', () => token ?? '<token>');
}

/** First 6 characters, then dots: enough to recognise the token, not enough to use it (same format as the MCP card). */
export function maskSecret(secret: string): string {
  return `${secret.slice(0, 6)}${'•'.repeat(10)}`;
}

/** An example to paste into Claude in Chrome while a LinkedIn or Instagram profile is open in the browser. */
export function claudeChromePrompt(appName: string): string {
  return (
    `On this profile page, read the views, likes and comments for my latest posts, ` +
    `then send those numbers to ${appName} so they show up as real data.`
  );
}
