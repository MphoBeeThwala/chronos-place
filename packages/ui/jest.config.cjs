/** Component tests: React Native rendering under jest-expo. Pure TypeScript tests live in test/*.test.ts (Vitest). */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/test/**/*.spec.tsx'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transformIgnorePatterns: [
    'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-safe-area-context|react-native-screens))',
  ],
};
