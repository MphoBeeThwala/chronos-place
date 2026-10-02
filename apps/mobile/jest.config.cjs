/** Screen tests: React Native rendering under jest-expo. Pure TypeScript tests (tests/*.test.ts) run under Vitest. */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/tests/**/*.spec.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transformIgnorePatterns: [
    'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-safe-area-context|react-native-screens|@chronos/ui))',
  ],
};
