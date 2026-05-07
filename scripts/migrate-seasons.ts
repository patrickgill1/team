#!/usr/bin/env tsx
/**
 * Phase 1 migration — Seasons + per-season stats backfill.
 *
 * For each existing team:
 *   1. Create a `season_legacy_<teamId>` season covering team-creation → far future, isActive=true.
 * For each existing player:
 *   2. Initialize `statsBySeasonId` with the player's current `stats` under the legacy season.
 *   3. Add a `seasonMemberships` entry for the legacy season + each teamId on the player.
 * For each existing player_media, match_votings, development_plans, attendance_records, events:
 *   4. Stamp `seasonId: 'season_legacy_<teamId>'` if missing.
 *
 * SAFETY:
 *   - Read-only by default. Run with --apply to write.
 *   - Never deletes or modifies existing fields. Only adds new ones.
 *   - Idempotent — re-running skips docs that already have the new fields.
 *
 * Usage:
 *   npx tsx scripts/migrate-seasons.ts            # dry-run (default)
 *   npx tsx scripts/migrate-seasons.ts --apply    # actually write
 *   npx tsx scripts/migrate-seasons.ts --team team_xxx  # scope to one team
 *
 * Setup (one-time):
 *   1. Firebase Console → Project Settings → Service Accounts → Generate new private key.
 *      Save the JSON as ./scripts/firebase-service-account.json (gitignored).
 *   2. `npm i -D tsx firebase-admin` if not already installed.
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

// ----- args -----
const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const TEAM_FILTER = (() => {
  const i = process.argv.indexOf('--team');
  return i > -1 ? process.argv[i + 1] : null;
})();

const FIVE_YEARS_FUTURE = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000);

// ----- init -----
const SA_PATH = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(SA_PATH)) {
  console.error('Service account JSON not found at', SA_PATH);
  console.error('Firebase Console → Project Settings → Service Accounts → Generate new private key.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(SA_PATH) });
const db = admin.firestore();

const banner = (msg: string) => console.log(`\n${'='.repeat(60)}\n${msg}\n${'='.repeat(60)}`);
const log = (...a: any[]) => console.log(`[${APPLY ? 'APPLY' : 'DRY  '}]`, ...a);

const counters = {
  seasonsCreated: 0,
  playersUpdated: 0,
  mediaUpdated: 0,
  votingsUpdated: 0,
  plansUpdated: 0,
  attendanceUpdated: 0,
  eventsUpdated: 0,
  skippedAlreadyMigrated: 0,
};

const legacySeasonId = (teamId: string) => `season_legacy_${teamId}`;

// ----- 1. Create legacy seasons -----
async function ensureLegacySeasons(): Promise<Map<string, string>> {
  banner('Phase 1.1 — Ensure legacy season per team');
  const teamsSnap = await db.collection('teams').get();
  const teamToSeason = new Map<string, string>();

  for (const teamDoc of teamsSnap.docs) {
    if (TEAM_FILTER && teamDoc.id !== TEAM_FILTER) continue;
    const sid = legacySeasonId(teamDoc.id);
    const seasonRef = db.collection('seasons').doc(sid);
    const existing = await seasonRef.get();
    if (existing.exists) {
      log(`season already exists: ${sid}`);
      counters.skippedAlreadyMigrated++;
    } else {
      const team = teamDoc.data();
      const startDate = team.createdAt?.toDate?.() || new Date('2024-01-01');
      log(`would create season: ${sid} for team ${team.name || teamDoc.id}`);
      if (APPLY) {
        await seasonRef.set({
          id: sid,
          teamId: teamDoc.id,
          name: 'Legacy (pre-seasons)',
          startDate,
          endDate: FIVE_YEARS_FUTURE,
          isActive: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      counters.seasonsCreated++;
    }
    teamToSeason.set(teamDoc.id, sid);
  }
  return teamToSeason;
}

// ----- 2. Backfill players -----
async function backfillPlayers(teamToSeason: Map<string, string>) {
  banner('Phase 1.2 — Backfill players (statsBySeasonId + seasonMemberships)');
  const playersSnap = await db.collection('players').get();
  for (const playerDoc of playersSnap.docs) {
    const p = playerDoc.data();
    const teamId = p.teamId;
    if (TEAM_FILTER && teamId !== TEAM_FILTER) continue;
    const seasonId = teamToSeason.get(teamId);
    if (!seasonId) {
      log(`skip player ${playerDoc.id} — no season for team ${teamId}`);
      continue;
    }

    if (p.statsBySeasonId && p.seasonMemberships) {
      counters.skippedAlreadyMigrated++;
      continue;
    }

    const teamIds = Array.isArray(p.teamIds) && p.teamIds.length > 0 ? p.teamIds : [teamId];
    const memberships = teamIds.map((tid: string) => ({
      seasonId: teamToSeason.get(tid) || legacySeasonId(tid),
      teamId: tid,
      jerseyNumber: p.jerseyNumber,
      position: p.position,
    }));

    const update: Record<string, any> = {
      statsBySeasonId: { [seasonId]: p.stats || {} },
      seasonMemberships: memberships,
    };

    log(`update player ${p.name || playerDoc.id} (${playerDoc.id})`);
    if (APPLY) await playerDoc.ref.update(update);
    counters.playersUpdated++;
  }
}

// ----- 3. Backfill seasonId on event-style collections -----
async function backfillCollection(
  collectionName: string,
  counterKey: keyof typeof counters,
  teamToSeason: Map<string, string>,
) {
  banner(`Phase 1.3 — Backfill seasonId on ${collectionName}`);
  const snap = await db.collection(collectionName).get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.seasonId) {
      counters.skippedAlreadyMigrated++;
      continue;
    }
    const teamId = d.teamId;
    if (TEAM_FILTER && teamId !== TEAM_FILTER) continue;
    const seasonId = teamId ? teamToSeason.get(teamId) : null;
    if (!seasonId) {
      log(`skip ${collectionName}/${doc.id} — no team/season`);
      continue;
    }
    log(`stamp ${collectionName}/${doc.id} with seasonId=${seasonId}`);
    if (APPLY) await doc.ref.update({ seasonId });
    (counters as any)[counterKey]++;
  }
}

// ----- main -----
(async () => {
  banner(APPLY ? 'APPLY MODE — writes will happen' : 'DRY-RUN — no writes (pass --apply to commit)');
  if (TEAM_FILTER) console.log('Scope: team =', TEAM_FILTER);

  const teamToSeason = await ensureLegacySeasons();
  await backfillPlayers(teamToSeason);
  await backfillCollection('player_media', 'mediaUpdated', teamToSeason);
  await backfillCollection('match_votings', 'votingsUpdated', teamToSeason);
  await backfillCollection('development_plans', 'plansUpdated', teamToSeason);
  await backfillCollection('attendance_records', 'attendanceUpdated', teamToSeason);
  await backfillCollection('events', 'eventsUpdated', teamToSeason);

  banner('Summary');
  console.log(JSON.stringify(counters, null, 2));
  console.log(APPLY ? '\n✅ Applied' : '\n📝 Dry-run only — re-run with --apply to commit.');
  process.exit(0);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
