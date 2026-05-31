#!/usr/bin/env tsx
/**
 * One-time cleanup: bulk-reject the pending randos who signed up via
 * the open auth form without any invite or roster match.
 *
 * SAFETY
 *   - Dry-run by default. Lists everyone who would be rejected.
 *   - --apply actually writes approvalStatus='rejected' + approved=false.
 *   - Doesn't delete the user accounts (Firebase Auth keeps them; they
 *     just can't access the app).
 *   - Skips: anyone with isClubAdmin=true, role='coach' (already auto-
 *     approved), or whose email appears in a player.parentEmails — those
 *     are legitimate parents waiting on coach approval.
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');

const saPath = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(saPath)) { console.error('missing service account'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

(async () => {
  console.log(APPLY ? '*** APPLY ***' : '== DRY RUN ==');

  // The auth flow uses both `approved: false` (legacy) and
  // `approvalStatus: 'pending'` (new). Check both — pending users
  // typically only have `approved: false`.
  const [byBool, byStatus, playersSnap] = await Promise.all([
    db.collection('users').where('approved', '==', false).get(),
    db.collection('users').where('approvalStatus', '==', 'pending').get(),
    db.collection('players').get(),
  ]);
  const pendingMap = new Map<string, admin.firestore.QueryDocumentSnapshot>();
  for (const d of byBool.docs) pendingMap.set(d.id, d);
  for (const d of byStatus.docs) pendingMap.set(d.id, d);
  const pendingSnap = { docs: Array.from(pendingMap.values()), size: pendingMap.size };
  const legitEmails = new Set<string>();
  for (const p of playersSnap.docs) {
    const emails: any[] = (p.data() as any).parentEmails || [];
    for (const e of emails) {
      if (typeof e === 'string') legitEmails.add(e.toLowerCase().trim());
    }
  }

  const toReject: { id: string; name: string; email: string; reason: string }[] = [];
  const toKeep: { id: string; name: string; email: string; reason: string }[] = [];

  for (const u of pendingSnap.docs) {
    const data = u.data() as any;
    const email = (data.email || '').toLowerCase().trim();
    if (data.isClubAdmin) {
      toKeep.push({ id: u.id, name: data.name, email, reason: 'isClubAdmin' });
      continue;
    }
    if (data.role === 'coach') {
      toKeep.push({ id: u.id, name: data.name, email, reason: 'role=coach' });
      continue;
    }
    if (email && legitEmails.has(email)) {
      toKeep.push({ id: u.id, name: data.name, email, reason: 'on parentEmails' });
      continue;
    }
    toReject.push({ id: u.id, name: data.name, email, reason: 'no link to any roster' });
  }

  console.log(`\nPending total: ${pendingSnap.size}`);
  console.log(`  Will REJECT: ${toReject.length}`);
  console.log(`  Will KEEP:   ${toKeep.length}\n`);

  if (toKeep.length) {
    console.log('--- KEEP (still pending, may need manual coach approval) ---');
    for (const k of toKeep) console.log(`  ${k.name}  <${k.email}>  (${k.reason})`);
  }
  if (toReject.length) {
    console.log('\n--- REJECT ---');
    for (const r of toReject) console.log(`  ${r.name}  <${r.email}>`);
  }

  if (!APPLY) {
    console.log('\n(dry-run; re-run with --apply to reject)');
    process.exit(0);
  }

  const batch = db.batch();
  for (const r of toReject) {
    batch.update(db.collection('users').doc(r.id), {
      approvalStatus: 'rejected',
      approved: false,
      rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      rejectedReason: 'bulk cleanup — unrequested signup',
    });
  }
  await batch.commit();
  console.log(`\nRejected ${toReject.length} users.`);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
