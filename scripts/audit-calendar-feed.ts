// @ts-nocheck
// Audit: reproduce the calendar-feed query for one team, compare
// against a full team-events pull to see if any events are silently
// getting missed by the where('teamId', '==', teamId) filter used
// by the ICS endpoint.

import * as admin from 'firebase-admin';
import * as path from 'path';

admin.initializeApp({ credential: admin.credential.cert(path.resolve(__dirname, 'firebase-service-account.json')) });
const db = admin.firestore();

const teamId = process.argv[2];
if (!teamId) { console.error('usage: tsx scripts/audit-calendar-feed.ts <teamId>'); process.exit(1); }

(async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Reproduce the ICS feed's exact query.
  const feedSnap = await db.collection('events')
    .where('teamId', '==', teamId)
    .where('date', '>=', cutoff)
    .limit(500)
    .get();
  console.log(`Feed query matched: ${feedSnap.size} events\n`);

  // Cast a wider net — all events tagged with this team via any shape.
  const teamIdSnap = await db.collection('events').where('teamId', '==', teamId).get();
  const teamIdsArraySnap = await db.collection('events').where('teamIds', 'array-contains', teamId).get();

  const byId = new Map<string, any>();
  for (const d of teamIdSnap.docs) byId.set(d.id, { id: d.id, ...(d.data() as any), _srcTeamId: true });
  for (const d of teamIdsArraySnap.docs) {
    const cur = byId.get(d.id) || { id: d.id, ...(d.data() as any) };
    cur._srcTeamIds = true;
    byId.set(d.id, cur);
  }
  const allTeamEvents = Array.from(byId.values());
  console.log(`Total docs tagged with this team (either shape): ${allTeamEvents.length}`);
  console.log(`  via teamId scalar:       ${teamIdSnap.size}`);
  console.log(`  via teamIds array:       ${teamIdsArraySnap.size}`);

  const missingScalar = allTeamEvents.filter(e => !e._srcTeamId);
  console.log(`  present in teamIds-array ONLY (missed by feed): ${missingScalar.length}`);
  for (const e of missingScalar.slice(0, 10)) {
    console.log(`    - ${e.id}  title=${e.title || '(no title)'}  date=${e.date?.toDate?.() || e.date}`);
  }

  // Of the events in scalar-teamId set, how many have a valid future date?
  const withFutureDate = teamIdSnap.docs
    .map(d => ({ id: d.id, ...(d.data() as any) }))
    .filter(e => {
      const dt = e.date?.toDate?.() || (e.date instanceof Date ? e.date : (typeof e.date === 'string' ? new Date(e.date) : null));
      return dt && dt.getTime() >= cutoff.getTime();
    });
  console.log(`\nOf scalar-teamId events, ${withFutureDate.length} have a valid date >= cutoff.`);

  const nonTimestamp = teamIdSnap.docs.filter(d => {
    const v = d.data()?.date;
    return v && !(typeof v?.toDate === 'function') && !(v instanceof Date);
  });
  if (nonTimestamp.length > 0) {
    console.log(`\nWARNING: ${nonTimestamp.length} events have a NON-TIMESTAMP date field (string/plain), which Firestore's range query can silently skip:`);
    for (const d of nonTimestamp.slice(0, 10)) {
      console.log(`  ${d.id}  date=${JSON.stringify(d.data()?.date)}  title=${d.data()?.title}`);
    }
  }

  const inactive = teamIdSnap.docs.filter(d => (d.data() as any).isActive === false);
  console.log(`\nSoft-deleted (isActive:false) still in feed: ${inactive.length}`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
