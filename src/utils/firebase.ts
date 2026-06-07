import { initializeApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  indexedDBLocalPersistence,
  type Auth,
} from 'firebase/auth';
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, type Firestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { Capacitor } from '@capacitor/core';

// Debug: Log environment variables to check they're loading correctly
console.log('Firebase Config Debug:', {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY ? '***loaded***' : 'missing',
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID ? '***loaded***' : 'missing',
  appId: process.env.REACT_APP_FIREBASE_APP_ID ? '***loaded***' : 'missing'
});

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY?.trim(),
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN?.trim(),
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID?.trim(),
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET?.trim(),
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID?.trim(),
  appId: process.env.REACT_APP_FIREBASE_APP_ID?.trim()
};

// Validate required config
if (!firebaseConfig.storageBucket) {
  console.error('Firebase Storage Bucket is not configured!');
  console.error('Make sure REACT_APP_FIREBASE_STORAGE_BUCKET is set in your .env file');
  throw new Error('Firebase Storage Bucket configuration missing');
}

// Initialize Firebase
const app = initializeApp(firebaseConfig);

const isNative = Capacitor.isNativePlatform();

// Auth: on Capacitor's capacitor://localhost scheme, the default persistence
// heuristic can hang. Force IndexedDB persistence explicitly so sign-in
// resolves the same way it does on web.
let authInstance: Auth;
if (isNative) {
  try {
    authInstance = initializeAuth(app, { persistence: indexedDBLocalPersistence });
  } catch (err) {
    // initializeAuth throws if Auth is already initialized for this app —
    // fall back to getAuth in that case (e.g. HMR / re-imports).
    console.warn('initializeAuth fallback to getAuth:', err);
    authInstance = getAuth(app);
  }
} else {
  authInstance = getAuth(app);
}
export const auth = authInstance;

// Firestore: WebSocket / WebChannel streaming negotiates poorly inside the
// iOS WKWebView. Force long-polling on native so reads/writes don't hang.
let dbInstance: Firestore;
// `ignoreUndefinedProperties` lets us pass through objects that happen
// to have undefined fields (e.g. an optional homeAway on a synthesized
// quick-game event) without setDoc/updateDoc throwing. Without it,
// writes silently fail and the UI shows no feedback — that was the bug
// that made the Quick Game Start button look broken.
//
// `localCache: persistentLocalCache(...)` enables IndexedDB-backed
// offline persistence. Two big wins:
//   1. Cold-start renders cached data immediately (no spinner waiting
//      for the network round-trip) — the "weird refresh loading" the
//      user sees on app open.
//   2. Reads work offline. If the parent's phone is in a dead zone at
//      the field, the team list / schedule / chat still load.
// multiTabManager handles the rare case where a coach opens the web
// version in two browser tabs without trashing the cache.
const firestoreSettings = {
  experimentalForceLongPolling: isNative,
  ignoreUndefinedProperties: true,
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
};
try {
  dbInstance = initializeFirestore(app, firestoreSettings as any);
} catch (err) {
  console.warn('initializeFirestore fallback to getFirestore:', err);
  dbInstance = getFirestore(app);
}
export const db = dbInstance;

export const storage = getStorage(app);

// Debug: Log storage bucket info
console.log('Firebase Storage initialized with bucket:', firebaseConfig.storageBucket, '| native:', isNative);

export default app;
