import { ScrollViewStyleReset } from 'expo-router/html';
import type { ReactNode } from 'react';

// Root HTML shell for the web build (expo-router static rendering). Web only, and it renders in Node at build time:
// no DOM, no window. Env vars are spelled out literally so Metro inlines them (same pattern as src/config.ts).
// NOTE: Expo only uses this file when `web.output` is "static" or "server". The app ships as a single-page app
// (`web.output: "single"` in app.config.ts), where the shell comes from `public/index.html` instead. Keep the head
// tags and CSS of the two files in sync.
const APP_NAME = process.env.EXPO_PUBLIC_APP_NAME || 'Pulse';
const BG = '#0b1020';
const DESCRIPTION = 'Automated social media manager: dashboard, trends, AI posts, autopilot.';

// Full-height app on a navy canvas (no white flash or overscroll bounce), native-like taps, system font.
const GLOBAL_CSS = `
html, body, #root { height: 100%; }
html, body {
  background-color: ${BG};
  overscroll-behavior: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
body {
  color: #f4f6ff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif,
    'Apple Color Emoji', 'Segoe UI Emoji';
}
/* iOS Safari zooms the page when a focused field is under 16px; keep every touch-device field at 16px. */
@media (pointer: coarse) {
  input, textarea, select { font-size: 16px !important; }
}
`;

export default function Root({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover lets the app paint under the notch; zoom stays enabled for accessibility. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{APP_NAME}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta name="theme-color" content={BG} />
        <meta name="color-scheme" content="dark" />

        {/* Installed-PWA behaviour: standalone window, translucent status bar over the navy canvas. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content={APP_NAME} />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" href="/favicon.png" />

        {/* react-native-web root reset (full-height root, no body scroll), then ours on top. */}
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
