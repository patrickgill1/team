// @ts-nocheck
// Usage:  npx tsx scripts/who-uploaded-media.ts <teamId>
//         npx tsx scripts/who-uploaded-media.ts --team=<teamId>
//         npx tsx scripts/who-uploaded-media.ts --uid=<uid>
//         npx tsx scripts/who-uploaded-media.ts --email=<email>
//
// Reports how many clips + photos each uploader has posted for a team
// (or globally when queried by uid/email). Also flags each user's role
// + subscription state so we can trace "why did this coach's upload
// hit permission-denied" without opening 5 Firestore console tabs.
//
// Reason it exists: 2026-09-14 the CLCF coach kept getting "Missing
// or insufficient permissions" on an 11 MB upload even after rules
// were loosened. Patrick asked "can we see how many clips he has
// uploaded?" — this is the one-shot answer.

import * as admin from 'firebase-admin';
import * as path from 'path';

admin.initializeApp({
  credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')),
});
const db = admin.firestore();

function parseArgs(): { teamId?: string; uid?: string; email?: string } {
  const out: any = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--team=')) out.teamId = arg.slice(7);
    else if (arg.startsWith('--uid=')) out.uid = arg.slice(6);
    else if (arg.startsWith('--email=')) out.email = arg.slice(8);
    else if (!arg.startsWith('--') && !out.teamId) out.teamId = arg;
  }
  return out;
}

function fmtDate(v: any): string {
  if (!v) return '-';
  const d: Date = v?.toDate ? v.toDate() : new Date(v);
  if (isNaN(d.getTime())) return '-';
  return d.toISOString().slice(0, 10);
}

async function resolveUserByEmail(email: string): Promise<{ uid: string; data: any } | null> {
  const snap = await db.collection('users').where('email', '==', email.toLowerCase().trim()).limit(1).get();
  if (snap.empty) return null;
  return { uid: snap.docs[0].id, data: snap.docs[0].data() };
}

async function userInfo(uid: string): Promise<any> {
  const doc = await db.collection('users').doc(uid).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function reportForTeam(teamId: string): Promise<void> {
  const team = await db.collection('teams').doc(teamId).get();
  if (!team.exists) {
    console.log(`Team ${teamId} not found`);
    return;
  }
  const t: any = team.data();
  console.log(`\n=== ${t.name || teamId} (${teamId}) ===`);
  console.log(`  coachIds:       ${(t.coachIds || []).length}`);
  console.log(`  managerIds:     ${(t.managerIds || []).length}`);
  console.log(`  mediaUploaders: ${(t.mediaUploaders || []).length}`);

  const [media, gallery] = await Promise.all([
    db.collection('player_media').where('teamId', '==', teamId).get(),
    db.collection('gallery').where('teamId', '==', teamId).get(),
  ]);

  const byUploader = new Map<string, {
    clips: number;
    photos: number;
    galleryPhotos: number;
    firstAt: Date | null;
    lastAt: Date | null;
    minutesEstimate: number;
    uploaderName?: string;
    softDeletedClips: number;
  }>();

  const bump = (uid: string, patch: Partial<{
    clips: number; photos: number; galleryPhotos: number;
    minutesEstimate: number; softDeletedClips: number;
    createdAt: Date | null; name: string;
  }>) => {
    const row = byUploader.get(uid) || {
      clips: 0, photos: 0, galleryPhotos: 0,
      firstAt: null, lastAt: null,
      minutesEstimate: 0, uploaderName: undefined, softDeletedClips: 0,
    };
    if (patch.clips) row.clips += patch.clips;
    if (patch.photos) row.photos += patch.photos;
    if (patch.galleryPhotos) row.galleryPhotos += patch.galleryPhotos;
    if (patch.softDeletedClips) row.softDeletedClips += patch.softDeletedClips;
    if (patch.minutesEstimate) row.minutesEstimate += patch.minutesEstimate;
    if (patch.name && !row.uploaderName) row.uploaderName = patch.name;
    if (patch.createdAt) {
      if (!row.firstAt || patch.createdAt < row.firstAt) row.firstAt = patch.createdAt;
      if (!row.lastAt || patch.createdAt > row.lastAt) row.lastAt = patch.createdAt;
    }
    byUploader.set(uid, row);
  };

  for (const doc of media.docs) {
    const d: any = doc.data();
    const uid = d.uploadedBy || '__unknown__';
    const createdAt = d.createdAt?.toDate ? d.createdAt.toDate() : (d.createdAt ? new Date(d.createdAt) : null);
    const isVideo = d.type === 'video' || !!d.streamUid;
    const isSoftDeleted = d.isActive === false;
    // Duration in seconds → minutes for the CF-Stream count. Not all
    // clips carry duration; fall back to a 90s / 1.5 min estimate for
    // videos with no meta (Gametape cap; not accurate for full-length
    // parent uploads but keeps the number in the right ballpark).
    let mins = 0;
    if (isVideo && !isSoftDeleted) {
      const secs = d.videoDurationSeconds ?? d.durationSeconds ?? null;
      mins = secs ? secs / 60 : 1.5;
    }
    bump(uid, {
      clips: !isSoftDeleted && isVideo ? 1 : 0,
      photos: !isSoftDeleted && !isVideo ? 1 : 0,
      softDeletedClips: isSoftDeleted && isVideo ? 1 : 0,
      minutesEstimate: mins,
      createdAt,
      name: d.uploadedByName,
    });
  }

  for (const doc of gallery.docs) {
    const d: any = doc.data();
    const uid = d.uploadedBy || '__unknown__';
    const isSoftDeleted = d.isActive === false;
    if (isSoftDeleted) continue;
    const createdAt = d.createdAt?.toDate ? d.createdAt.toDate() : (d.createdAt ? new Date(d.createdAt) : null);
    bump(uid, { galleryPhotos: 1, createdAt, name: d.uploadedByName });
  }

  // Sort by clip count desc so the heaviest uploaders float up.
  const rows = [...byUploader.entries()].sort(([, a], [, b]) => (b.clips + b.photos) - (a.clips + a.photos));

  if (rows.length === 0) {
    console.log(`\n  (no uploaded media for this team)`);
  } else {
    console.log(`\n  Uploader                    Clips  Photos  GalP   ~Min  First       Last        Role  Sub    Exp`);
    console.log(  `  ─────────────────────────── ─────  ──────  ─────  ────  ──────────  ──────────  ────  ─────  ──────────`);
    for (const [uid, row] of rows) {
      const u = uid !== '__unknown__' ? await userInfo(uid) : null;
      const name = (row.uploaderName || u?.name || uid).slice(0, 26).padEnd(27);
      const role = String(u?.role || '?').slice(0, 4).padEnd(4);
      const sub = u?.subscriptionActive === true ? 'yes'
                : u?.subscriptionActive === false ? 'NO'
                : '?';
      const exp = fmtDate(u?.subscriptionExpiresAt);
      console.log(
        `  ${name} ${String(row.clips).padStart(5)}  ${String(row.photos).padStart(6)}  ${String(row.galleryPhotos).padStart(5)}  ${row.minutesEstimate.toFixed(1).padStart(4)}  ${fmtDate(row.firstAt)}  ${fmtDate(row.lastAt)}  ${role}  ${sub.padEnd(5)}  ${exp}`
      );
      if (row.softDeletedClips > 0) {
        console.log(`      (+ ${row.softDeletedClips} soft-deleted clips — CF Stream storage may still be leaking on some)`);
      }
    }
    const totalMins = rows.reduce((s, [, r]) => s + r.minutesEstimate, 0);
    console.log(`\n  Total active clip minutes (rough est): ${totalMins.toFixed(1)}`);
  }
}

async function reportForUid(uid: string): Promise<void> {
  const u = await userInfo(uid);
  console.log(`\n=== User ${uid} ===`);
  if (u) {
    console.log(`  name: ${u.name}`);
    console.log(`  email: ${u.email}`);
    console.log(`  role: ${u.role}`);
    console.log(`  subscriptionActive: ${u.subscriptionActive}`);
    console.log(`  subscriptionExpiresAt: ${fmtDate(u.subscriptionExpiresAt)}`);
    console.log(`  coverageSource: ${u.coverageSource || '-'}`);
    console.log(`  teamIds: ${(u.teamIds || []).length} teams`);
    for (const tid of (u.teamIds || [])) {
      const t = await db.collection('teams').doc(tid).get();
      const td: any = t.exists ? t.data() : {};
      const onCoachIds = Array.isArray(td.coachIds) && td.coachIds.includes(uid);
      const onManagerIds = Array.isArray(td.managerIds) && td.managerIds.includes(uid);
      const onMediaUploaders = Array.isArray(td.mediaUploaders) && td.mediaUploaders.includes(uid);
      console.log(`    - ${td.name || tid} (${tid})`);
      console.log(`        coachIds: ${onCoachIds}  managerIds: ${onManagerIds}  mediaUploaders: ${onMediaUploaders}`);
    }
  } else {
    console.log(`  (no user doc found)`);
  }

  const media = await db.collection('player_media').where('uploadedBy', '==', uid).get();
  const clips = media.docs.filter(d => (d.data() as any).type === 'video' || (d.data() as any).streamUid);
  const photos = media.docs.filter(d => (d.data() as any).type !== 'video' && !(d.data() as any).streamUid);
  const active = media.docs.filter(d => (d.data() as any).isActive !== false);
  console.log(`\n  player_media docs uploaded: ${media.docs.length} (${clips.length} clips, ${photos.length} photos, ${active.length} active)`);
}

(async () => {
  const args = parseArgs();
  if (args.email) {
    const user = await resolveUserByEmail(args.email);
    if (!user) {
      console.log(`No user found for email ${args.email}`);
      process.exit(0);
    }
    await reportForUid(user.uid);
  } else if (args.uid) {
    await reportForUid(args.uid);
  } else if (args.teamId) {
    await reportForTeam(args.teamId);
  } else {
    console.log('Usage:');
    console.log('  npx tsx scripts/who-uploaded-media.ts <teamId>');
    console.log('  npx tsx scripts/who-uploaded-media.ts --team=<teamId>');
    console.log('  npx tsx scripts/who-uploaded-media.ts --uid=<uid>');
    console.log('  npx tsx scripts/who-uploaded-media.ts --email=<email>');
  }
  process.exit(0);
})();
