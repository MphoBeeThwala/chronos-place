import type { ExpoConfig } from 'expo/config';

/**
 * Provisional identifiers: the name, icon and bundle id change when branding is final (the PRD also
 * calls for a neutral name and icon option so the app is not identifiable on a lock screen).
 * Over-the-air updates are off: `expo-updates` contacts Expo's servers and needs an ADR first (ADR-0017).
 */
const config: ExpoConfig = {
  name: 'Chronos Place',
  slug: 'chronos-place',
  scheme: 'chronosplace',
  version: '0.0.1',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: { bundleIdentifier: 'com.chronosplace.app', supportsTablet: false },
  android: {
    package: 'com.chronosplace.app',
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#FFF8F2' },
  },
  plugins: [
    'expo-router',
    'expo-localization',
    [
      'expo-splash-screen',
      { image: './assets/splash-icon.png', imageWidth: 200, backgroundColor: '#FFF8F2' },
    ],
  ],
  experiments: { typedRoutes: true },
};

export default config;
