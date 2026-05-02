// @ts-nocheck
/**
 * Push notification helper (Firebase Cloud Messaging, Web Push).
 *
 * Setup:
 *   1. In Firebase console → Project settings → Cloud Messaging → Web Push certificates,
 *      generate a key pair. Copy the public key (VAPID) into REACT_APP_FCM_VAPID_KEY.
 *   2. Edit /public/firebase-messaging-sw.js and replace the REPLACE_WITH_* values
 *      with the real Firebase web config (same as src/utils/firebase.ts).
 *   3. (Optional) On the worker side, set FCM_SERVICE_ACCOUNT secret with the JSON
 *      of a Firebase service account that has the firebasecloudmessaging.messages
 *      permission, then use POST /send-push.
 */

import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';
import { doc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import app, { db } from './firebase';

const VAPID_KEY = (process.env.REACT_APP_FCM_VAPID_KEY || '').trim();

let _registered = false;
let _messagingInst = null;

async function getMessagingSafe() {
  if (_messagingInst) return _messagingInst;
  try {
    const supported = await isSupported();
    if (!supported) return null;
    _messagingInst = getMessaging(app);
    return _messagingInst;
  } catch (e) {
    console.warn('[push] messaging unsupported', e);
    return null;
  }
}

/** Get current notification permission. Does not prompt. */
export function getNotifPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

/**
 * Ask the browser for notification permission, register the SW, get an FCM
 * token, and persist it on the user document. Idempotent.
 */
export async function enablePushForUser(userId) {
  if (!userId) return { ok: false, error: 'no-user' };
  if (typeof Notification === 'undefined') return { ok: false, error: 'unsupported' };
  if (!VAPID_KEY) return { ok: false, error: 'no-vapid-key' };

  const messaging = await getMessagingSafe();
  if (!messaging) return { ok: false, error: 'unsupported' };

  // Ask permission
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, error: 'denied', permission: perm };

  // Register the SW (CRA serves /firebase-messaging-sw.js)
  const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');

  let token;
  try {
    token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: reg,
    });
  } catch (e) {
    console.warn('[push] getToken failed', e);
    return { ok: false, error: 'token-failed', detail: String(e) };
  }
  if (!token) return { ok: false, error: 'no-token' };

  try {
    await updateDoc(doc(db, 'users', userId), {
      fcmTokens: arrayUnion(token),
      pushEnabledAt: new Date(),
    });
  } catch (e) {
    console.warn('[push] failed to save token', e);
  }

  // Foreground messages — show a small in-page notification.
  if (!_registered) {
    onMessage(messaging, (payload) => {
      const title = payload?.notification?.title || 'Fire FC16';
      const body = payload?.notification?.body || '';
      try {
        new Notification(title, {
          body,
          icon: payload?.notification?.icon || '/images/logo.png',
        });
      } catch { /* ignore */ }
    });
    _registered = true;
  }

  return { ok: true, token };
}

/** Remove a stored token (e.g. on sign-out or "disable"). */
export async function disablePushForUser(userId, token) {
  if (!userId || !token) return;
  try {
    await updateDoc(doc(db, 'users', userId), { fcmTokens: arrayRemove(token) });
  } catch (e) {
    console.warn('[push] disable failed', e);
  }
}
