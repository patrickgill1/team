module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/**/*.test.ts'],
  setupFiles: ['<rootDir>/setup.ts'],
  // The rules test env talks to a live Firestore emulator over TCP;
  // give each canonical test room without stalling CI when the
  // emulator's cold.
  testTimeout: 15_000,
};
