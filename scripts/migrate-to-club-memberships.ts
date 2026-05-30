#!/usr/bin/env tsx
/**
 * Phase 1 of the club-owns-player restructure.
 *
 * Restructures the existing flat (player-knows-its-team) model into:
 *   - Club  (top-level container, auto-created per owner)
 *   - Player.clubId  (player belongs to a club, not a team)
 *   - PlayerMembership  (player × team × season — stats live here)
 *   - StaffMembership   (coach/manager × team × season)
 *
 * STRATEGY
 *   1. Group teams by their owner / head coach → propose one Club per
 *      distinct owner. (You can manually merge afterwards if you'd
 *      rather Fire FC the club hold both Fire FC PG and another team.)
 *   2. For each player, derive memberships from (teamIds[] × seasonMemberships[]).
 *      Falls back to teamIds[] × the active season if no explicit
 *      seasonMemberships row.
 *   3. For each staff user (role coach / team_manager), derive
 *      StaffMembership rows per (teamId, active season).
 *   4. Stats: copy player.statsBySeasonId[seasonId] → membership.stats
 *      when present, else copy player.stats (legacy aggregate) as a
 *      one-time best-effort.
 *
 * SAFETY
 *   - Read-only by default. Prints a detailed report to stdout.
 *   - Run with --apply to actually write. Even then, never deletes
 *     legacy fields (teamIds, playerIds, etc.) — those stay in place
 *     until the read-path rewrite is complete and verified.
 *   - Idempotent: re-running on already-migrated data skips writes.
 *
 * USAGE
 *   npx tsx scripts/migrate-to-club-memberships.ts                 # dry run
 *   npx tsx scripts/migrate-to-club-memberships.ts --apply         # execute
 *   npx tsx scripts/migrate-to-club-memberships.ts --owner <uid>   # scope
 *
 * REQUIRES
 *   ./scripts/firebase-service-account.json (gitignored).
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const OWNER_FILTER = (() => {
  const i = process.argv.indexOf('--owner');
  return i > -1 ? process.argv[i + 1] : null;
})();

// ---------------------------------------------------------------------
// MANUAL CLUB MAPPING
//   If set, every team in the database collapses under one club. The
//   auto-group-by-team-owner logic is bypassed entirely.
//   For Fire FC, all 4 teams (Patrick's 2 + Fire FC AD + Fire FC PG)
//   roll up into a single "Fire FC" club owned by Patrick, with the
//   other head coaches as club admins.
// ---------------------------------------------------------------------
const FORCE_SINGLE_CLUB: {
  id: string;
  name: string;
  ownerUid: string;
} | null = {
  id: 'club_firefc',
  name: 'Fire FC',
  ownerUid: 'Leek1JUyr2dWaUAw7Uem6XY61v22', // Patrick
};

const saPath = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(saPath)) {
  console.error('Missing scripts/firebase-service-account.json — see header.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
const db = admin.firestore();

// ---------------------------------------------------------------------
// Types — keep loose; this is a migration script, not the app.
// ---------------------------------------------------------------------
interface AnyMap { [k: string]: any; }

function asDate(v: any): Date | undefined {
  if (!v) return undefined;
  if (v?.toDate) return v.toDate();
  return new Date(v);
}

// ---------------------------------------------------------------------
// Load everything we need into memory
// ---------------------------------------------------------------------
async function loadAll() {
  console.log('Loading collections…');
  const [teamsSnap, playersSnap, usersSnap, seasonsSnap] = await Promise.all([
    db.collection('teams').get(),
    db.collection('players').get(),
    db.collection('users').get(),
    db.collection('seasons').get(),
  ]);

  const teams = teamsSnap.docs.map(d => ({ id: d.id, ...(d.data() as AnyMap) }));
  const players = playersSnap.docs.map(d => ({ id: d.id, ...(d.data() as AnyMap) }));
  const users = usersSnap.docs.map(d => ({ id: d.id, ...(d.data() as AnyMap) }));
  const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...(d.data() as AnyMap) }));

  console.log(`  teams=${teams.length}  players=${players.length}  users=${users.length}  seasons=${seasons.length}`);
  return { teams, players, users, seasons };
}

// ---------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------
interface PlannedClub {
  id: string;
  name: string;
  ownerUid: string;
  adminUids: string[];
  teamIds: string[];
}
interface PlannedPlayerMembership {
  id: string;
  clubId: string;
  teamId: string;
  seasonId: string;
  playerId: string;
  jerseyNumber?: number;
  position?: string;
  positions?: string[];
  isActive: boolean;
  stats?: AnyMap;
}
interface PlannedStaffMembership {
  id: string;
  clubId: string;
  teamId: string;
  seasonId: string;
  uid: string;
  role: 'head_coach' | 'assistant_coach' | 'team_manager';
  isActive: boolean;
}

function plan(data: Awaited<ReturnType<typeof loadAll>>) {
  const { teams, players, users, seasons } = data;

  // 1. Plan clubs. If FORCE_SINGLE_CLUB is set, every team rolls up
  //    under one club; otherwise auto-group by owner.
  const plannedClubs: PlannedClub[] = [];
  const teamIdToClubId = new Map<string, string>();

  if (FORCE_SINGLE_CLUB) {
    // Every team → the single club. All distinct head/assistant coach
    // UIDs across all teams become club admins.
    const adminUids = new Set<string>([FORCE_SINGLE_CLUB.ownerUid]);
    for (const t of teams) {
      if (t.headCoachId) adminUids.add(t.headCoachId);
      for (const uid of (t.coachIds || [])) adminUids.add(uid);
      for (const uid of (t.assistantCoachIds || [])) adminUids.add(uid);
      teamIdToClubId.set(t.id, FORCE_SINGLE_CLUB.id);
    }
    plannedClubs.push({
      id: FORCE_SINGLE_CLUB.id,
      name: FORCE_SINGLE_CLUB.name,
      ownerUid: FORCE_SINGLE_CLUB.ownerUid,
      adminUids: Array.from(adminUids),
      teamIds: teams.map(t => t.id),
    });
  } else {
    // Auto-group: owner = headCoachId, fallback to first coachId.
    const ownerToTeams = new Map<string, AnyMap[]>();
    for (const t of teams) {
      const owner = t.headCoachId
        || (Array.isArray(t.coachIds) && t.coachIds[0])
        || 'orphan';
      if (OWNER_FILTER && owner !== OWNER_FILTER) continue;
      const arr = ownerToTeams.get(owner) || [];
      arr.push(t);
      ownerToTeams.set(owner, arr);
    }
    for (const [owner, ownedTeams] of ownerToTeams.entries()) {
      const clubId = `club_${owner}`;
      const ownerUser = users.find(u => u.uid === owner || u.id === owner);
      plannedClubs.push({
        id: clubId,
        name: ownedTeams.length === 1
          ? ownedTeams[0].name
          : (ownerUser?.name ? `${ownerUser.name}'s Club` : 'Club'),
        ownerUid: owner,
        adminUids: Array.from(new Set(ownedTeams.flatMap(t => [
          t.headCoachId,
          ...(t.coachIds || []),
          ...(t.assistantCoachIds || []),
        ]).filter(Boolean))),
        teamIds: ownedTeams.map(t => t.id),
      });
      for (const t of ownedTeams) teamIdToClubId.set(t.id, clubId);
    }
  }

  // 2. Plan player memberships. For each player × each team they're on
  //    × the team's active season.
  const teamActiveSeason = new Map<string, string | null>();
  for (const t of teams) {
    const active = seasons.find(s => s.teamId === t.id && s.isActive);
    teamActiveSeason.set(t.id, active?.id || (t.season || null));
  }

  const plannedPlayerMemberships: PlannedPlayerMembership[] = [];
  const orphanedPlayers: AnyMap[] = [];

  for (const p of players) {
    const teamIds: string[] = Array.isArray(p.teamIds) && p.teamIds.length
      ? p.teamIds
      : (p.teamId ? [p.teamId] : []);
    if (!teamIds.length) { orphanedPlayers.push(p); continue; }

    const existingMems: any[] = Array.isArray(p.seasonMemberships) ? p.seasonMemberships : [];

    for (const teamId of teamIds) {
      const clubId = teamIdToClubId.get(teamId);
      if (!clubId) continue; // team filtered out by --owner

      // Find season for this team, prefer explicit seasonMemberships rows.
      const matches = existingMems.filter((m: any) => m.teamId === teamId);
      const seasonsToCreate: { seasonId: string; jersey?: number; position?: string }[] = matches.length
        ? matches.map((m: any) => ({ seasonId: m.seasonId, jersey: m.jerseyNumber, position: m.position }))
        : [{ seasonId: teamActiveSeason.get(teamId) || 'season_unknown', jersey: p.jerseyNumber, position: p.position }];

      for (const { seasonId, jersey, position } of seasonsToCreate) {
        const memId = `mem_${p.id}_${teamId}_${seasonId}`;
        const seasonStats = (p.statsBySeasonId || {})[seasonId];
        plannedPlayerMemberships.push({
          id: memId,
          clubId,
          teamId,
          seasonId,
          playerId: p.id,
          jerseyNumber: jersey ?? p.jerseyNumber,
          position: position ?? p.position,
          positions: p.positions,
          isActive: p.isActive !== false,
          // Prefer per-season stats; fall back to legacy aggregate ONLY
          // if there's exactly one (team, season) for this player so
          // we don't accidentally double-count.
          stats: seasonStats || (seasonsToCreate.length === 1 && teamIds.length === 1 ? p.stats : undefined),
        });
      }
    }
  }

  // 3. Plan staff memberships. Walk teams' coachIds/headCoachId/etc.
  const plannedStaffMemberships: PlannedStaffMembership[] = [];
  for (const t of teams) {
    const clubId = teamIdToClubId.get(t.id);
    if (!clubId) continue;
    const seasonId = teamActiveSeason.get(t.id) || 'season_unknown';

    const seen = new Set<string>();
    const push = (uid: string, role: PlannedStaffMembership['role']) => {
      if (!uid || seen.has(`${uid}:${role}`)) return;
      seen.add(`${uid}:${role}`);
      plannedStaffMemberships.push({
        id: `staff_${uid}_${t.id}_${seasonId}_${role}`,
        clubId,
        teamId: t.id,
        seasonId,
        uid,
        role,
        isActive: true,
      });
    };
    if (t.headCoachId) push(t.headCoachId, 'head_coach');
    for (const uid of (t.assistantCoachIds || [])) push(uid, 'assistant_coach');
    for (const uid of (t.coachIds || [])) {
      // Anyone in coachIds who isn't already tagged head/assistant goes
      // in as assistant_coach by default — the head_coach role is a
      // strict 1-per-team thing and coachIds is a grab-bag.
      if (uid === t.headCoachId) continue;
      if ((t.assistantCoachIds || []).includes(uid)) continue;
      push(uid, 'assistant_coach');
    }
  }

  return { plannedClubs, plannedPlayerMemberships, plannedStaffMemberships, orphanedPlayers };
}

// ---------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------
function report(p: ReturnType<typeof plan>) {
  console.log('\n========== PLAN ==========');
  console.log(`Clubs to create:               ${p.plannedClubs.length}`);
  console.log(`Player memberships to create:  ${p.plannedPlayerMemberships.length}`);
  console.log(`Staff memberships to create:   ${p.plannedStaffMemberships.length}`);
  console.log(`Players with no team:          ${p.orphanedPlayers.length}`);

  if (p.plannedClubs.length) {
    console.log('\n--- Clubs ---');
    for (const c of p.plannedClubs) {
      console.log(`  ${c.id}  "${c.name}"  owner=${c.ownerUid}  teams=${c.teamIds.length}  admins=${c.adminUids.length}`);
    }
  }
  if (p.orphanedPlayers.length) {
    console.log('\n--- Orphans ---');
    for (const op of p.orphanedPlayers) console.log(`  ${op.id}  "${op.name}"`);
  }

  // Stats coverage — how many memberships landed with real stats vs none.
  const withStats = p.plannedPlayerMemberships.filter(m => m.stats && Object.keys(m.stats).length).length;
  console.log(`\nMemberships with stats:        ${withStats} / ${p.plannedPlayerMemberships.length}`);
}

// ---------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------
async function apply(p: ReturnType<typeof plan>) {
  console.log('\nAPPLYING — writing to Firestore…');
  let written = 0;

  // Clubs
  for (const c of p.plannedClubs) {
    const ref = db.collection('clubs').doc(c.id);
    const snap = await ref.get();
    if (snap.exists) {
      console.log(`  skip club ${c.id} (already exists)`);
      continue;
    }
    await ref.set({
      ...c,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    written++;
  }

  // Player memberships
  for (const m of p.plannedPlayerMemberships) {
    const ref = db.collection('player_memberships').doc(m.id);
    const snap = await ref.get();
    if (snap.exists) continue;
    await ref.set({
      ...m,
      joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    written++;
  }

  // Staff memberships
  for (const sm of p.plannedStaffMemberships) {
    const ref = db.collection('staff_memberships').doc(sm.id);
    const snap = await ref.get();
    if (snap.exists) continue;
    await ref.set({
      ...sm,
      joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    written++;
  }

  // Player.clubId backfill (single field — safe, additive).
  for (const m of p.plannedPlayerMemberships) {
    const ref = db.collection('players').doc(m.playerId);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const data = snap.data() as AnyMap;
    if (data.clubId === m.clubId) continue;
    await ref.update({ clubId: m.clubId });
    written++;
  }

  console.log(`Wrote ${written} docs.`);
}

(async () => {
  console.log(APPLY ? '*** APPLY MODE — will write ***' : '== DRY RUN ==');
  if (OWNER_FILTER) console.log(`Scope: owner=${OWNER_FILTER}`);
  const data = await loadAll();
  const p = plan(data);
  report(p);
  if (APPLY) {
    await apply(p);
  } else {
    console.log('\n(dry-run; re-run with --apply to execute)');
  }
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
