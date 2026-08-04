#!/usr/bin/env tsx
/**
 * Push-notification inspector for a single user.
 *
 * USAGE
 *   tsx scripts/inspect-my-push.ts <uid-or-email>
 *   tsx scripts/inspect-my-push.ts <uid-or-email> --send-test
 *
 * WITHOUT --send-test: reports token count, first 8 chars of each
 * token (safe to paste in chat), pushPreferences, and any red flags.
 *
 * WITH --send-test: also fires a real FCM push to every one of the
 * user's registered tokens and reports which succeed vs. which
 * FCM rejects (invalid registration, unregistered, etc). This is
 * the fastest way to distinguish "worker never sent" from "FCM
 * accepted but device never showed" from "token is dead".
 *
 * WHY. Coach reported iOS push stopped delivering 2026-08-04. The
 * in-app delivery-test panel was removed the day before; this
 * script is the server-side equivalent so we don't need another
 * ship to debug.
 */

// @ts-nocheck
import * as admin from 'firebase-admin';
import * as path from 'path';
import * as fs from 'fs';

const SA_PATH = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(SA_PATH)) {
  console.error('Service account JSON not found at', SA_PATH);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(SA_PATH) });
const db = admin.firestore();
const messaging = admin.messaging();

const [, , userArg, ...flags] = process.argv;
const sendTest = flags.includes('--send-test');

if (!userArg) {
  console.error('Usage: tsx scripts/inspect-my-push.ts <uid-or-email> [--send-test]');
  process.exit(1);
}

async function resolveUser(input: string): Promise<{ uid: string; data: any } | null> {
  // Try direct uid lookup first
  const direct = await db.collection('users').doc(input).get();
  if (direct.exists) return { uid: direct.id, data: direct.data() };
  // Fallback: email lookup
  if (input.includes('@')) {
    const snap = await db
      .collection('users')
      .where('email', '==', input.toLowerCase().trim())
      .limit(1)
      .get();
    if (!snap.empty) return { uid: snap.docs[0].id, data: snap.docs[0].data() };
  }
  return null;
}

function short(t: string): string {
  return t.length > 12 ? `${t.slice(0, 8)}…${t.slice(-4)}` : t;
}

(async () => {
  const user = await resolveUser(userArg);
  if (!user) {
    console.error(`User not found for "${userArg}".`);
    process.exit(1);
  }
  const { uid, data } = user;
  console.log(`\n=== ${data.name || '(no name)'} <${data.email || 'no email'}>`);
  console.log(`uid: ${uid}`);
  console.log(`role: ${data.role || '(unset)'}`);
  console.log(`isActive: ${data.isActive !== false}`);
  console.log(`isClubAdmin: ${data.isClubAdmin === true}`);

  const prefs = data.pushPreferences || {};
  console.log('\npushPreferences:');
  const keys = ['chat', 'events', 'broadcast', 'helpdesk'];
  for (const k of keys) {
    const v = prefs[k];
    const display = v === false ? 'OFF' : v === true ? 'ON' : '(default = on)';
    console.log(`  ${k.padEnd(10)} ${display}`);
  }

  const tokens: string[] = Array.isArray(data.fcmTokens) ? data.fcmTokens.filter(Boolean) : [];
  console.log(`\nfcmTokens: ${tokens.length}`);
  tokens.forEach((t, i) => console.log(`  [${i}] ${short(t)}  (len=${t.length})`));

  if (tokens.length === 0) {
    console.log('\n⚠️  No tokens registered. User has never enabled push or all tokens were purged.');
    process.exit(0);
  }

  if (!sendTest) {
    console.log('\nPass --send-test to fire a real FCM push to every token and see which succeed.');
    process.exit(0);
  }

  console.log('\n=== sending test push to every token (explicit APNs headers) ===');
  // iOS 13+ requires `apns-push-type: alert` for banner-style
  // notifications. FCM's default may or may not set it depending
  // on SDK version — set explicitly so we're sure. Priority 10 =
  // immediate delivery (not deferred / batched by APNs).
  const results = await Promise.all(tokens.map(async (t, idx) => {
    try {
      const id = await messaging.send({
        token: t,
        notification: { title: 'GoalKickr push probe', body: `Ping ${idx + 1}/${tokens.length}` },
        data: { url: '/settings' },
        apns: {
          headers: {
            'apns-push-type': 'alert',
            'apns-priority': '10',
          },
          payload: {
            aps: {
              alert: { title: 'GoalKickr push probe', body: `Ping ${idx + 1}/${tokens.length}` },
              sound: 'default',
              'mutable-content': 1,
            },
          },
        },
        android: {
          priority: 'high',
          notification: { channelId: 'default' },
        },
      });
      return { token: t, ok: true, messageId: id };
    } catch (err: any) {
      return { token: t, ok: false, code: err.code || err.errorInfo?.code || 'unknown', msg: err.message || String(err) };
    }
  }));

  console.log('');
  for (const r of results) {
    if (r.ok) {
      console.log(`✓ ${short(r.token)}  ${r.messageId}`);
    } else {
      console.log(`✗ ${short(r.token)}  ${r.code}  ${r.msg?.slice(0, 100) || ''}`);
    }
  }
  const alive = results.filter((r) => r.ok).length;
  const dead = results.length - alive;
  console.log(`\nsummary: ${alive} live / ${dead} dead / ${results.length} total`);
  if (dead > 0) {
    console.log('\nStale tokens should be pruned. Common codes:');
    console.log('  messaging/invalid-registration-token   — malformed token');
    console.log('  messaging/registration-token-not-registered — app uninstalled or token rotated');
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
