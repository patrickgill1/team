#!/usr/bin/env tsx
/**
 * One-shot XP announcement broadcast to Fire FC families.
 *
 * Patrick 2026-08-04: parents didn't know XP was being awarded.
 * This script sends ONE push per parent uid linked to any active
 * Fire FC player, with a per-recipient body naming that parent's
 * own kid(s) on this team.
 *
 * SAFETY MODEL
 *   Two required flags. Neither present = script errors.
 *     --dry-run  : print recipients + top-3 rendered samples, no send
 *     --send     : actually fire pushes to every parent
 *   Intended workflow: --dry-run first, review, then --send.
 *
 * SCOPE
 *   Team: Fire FC U10 PG (ojptEkCBpiI24QHR2h8e).
 *   Recipients: every uid in any active Fire FC player's parentIds,
 *   deduped across siblings, EXCLUDING the coach (self) uid.
 *   Honors pushPreferences.broadcast === false to skip muted users.
 *
 * COPY (Patrick-approved 2026-08-04 iteration)
 *   Title:  Fire FC
 *   Body 1: Coach Gill has been giving {Kid} XP for hard work and
 *           good behaviors. Tap to see what and why.
 *   Body 2: Coach Gill has been giving {Kid1} and {Kid2} XP for
 *           hard work and good behaviors. Tap to see.
 *   Body 3+: Coach Gill has been giving your players XP for hard
 *           work and good behaviors. Tap to see.
 *   URL:    /player/{id} (1 kid) or /dashboard (2+)
 *
 * APNs headers are explicitly set (apns-push-type: alert +
 * priority 10) — same fix that unblocked iOS pushes earlier today.
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

const TEAM_ID = 'ojptEkCBpiI24QHR2h8e';  // Fire FC U10 PG (per prior debug)
const COACH_UID = 'Leek1JUyr2dWaUAw7Uem6XY61v22';  // Patrick — always excluded
const TEAM_NAME = 'Fire FC';
const COACH_NAME = 'Coach Gill';

const dryRun = process.argv.includes('--dry-run');
const send = process.argv.includes('--send');
if (dryRun === send) {
  console.error('Usage: tsx scripts/broadcast-fire-fc-xp-announcement.ts [--dry-run|--send]');
  console.error('Pass exactly ONE flag. Do --dry-run first.');
  process.exit(1);
}

function firstName(full: string): string {
  const raw = String(full || '').trim();
  return raw.split(/\s+/)[0] || 'your player';
}

function buildBody(kids: string[]): string {
  const firsts = kids.map(firstName).filter(Boolean);
  if (firsts.length === 0) {
    return `${COACH_NAME} has been giving your player XP for hard work and good behaviors. Tap to see what and why.`;
  }
  if (firsts.length === 1) {
    return `${COACH_NAME} has been giving ${firsts[0]} XP for hard work and good behaviors. Tap to see what and why.`;
  }
  if (firsts.length === 2) {
    return `${COACH_NAME} has been giving ${firsts[0]} and ${firsts[1]} XP for hard work and good behaviors. Tap to see.`;
  }
  return `${COACH_NAME} has been giving your players XP for hard work and good behaviors. Tap to see.`;
}

function buildUrl(kids: Array<{ id: string; name: string }>): string {
  return kids.length === 1 ? `/player/${kids[0].id}` : '/dashboard';
}

(async () => {
  // Team sanity check
  const teamDoc = await db.collection('teams').doc(TEAM_ID).get();
  if (!teamDoc.exists) {
    console.error(`Team ${TEAM_ID} not found. Aborting.`);
    process.exit(1);
  }
  const teamDisplay = String(teamDoc.data()?.name || TEAM_NAME);
  console.log(`Team: ${teamDisplay} (${TEAM_ID})`);

  // Enumerate active players via reverse index — team.playerIds is stale per memory
  const playersSnap = await db.collection('players')
    .where('teamIds', 'array-contains', TEAM_ID)
    .get();
  const activePlayers = playersSnap.docs.filter(d => (d.data() as any).isActive !== false);
  console.log(`Active players on team: ${activePlayers.length} (total docs: ${playersSnap.size})`);

  // Build parent → kids-on-this-team map (excludes coach self)
  const parentToKids = new Map<string, Array<{ id: string; name: string }>>();
  for (const p of activePlayers) {
    const data = p.data() as any;
    const parentIds: string[] = Array.isArray(data.parentIds) ? data.parentIds : [];
    for (const uid of parentIds) {
      if (!uid || uid === COACH_UID) continue;
      const list = parentToKids.get(uid) || [];
      list.push({ id: p.id, name: String(data.name || 'Player') });
      parentToKids.set(uid, list);
    }
  }
  console.log(`Unique parent recipients (excluding coach): ${parentToKids.size}`);

  // Sample renders
  console.log('\n=== Sample renders (first 3 parents) ===');
  const sample = Array.from(parentToKids.entries()).slice(0, 3);
  for (const [uid, kids] of sample) {
    const userDoc = await db.collection('users').doc(uid).get();
    const u = userDoc.data() as any;
    const parentName = u?.name || `(unnamed)`;
    console.log(`\nParent: ${parentName}  uid=${uid.slice(0, 8)}…`);
    console.log(`  Kids on team: ${kids.map(k => k.name).join(', ')}`);
    console.log(`  Title:  ${TEAM_NAME}`);
    console.log(`  Body:   ${buildBody(kids.map(k => k.name))}`);
    console.log(`  URL:    ${buildUrl(kids)}`);
    console.log(`  Muted?  ${(u?.pushPreferences?.broadcast === false) ? 'YES (will skip)' : 'no'}`);
    console.log(`  Tokens: ${(Array.isArray(u?.fcmTokens) ? u.fcmTokens.length : 0)}`);
  }

  if (dryRun) {
    console.log(`\n=== DRY-RUN complete. No pushes fired. ===`);
    console.log(`Re-run with --send to broadcast to ${parentToKids.size} parents.`);
    process.exit(0);
  }

  // ── LIVE SEND ─────────────────────────────────────────
  console.log(`\n=== Firing live pushes to ${parentToKids.size} parents ===`);
  let sentCount = 0;
  let mutedCount = 0;
  let noTokensCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for (const [uid, kids] of parentToKids.entries()) {
    try {
      const userDoc = await db.collection('users').doc(uid).get();
      const u = userDoc.data() as any;
      if (!u || u.isActive === false) { noTokensCount++; continue; }
      const prefs = u.pushPreferences || {};
      if (prefs.broadcast === false) { mutedCount++; continue; }
      const tokens: string[] = (Array.isArray(u.fcmTokens) ? u.fcmTokens : [])
        .filter((t: any) => typeof t === 'string' && t.length > 10);
      if (tokens.length === 0) { noTokensCount++; continue; }

      const body = buildBody(kids.map(k => k.name));
      const url = buildUrl(kids);

      // Parallel fanout across this parent's devices. APNs headers
      // explicit so iOS 13+ shows banners (same fix from today's
      // worker patch — the script sends via Firebase Admin, not
      // through the worker, so the header work is duplicated here).
      const results = await Promise.all(tokens.map(async (t) => {
        try {
          await messaging.send({
            token: t,
            notification: { title: TEAM_NAME, body },
            data: { url },
            apns: {
              headers: { 'apns-push-type': 'alert', 'apns-priority': '10' },
              payload: {
                aps: {
                  alert: { title: TEAM_NAME, body },
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
          return { ok: true };
        } catch (err: any) {
          return {
            ok: false,
            code: err.code || err.errorInfo?.code || 'unknown',
            msg: (err.message || String(err)).slice(0, 100),
          };
        }
      }));
      const anyOk = results.some(r => r.ok);
      if (anyOk) sentCount++;
      else {
        failedCount++;
        const first = results.find(r => !r.ok);
        errors.push(`${uid.slice(0, 8)}: ${first?.code || 'all-tokens-failed'}`);
      }
    } catch (err: any) {
      failedCount++;
      errors.push(`${uid.slice(0, 8)}: ${String(err?.message || err).slice(0, 80)}`);
    }
  }

  console.log(`\n=== SEND COMPLETE ===`);
  console.log(`Delivered to ≥1 device:   ${sentCount}`);
  console.log(`Skipped (no tokens):      ${noTokensCount}`);
  console.log(`Skipped (broadcast muted): ${mutedCount}`);
  console.log(`Failed (no live token):   ${failedCount}`);
  console.log(`Total considered:         ${parentToKids.size}`);
  if (errors.length > 0) {
    console.log(`\nFirst 10 errors:`);
    for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
