#!/usr/bin/env tsx
/**
 * Backfill users.coverageSource='club' + coverageClubId for coaches
 * whose invite consume didn't stamp it.
 *
 * WHY
 *   The coach trial-wall in firestore.rules (canCoachWrite) accepts
 *   isPlatformAdmin OR !isCoachRole OR hasActiveSub OR
 *   hasClubCoverage. hasClubCoverage reads userDoc().coverageSource
 *   == 'club'. On invite consume, applyMembership() writes that
 *   stamp iff the invited coach's team belongs to a real (non-solo)
 *   club — but any coach whose invite predates that logic, or whose
 *   invite consume hit an edge case, is silently missing the stamp
 *   and gets blocked from paid-feature paths even though they're a
 *   legit coach under club coverage.
 *
 * ELIGIBILITY (mirrors worker/src/writeGuards.ts:735-752)
 *   A user gets stamped iff ALL of:
 *     - user.role in ['coach', 'team_manager']
 *     - user is missing coverageSource, OR has it set to a value
 *       other than 'club'
 *     - user has at least one team in user.teamIds whose team.clubId
 *       is set AND club.isDefaultSoloClub !== true
 *
 * OUTPUT
 *   Prints per-candidate: uid, name, email, current role, teams,
 *   proposed clubId. Dry-run does NOT write; --apply writes.
 *
 * USAGE
 *   tsx scripts/backfill-coach-club-coverage.ts             # dry-run
 *   tsx scripts/backfill-coach-club-coverage.ts --apply     # actually write
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

const apply = process.argv.includes('--apply');
console.log(`Mode: ${apply ? 'APPLY (will write)' : 'DRY-RUN (read-only)'}\n`);

interface Candidate {
  uid: string;
  name: string;
  email: string;
  role: string;
  currentCoverage: string;
  teams: Array<{ teamId: string; teamName: string; clubId: string; clubName: string; isSolo: boolean }>;
  proposedClubId: string;
  proposedClubName: string;
}

(async () => {
  // Load all coach/manager users
  const roles = ['coach', 'team_manager'];
  const userSnaps = await Promise.all(
    roles.map(r => db.collection('users').where('role', '==', r).get())
  );
  const users = userSnaps.flatMap(s => s.docs);
  console.log(`Total coach/manager users: ${users.length}\n`);

  // Team + club caches
  const teamCache = new Map<string, any>();
  const clubCache = new Map<string, any>();
  const loadTeam = async (id: string) => {
    if (teamCache.has(id)) return teamCache.get(id);
    const doc = await db.collection('teams').doc(id).get();
    const data = doc.exists ? doc.data() : null;
    teamCache.set(id, data);
    return data;
  };
  const loadClub = async (id: string) => {
    if (clubCache.has(id)) return clubCache.get(id);
    const doc = await db.collection('clubs').doc(id).get();
    const data = doc.exists ? doc.data() : null;
    clubCache.set(id, data);
    return data;
  };

  const candidates: Candidate[] = [];
  const alreadyCovered: string[] = [];
  const soloOnly: string[] = [];
  const noTeams: string[] = [];

  for (const uDoc of users) {
    const u: any = uDoc.data();
    const uid = uDoc.id;
    // Skip if already covered
    if (u.coverageSource === 'club') { alreadyCovered.push(uid); continue; }

    const teamIds: string[] = Array.isArray(u.teamIds) ? u.teamIds : [];
    if (teamIds.length === 0) { noTeams.push(uid); continue; }

    const teamRows: Candidate['teams'] = [];
    let firstNonSoloClubId = '';
    let firstNonSoloClubName = '';
    for (const teamId of teamIds) {
      const team = await loadTeam(teamId);
      if (!team) continue;
      const clubId = String(team.clubId || '');
      if (!clubId) {
        teamRows.push({ teamId, teamName: String(team.name || ''), clubId: '', clubName: '', isSolo: false });
        continue;
      }
      const club = await loadClub(clubId);
      const isSolo = club?.isDefaultSoloClub === true;
      teamRows.push({
        teamId,
        teamName: String(team.name || ''),
        clubId,
        clubName: String(club?.name || ''),
        isSolo,
      });
      if (!isSolo && !firstNonSoloClubId) {
        firstNonSoloClubId = clubId;
        firstNonSoloClubName = String(club?.name || '');
      }
    }

    if (!firstNonSoloClubId) { soloOnly.push(uid); continue; }

    candidates.push({
      uid,
      name: String(u.name || '(no name)'),
      email: String(u.email || '(no email)'),
      role: String(u.role || ''),
      currentCoverage: String(u.coverageSource || '(unset)'),
      teams: teamRows,
      proposedClubId: firstNonSoloClubId,
      proposedClubName: firstNonSoloClubName,
    });
  }

  console.log(`Already covered (coverageSource=club):  ${alreadyCovered.length}`);
  console.log(`Skipped (no teamIds):                    ${noTeams.length}`);
  console.log(`Skipped (only in solo clubs):            ${soloOnly.length}`);
  console.log(`\n=== ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} for backfill ===`);

  for (const c of candidates) {
    console.log(`\n  ${c.name.padEnd(24)} <${c.email}>`);
    console.log(`    uid=${c.uid.slice(0, 12)}…  role=${c.role}  current=${c.currentCoverage}`);
    console.log(`    Teams:`);
    for (const t of c.teams) {
      const tag = t.isSolo ? '(solo)' : t.clubName ? `→ ${t.clubName}` : '(no club)';
      console.log(`      ${t.teamName.padEnd(30)} ${tag}`);
    }
    console.log(`    → will stamp coverageSource=club, coverageClubId=${c.proposedClubId} (${c.proposedClubName})`);
  }

  if (!apply) {
    console.log(`\n=== DRY-RUN complete. No writes. ===`);
    console.log(`Re-run with --apply to stamp ${candidates.length} user${candidates.length === 1 ? '' : 's'}.`);
    process.exit(0);
  }

  if (candidates.length === 0) {
    console.log(`\nNothing to do.`);
    process.exit(0);
  }

  console.log(`\n=== Applying to ${candidates.length} users ===`);
  let ok = 0, fail = 0;
  for (const c of candidates) {
    try {
      await db.collection('users').doc(c.uid).update({
        coverageSource: 'club',
        coverageClubId: c.proposedClubId,
      });
      ok++;
    } catch (err: any) {
      console.error(`  ✗ ${c.uid.slice(0, 12)}… ${c.name} → ${err.message?.slice(0, 100)}`);
      fail++;
    }
  }
  console.log(`\nDone: ${ok} updated / ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
