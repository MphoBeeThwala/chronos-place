// Native modules do not exist under Jest; use the official in-memory AsyncStorage mock.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
