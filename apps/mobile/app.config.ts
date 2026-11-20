import type { ConfigContext, ExpoConfig } from 'expo/config';

// Display name: APP_NAME (default "Pulse"), mirroring the API's APP_NAME setting.
const APP_NAME = process.env.APP_NAME || process.env.EXPO_PUBLIC_APP_NAME || 'Pulse';
const BG = '#0b1020';
// Set by EAS (eas init) or the lead; the OTA updates url is derived from it and omitted when unset.
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID ?? '2d758915-1983-489f-8518-5b107fca5af3';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: APP_NAME,
  slug: 'pulse-hackathon',
  owner: 'hieunguyen7337',
  scheme: 'pulse',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  backgroundColor: BG,
  runtimeVersion: { policy: 'appVersion' },
  ...(EAS_PROJECT_ID
    ? {
        updates: { url: `https://u.expo.dev/${EAS_PROJECT_ID}` },
      }
    : {}),
  assetBundlePatterns: ['**/*'],
  ios: {
    bundleIdentifier: 'app.pulse.hackathon',
    supportsTablet: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: 'app.pulse.hackathon',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: BG,
    },
  },
  web: {
    bundler: 'metro',
    // 'single' = one index.html shell (the API's SPA fallback); app/+html.tsx is not used, public/index.html is.
    // PULSE_WEB_OUTPUT=static pre-renders every route to its own HTML (first paint without JS) and uses app/+html.tsx;
    // see docs/PERF.md before switching (the e2e static server needs a one-line change).
    output: process.env.PULSE_WEB_OUTPUT === 'static' ? 'static' : 'single',
    favicon: './assets/favicon.png',
    name: APP_NAME,
    shortName: APP_NAME,
    description: 'Automated social media manager: dashboard, trends, AI posts, autopilot.',
    themeColor: BG,
    backgroundColor: BG,
  },
  plugins: [
    // Web: every route is its own lazy chunk, so a cold start downloads the shell plus the route it lands on instead of
    // all five tabs. 'production' leaves `expo start` and native builds on the normal synchronous route table.
    ['expo-router', { asyncRoutes: { web: 'production', default: false } }],
    'expo-font',
    'expo-asset',
    [
      // "Upload a screenshot" (docs/REAL.md). Photos only: no camera, no microphone. Native builds made before this plugin
      // existed have no image-picker module; the app detects that at call time (src/pickImage.ts) and opens the web upload
      // page instead, so an OTA update on the installed 1.0.0 APK never crashes. The version stays 1.0.0 on purpose.
      'expo-image-picker',
      {
        photosPermission: `${APP_NAME} reads the screenshots you choose to find your follower and view counts.`,
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: BG,
      },
    ],
  ],
  extra: {
    ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
  },
});
