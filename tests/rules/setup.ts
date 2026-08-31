// Jest globalSetup wiring. Node 20 has fetch as a global but Jest
// running the CJS ts-jest transform in some environments doesn't
// expose it inside the test VM. @firebase/rules-unit-testing calls
// fetch during emulator discovery, so we polyfill unconditionally
// here — harmless if fetch is already defined.
import 'cross-fetch/polyfill';
