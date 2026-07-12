import { initializeApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  indexedDBLocalPersistence,
  type Auth,
} from 'firebase/auth';
import { getFirestore, initializeFirestore, memoryLocalCache, setLogLevel, type Firestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { Capacitor } from '@capacitor/core';
import { debug, debugWarn } from './debug';

// Silence the Firestore SDK's info/warn stream in prod. Transient
// WebChannel/transport 400s during network flaps otherwise spam the
// console with red-ish warnings that read as "the app is broken" to
// non-devs. We still get real errors surfaced via Sentry.
if (process.env.NODE_ENV === 'production') {
  try { setLogLevel('error'); } catch { /* SDK may not expose in older builds */ }
}

debug('Firebase Config Debug:', {
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
    debugWarn('initializeAuth fallback to getAuth:', err);
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
// `localCache: memoryLocalCache()` — in-memory only, no IndexedDB.
//
// We used to use persistentLocalCache for offline support: cached docs
// would render immediately on cold start, and reads worked in dead zones
// at the field. The trade-off cost we discovered tonight: IndexedDB-
// backed Firestore state DOES NOT recover cleanly across a WebView reload
// from CapacitorUpdater. Post-reload, the SDK hangs on every read for
// ~25 seconds (Patrick's logs: 'Attempting to fetch user data for UID'
// repeated three times, then the 25s auth safety timer fires). That
// blocks the auto-reload-on-OTA experience entirely, because parents
// land on a 25s spinner then a forced sign-out.
//
// Patrick: 'why would you need offline chat?' Fair — soccer parents
// check the app at home, in the car, at the field. They always have
// signal. The 'offline at the field' case is a Firestore best-practice
// that doesn't match real usage. Trading offline support for a working
// auto-reload-on-OTA experience is the right deal.
//
// Cold-start render speed will be SLIGHTLY worse without the cache
// (one network round-trip instead of cache-hit), but the WebView's
// JS bundle is already cached locally and most data is small — the
// hit is in the tens of milliseconds, not hundreds.
const firestoreSettings = {
  experimentalForceLongPolling: isNative,
  ignoreUndefinedProperties: true,
  localCache: memoryLocalCache(),
};
try {
  dbInstance = initializeFirestore(app, firestoreSettings as any);
} catch (err) {
  debugWarn('initializeFirestore fallback to getFirestore:', err);
  dbInstance = getFirestore(app);
}
export const db = dbInstance;

export const storage = getStorage(app);

debug('Firebase Storage initialized with bucket:', firebaseConfig.storageBucket, '| native:', isNative);

export default app;
