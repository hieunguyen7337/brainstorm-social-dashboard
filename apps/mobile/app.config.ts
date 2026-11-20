import type { ConfigContext, ExpoConfig } from 'expo/config';

// Display name: APP_NAME (default "Pulse"), mirroring the API's APP_NAME setting.
const APP_NAME = process.env.APP_NAME || process.env.EXPO_PUBLIC_APP_NAME || 'Pulse';
const BG = '#0b1020';
// Set by EAS (eas init) or the lead; the OTA updates url is derived from it and omitted when unset.
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID;

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
    output: 'single',
    favicon: './assets/favicon.png',
    name: APP_NAME,
    shortName: APP_NAME,
    description: 'Automated social media manager: dashboard, trends, AI posts, autopilot.',
    themeColor: BG,
    backgroundColor: BG,
  },
  plugins: [
    'expo-router',
    'expo-font',
    'expo-asset',
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
