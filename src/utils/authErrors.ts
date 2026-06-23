// Friendly error messages for Firebase Auth + Capacitor Apple/Google
// plugin errors. The raw Firebase strings expose error codes that
// scare users ("auth/missing-or-invalid-nonce", "auth/configuration-not-found"
// etc) — this maps them to plain English with the right next-step
// suggestion (try Sign In, contact support, retry, etc).
//
// Used by SimpleAuth's email / Apple / Google handlers and any
// other surface that catches a Firebase Auth error.

interface FbLikeError {
  code?: string;
  message?: string;
}

export function friendlyAuthError(err: any, source: 'email' | 'apple' | 'google'): string {
  const e: FbLikeError = err || {};
  const code = (e.code || '').toLowerCase();
  const msg = (e.message || '').toLowerCase();

  // ─ Cancellations — silent / friendly ───────────────────────────
  if (
    code === 'cancelled'
    || code === 'cancel'
    || code === 'auth/popup-closed-by-user'
    || code === 'auth/cancelled-popup-request'
    || msg.includes('cancel')
    || msg.includes('user closed')
  ) {
    return 'Sign-in was cancelled.';
  }

  // ─ "You already have an account" family ────────────────────────
  // Apple's nonce-reuse error (this is what the screenshot caught):
  // the user signed in with this Apple ID before. Apple's replay
  // protection rejects the second attempt. Best fix is to send them
  // to Sign In.
  if (
    code === 'auth/missing-or-invalid-nonce'
    || msg.includes('duplicate credential')
    || msg.includes('nonce')
  ) {
    return source === 'apple'
      ? 'It looks like you\'ve already used this Apple ID to sign in. Tap Sign In above instead, or pick "Continue with Apple" from the Sign In side.'
      : 'It looks like this account already exists. Tap Sign In above and try again.';
  }

  if (code === 'auth/email-already-in-use') {
    return 'An account with this email already exists. Tap Sign In above to use it.';
  }

  if (code === 'auth/account-exists-with-different-credential') {
    return 'You already have an account with this email, but it was created a different way (email + password, Google, etc). Try Sign In with that method instead.';
  }

  if (code === 'auth/credential-already-in-use') {
    return 'This account is already linked to another GoalKickr user. Tap Sign In above to use the original account.';
  }

  // ─ Wrong credentials / not found ───────────────────────────────
  if (code === 'auth/user-not-found') {
    return 'We don\'t see an account with this email yet. Tap Sign Up above to create one.';
  }
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials') {
    return 'That email and password don\'t match. Try again, or tap "Forgot password?" below.';
  }
  if (code === 'auth/invalid-email') {
    return 'That email doesn\'t look right. Double-check and try again.';
  }
  if (code === 'auth/weak-password') {
    return 'Pick a stronger password — at least 6 characters, with at least one number is a good rule of thumb.';
  }

  // ─ Provider not enabled in Firebase ────────────────────────────
  if (code === 'auth/configuration-not-found' || msg.includes('identity provider configuration')) {
    return source === 'apple'
      ? 'Sign in with Apple isn\'t available right now. Try Google or email + password.'
      : source === 'google'
        ? 'Sign in with Google isn\'t available right now. Try Apple or email + password.'
        : 'This sign-in method isn\'t available right now. Try a different one.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'This sign-in method isn\'t enabled. Try a different one or contact support.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'This domain isn\'t authorized for sign-in. Contact support@goalkickr.com.';
  }

  // ─ Rate / network ──────────────────────────────────────────────
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts in a row. Wait a minute and try again.';
  }
  if (code === 'auth/network-request-failed' || msg.includes('network')) {
    return 'Network hiccup. Check your connection and try again.';
  }

  // ─ Server / setup ──────────────────────────────────────────────
  if (code === 'permission-denied' || code === 'auth/internal-error') {
    return 'Something went wrong on our end. Try again in a moment, or email support@goalkickr.com if it sticks.';
  }
  if (code === 'auth/user-disabled') {
    return 'This account has been disabled. Email support@goalkickr.com for help.';
  }

  // ─ Apple-specific edge cases ───────────────────────────────────
  if (source === 'apple') {
    if (msg.includes('no idtoken') || msg.includes('idtoken')) {
      return 'Apple didn\'t return a valid sign-in. Try again, or use Google / email instead.';
    }
    return 'Apple sign-in didn\'t complete. Try again, or use Google / email instead.';
  }

  // ─ Google-specific edge cases ──────────────────────────────────
  if (source === 'google') {
    if (msg.includes('idtoken') || msg.includes('no token')) {
      return 'Google didn\'t return a valid sign-in. Try again, or use email instead.';
    }
    return 'Google sign-in didn\'t complete. Try again, or use Apple / email instead.';
  }

  // ─ Fallback (email path) ───────────────────────────────────────
  // Strip the "Firebase: ... (auth/foo)." formatting that leaks from
  // raw Firebase Error.message so users don't see error codes.
  const cleaned = (e.message || '')
    .replace(/^Firebase:\s*/i, '')
    .replace(/\s*\(auth\/[a-z0-9-]+\)\.?$/i, '')
    .trim();
  return cleaned || 'Something went wrong. Try again.';
}
