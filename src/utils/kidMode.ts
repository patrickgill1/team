// Kid profile mode — no Firebase Auth user is created. The parent's
// uid stays the actor at the auth layer. This module owns:
//   - PIN hashing/verify (SHA-256 client-side; the "safety" is sibling-
//     privacy, not adversarial — bypass just reveals the kid's own view
//     which parent uid already reads at the rules layer)
//   - Per-device dedicated-kid flag (localStorage). Set on a kid's own
//     device by parent tap; cold boot lands in that kid's view.

const DEDICATED_KEY = 'gk.kidMode.dedicatedPlayerId';
const SUPPRESSED_TOKEN_KEY = 'gk.kidMode.suppressedFcmToken';
// Persisted "active kid session" for household devices — survives a
// hard refresh so a kid mid-session isn't dumped back to parent view
// by an accidental reload (pull-to-refresh, iOS background/foreground
// restart, Capgo cold boot, etc). Distinct from DEDICATED_KEY: this
// is a per-user session flag, cleared on explicit exit or when a
// different user signs in on the same device. Stored with the parent
// uid so we can detect the "different user just signed in" case and
// bail out to parent view instead of holding them hostage in a
// previous user's kid dashboard.
const ACTIVE_SESSION_KEY = 'gk.kidMode.activeSession';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function hashPin(playerId: string, pin: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`${playerId}:${pin}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(buf));
}

export async function verifyPin(playerId: string, pin: string, storedHash?: string): Promise<boolean> {
  if (!storedHash) return false;
  const candidate = await hashPin(playerId, pin);
  return candidate === storedHash;
}

/** Kid-mode PIN policy. 4 digits, digits-only. Simple by design —
 *  every-day toggling. Not a password. */
export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

// Per-device dedicated-kid persistence. Set on a kid's own phone from
// the parent's tile "Make this [FirstName]'s device". Cold boot reads
// this and enters kid mode automatically.
export function getDedicatedKidPlayerId(): string | null {
  try {
    return localStorage.getItem(DEDICATED_KEY);
  } catch {
    return null;
  }
}

export function setDedicatedKidPlayerId(playerId: string): void {
  try {
    localStorage.setItem(DEDICATED_KEY, playerId);
  } catch { /* ignore */ }
}

export function clearDedicatedKidPlayerId(): void {
  try {
    localStorage.removeItem(DEDICATED_KEY);
  } catch { /* ignore */ }
}

// Active-kid-session persistence for household devices. Read
// synchronously from the ViewModeContext useState initializer so the
// first render on refresh is already kid view (no parent-view flash).
export interface ActiveKidSession {
  uid: string;
  playerId: string;
  /** ms epoch, informational only — used to detect very-stale
   *  sessions in case we ever add a max-age policy. Not enforced
   *  today; kid sessions persist until explicit PIN exit. */
  ts: number;
}

export function getActiveKidSession(): ActiveKidSession | null {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.uid !== 'string' || typeof parsed?.playerId !== 'string') return null;
    return {
      uid: parsed.uid,
      playerId: parsed.playerId,
      ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
    };
  } catch {
    return null;
  }
}

export function setActiveKidSession(uid: string, playerId: string): void {
  try {
    localStorage.setItem(
      ACTIVE_SESSION_KEY,
      JSON.stringify({ uid, playerId, ts: Date.now() }),
    );
  } catch { /* ignore */ }
}

export function clearActiveKidSession(): void {
  try {
    localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch { /* ignore */ }
}

// Push notification suppression during kid mode. Kid mode is auth-
// transparent (parent uid still), so any push targeting the parent
// still fires on this device — a chat message the parent got popped
// up on Hunter's device while he was in kid mode.
//
// v1 (yank from user.fcmTokens) wasn't enough: the worker's fanout
// evaluates fcmTokens at send time, but stale tokens accumulated
// over multiple app installs / reinstalls can still route to the
// same device via APNs/FCM history. Even after arrayRemove of the
// current token, if a stale entry is still there, iOS delivers the
// push through that legacy route.
//
// v2 (this): invalidate the FCM token AT THE PLATFORM LEVEL via
// FirebaseMessaging.deleteToken(). That kills every APNs/FCM route
// to this device — Apple/Google reject any pending/stale token as
// invalid. Belt-and-suspenders: also arrayRemove the known-current
// token from user.fcmTokens so the doc stays consistent. On exit,
// re-register a fresh token via getToken() and arrayUnion back.
//
// SUPPRESSED_TOKEN_KEY stores the token that WAS on the doc when
// suppression fired, so the doc-side cleanup can proceed even
// after a cold boot. On restore we always mint a fresh token
// rather than reuse the cached one — the cached one is dead
// anyway (deleteToken killed it) so we don't push it back.
export async function suppressPushForKidMode(uid: string): Promise<void> {
  if (!uid) return;
  try {
    const [{ getCurrentPushToken, deleteCurrentPushToken }, { doc, updateDoc, arrayRemove }, { db }] = await Promise.all([
      import('./nativeShell'),
      import('firebase/firestore'),
      import('./firebase'),
    ]);
    const token = await getCurrentPushToken();
    // Kill the token at the FCM level — stops delivery even through
    // stale routes.
    await deleteCurrentPushToken();
    if (token) {
      localStorage.setItem(SUPPRESSED_TOKEN_KEY, token);
      // Doc-level cleanup so the worker fanout doesn't waste time
      // targeting a dead token.
      await updateDoc(doc(db, 'users', uid), { fcmTokens: arrayRemove(token) });
    }
  } catch (err) {
    console.warn('[kid-mode] suppressPush failed', err);
  }
}

export async function restorePushAfterKidMode(uid: string): Promise<void> {
  if (!uid) return;
  // The cached "suppressed" token is dead (deleteToken killed it).
  // Mint a fresh one instead of trying to reuse it. Falls through to
  // registerPushNotifications which does the full permission +
  // getToken + save flow.
  let cachedToken: string | null = null;
  try {
    cachedToken = localStorage.getItem(SUPPRESSED_TOKEN_KEY);
  } catch { /* ignore */ }

  try {
    const [{ registerPushNotifications }, { doc, updateDoc, arrayUnion, arrayRemove }, { db }] = await Promise.all([
      import('./nativeShell'),
      import('firebase/firestore'),
      import('./firebase'),
    ]);
    // Belt-and-suspenders: if the stale cached token somehow
    // reappeared on the doc (e.g. race with a mid-suppression
    // registration), scrub it again. arrayRemove of a token that
    // isn't there is a no-op.
    if (cachedToken) {
      try { await updateDoc(doc(db, 'users', uid), { fcmTokens: arrayRemove(cachedToken) }); } catch { /* ignore */ }
    }
    // Fresh FCM registration + save the new token onto the doc.
    await registerPushNotifications(async (freshToken: string) => {
      try {
        await updateDoc(doc(db, 'users', uid), {
          fcmTokens: arrayUnion(freshToken),
          pushEnabledAt: new Date(),
        });
      } catch (err) {
        console.warn('[kid-mode] restore fresh-token save failed', err);
      }
    });
    try { localStorage.removeItem(SUPPRESSED_TOKEN_KEY); } catch { /* ignore */ }
  } catch (err) {
    console.warn('[kid-mode] restorePush failed', err);
  }
}
