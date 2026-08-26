// League MVP — worker-side helpers for the round-robin competition
// feature. See src/types/index.ts for the schema comments.
//
// Standings are recomputed from scratch on every score report — the
// N is small (<= 24 teams, ~200 fixtures per season) so a full sweep
// is cheaper than incrementing individual counters and reconciling
// on edits. Idempotent by construction.

import { getDocument, patchDocument, createDocument, runQuery, commitDocumentTransforms } from './firestore';
import type { ServiceAccount } from './fcm';
import type { StandingsRow } from '../../src/types';

// Local StandingsRow that widens teamName to allow undefined for
// initialization (widens back to string on write since we backfill).
interface RowState {
  teamId: string;
  teamName: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
}

interface LeagueConfig {
  pointsWin: number;
  pointsDraw: number;
  pointsLoss: number;
  tiebreak: Array<'gd' | 'gf' | 'ga' | 'h2h'>;
}

const DEFAULT_CONFIG: LeagueConfig = {
  pointsWin: 3,
  pointsDraw: 1,
  pointsLoss: 0,
  tiebreak: ['gd', 'gf', 'ga'],
};

/** Read league doc + all its final fixtures, compute the standings
 *  table, and persist to standings/{leagueId}. Called after every
 *  score report + on-demand from admin refresh. */
export async function recomputeStandings(pid: string, leagueId: string, sa: ServiceAccount): Promise<StandingsRow[]> {
  const league = await getDocument(pid, `leagues/${leagueId}`, sa).catch(() => null);
  if (!league?.data) throw new Error('league_not_found');

  const teamIds: string[] = Array.isArray(league.data.teamIds) ? league.data.teamIds : [];
  const cfg: LeagueConfig = {
    pointsWin: typeof league.data.pointsWin === 'number' ? league.data.pointsWin : DEFAULT_CONFIG.pointsWin,
    pointsDraw: typeof league.data.pointsDraw === 'number' ? league.data.pointsDraw : DEFAULT_CONFIG.pointsDraw,
    pointsLoss: typeof league.data.pointsLoss === 'number' ? league.data.pointsLoss : DEFAULT_CONFIG.pointsLoss,
    tiebreak: Array.isArray(league.data.tiebreak) && league.data.tiebreak.length > 0
      ? league.data.tiebreak
      : DEFAULT_CONFIG.tiebreak,
  };

  const fixtures = await runQuery(pid, 'fixtures', [
    { field: 'leagueId', op: 'EQUAL', value: leagueId },
  ], sa, 500).catch(() => [] as Array<{ id: string; data: any }>);

  const rows = new Map<string, RowState>();
  for (const tid of teamIds) {
    rows.set(tid, {
      teamId: tid,
      teamName: '',  // populated from fixture snapshot below
      played: 0, wins: 0, draws: 0, losses: 0,
      goalsFor: 0, goalsAgainst: 0, goalDifference: 0,
      points: 0,
    });
  }

  for (const f of fixtures) {
    const d = f.data || {};
    if (d.status !== 'final') continue;
    const home = String(d.homeTeamId || '');
    const away = String(d.awayTeamId || '');
    const hs = Number(d.homeScore);
    const as = Number(d.awayScore);
    if (!home || !away || !Number.isFinite(hs) || !Number.isFinite(as)) continue;

    const homeRow = rows.get(home) || {
      teamId: home, teamName: String(d.homeTeamName || ''),
      played: 0, wins: 0, draws: 0, losses: 0,
      goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0,
    };
    const awayRow = rows.get(away) || {
      teamId: away, teamName: String(d.awayTeamName || ''),
      played: 0, wins: 0, draws: 0, losses: 0,
      goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0,
    };
    if (!homeRow.teamName) homeRow.teamName = String(d.homeTeamName || home);
    if (!awayRow.teamName) awayRow.teamName = String(d.awayTeamName || away);

    homeRow.played++;
    awayRow.played++;
    homeRow.goalsFor += hs;
    homeRow.goalsAgainst += as;
    awayRow.goalsFor += as;
    awayRow.goalsAgainst += hs;

    if (hs > as) {
      homeRow.wins++; homeRow.points += cfg.pointsWin;
      awayRow.losses++; awayRow.points += cfg.pointsLoss;
    } else if (hs < as) {
      awayRow.wins++; awayRow.points += cfg.pointsWin;
      homeRow.losses++; homeRow.points += cfg.pointsLoss;
    } else {
      homeRow.draws++; homeRow.points += cfg.pointsDraw;
      awayRow.draws++; awayRow.points += cfg.pointsDraw;
    }
    homeRow.goalDifference = homeRow.goalsFor - homeRow.goalsAgainst;
    awayRow.goalDifference = awayRow.goalsFor - awayRow.goalsAgainst;
    rows.set(home, homeRow);
    rows.set(away, awayRow);
  }

  // Backfill team names for teams without any played fixtures (worker
  // read on the team docs is one round-trip per name — cheap for a
  // 24-team max league).
  const missingNames: string[] = [];
  for (const row of rows.values()) {
    if (!row.teamName) missingNames.push(row.teamId);
  }
  for (const tid of missingNames) {
    try {
      const teamDoc = await getDocument(pid, `teams/${tid}`, sa).catch(() => null);
      const row = rows.get(tid);
      if (row) {
        row.teamName = String(teamDoc?.data?.name || tid);
      }
    } catch { /* keep the id as a fallback */ }
  }

  // Sort: points desc, then tiebreaks in config order, then teamName
  // ascending as final deterministic tie-break.
  const sorted = Array.from(rows.values()).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    for (const t of cfg.tiebreak) {
      if (t === 'gd' && b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
      if (t === 'gf' && b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
      if (t === 'ga' && a.goalsAgainst !== b.goalsAgainst) return a.goalsAgainst - b.goalsAgainst; // lower is better
    }
    return a.teamName.localeCompare(b.teamName);
  });

  // Persist. Standings doc id === league id so the client can just
  // getDoc(standings/leagueId).
  await patchDocument(pid, `standings/${leagueId}`, {
    leagueId,
    rows: sorted,
    updatedAt: new Date(),
  }, sa).catch(async () => {
    // First-time write when doc doesn't exist yet.
    await createDocument(pid, 'standings', {
      leagueId,
      rows: sorted,
      updatedAt: new Date(),
    }, sa, leagueId);
  });

  return sorted;
}

/** Create a league. Body: { name, season?, clubId?, ownerUid,
 *  teamIds, format? } — worker validates + writes. */
export async function createLeague(
  pid: string,
  sa: ServiceAccount,
  ownerUid: string,
  payload: any,
): Promise<{ id: string }> {
  const name = String(payload?.name || '').trim().slice(0, 100);
  if (!name) throw new Error('name_required');
  const teamIds: string[] = Array.isArray(payload?.teamIds)
    ? payload.teamIds.filter((t: any) => typeof t === 'string' && t).slice(0, 24)
    : [];
  const doc: Record<string, any> = {
    name,
    season: payload?.season ? String(payload.season).slice(0, 50) : undefined,
    clubId: payload?.clubId ? String(payload.clubId) : undefined,
    format: ['4v4', '7v7', '9v9', '11v11'].includes(payload?.format) ? String(payload.format) : undefined,
    ownerUid,
    adminUids: [ownerUid],
    teamIds,
    isPublic: payload?.isPublic !== false,
    createdAt: new Date(),
  };
  // Strip undefined values so Firestore doesn't complain.
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  const id = await createDocument(pid, 'leagues', doc, sa);

  // Fan the league onto each team's leagueIds denorm.
  for (const tid of teamIds) {
    await commitDocumentTransforms(
      pid,
      `teams/${tid}`,
      [{ fieldPath: 'leagueIds', kind: 'arrayUnion', value: id }],
      null,
      sa,
    ).catch((err) => console.warn('[leagues] team leagueIds arrayUnion failed', tid, err));
  }

  // Kick off an initial (empty) standings doc so the public page
  // doesn't 404 before the first fixture is played.
  await recomputeStandings(pid, id, sa).catch((err) => console.warn('[leagues] initial standings failed', err));
  return { id };
}

/** Create a fixture. Body: { leagueId, homeTeamId, awayTeamId, date,
 *  matchday?, location? } */
export async function createFixture(
  pid: string,
  sa: ServiceAccount,
  callerUid: string,
  payload: any,
): Promise<{ id: string }> {
  const leagueId = String(payload?.leagueId || '');
  if (!leagueId) throw new Error('league_id_required');
  const league = await getDocument(pid, `leagues/${leagueId}`, sa).catch(() => null);
  if (!league?.data) throw new Error('league_not_found');
  const admins: string[] = Array.isArray(league.data.adminUids) ? league.data.adminUids : [];
  if (!admins.includes(callerUid) && String(league.data.ownerUid || '') !== callerUid) {
    throw new Error('not_league_admin');
  }

  const homeTeamId = String(payload?.homeTeamId || '');
  const awayTeamId = String(payload?.awayTeamId || '');
  if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId) {
    throw new Error('team_ids_invalid');
  }
  const leagueTeams: string[] = Array.isArray(league.data.teamIds) ? league.data.teamIds : [];
  if (!leagueTeams.includes(homeTeamId) || !leagueTeams.includes(awayTeamId)) {
    throw new Error('team_not_in_league');
  }

  const home = await getDocument(pid, `teams/${homeTeamId}`, sa).catch(() => null);
  const away = await getDocument(pid, `teams/${awayTeamId}`, sa).catch(() => null);
  const dateMs = Number(payload?.dateMs);
  if (!Number.isFinite(dateMs)) throw new Error('date_required');

  const fields: Record<string, any> = {
    leagueId,
    homeTeamId,
    awayTeamId,
    homeTeamName: String(home?.data?.name || homeTeamId),
    awayTeamName: String(away?.data?.name || awayTeamId),
    date: new Date(dateMs),
    status: 'scheduled',
    createdAt: new Date(),
    createdBy: callerUid,
  };
  if (payload?.location) fields.location = String(payload.location).slice(0, 200);
  if (typeof payload?.matchday === 'number') fields.matchday = Math.max(1, Math.floor(payload.matchday));
  const id = await createDocument(pid, 'fixtures', fields, sa);
  return { id };
}

/** Report the score for a fixture. Body: { fixtureId, homeScore,
 *  awayScore, status? }. Recomputes standings on success. */
export async function reportFixtureScore(
  pid: string,
  sa: ServiceAccount,
  callerUid: string,
  payload: any,
): Promise<{ ok: true; standings: StandingsRow[] }> {
  const fixtureId = String(payload?.fixtureId || '');
  if (!fixtureId) throw new Error('fixture_id_required');
  const fx = await getDocument(pid, `fixtures/${fixtureId}`, sa).catch(() => null);
  if (!fx?.data) throw new Error('fixture_not_found');
  const leagueId = String(fx.data.leagueId || '');
  if (!leagueId) throw new Error('fixture_missing_league');

  const league = await getDocument(pid, `leagues/${leagueId}`, sa).catch(() => null);
  if (!league?.data) throw new Error('league_not_found');
  const admins: string[] = Array.isArray(league.data.adminUids) ? league.data.adminUids : [];
  if (!admins.includes(callerUid) && String(league.data.ownerUid || '') !== callerUid) {
    throw new Error('not_league_admin');
  }

  const homeScore = Number(payload?.homeScore);
  const awayScore = Number(payload?.awayScore);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore < 0 || awayScore < 0) {
    throw new Error('invalid_score');
  }
  const status = ['scheduled', 'live', 'final', 'postponed', 'cancelled'].includes(payload?.status)
    ? String(payload.status)
    : 'final';

  await patchDocument(pid, `fixtures/${fixtureId}`, {
    homeScore: Math.floor(homeScore),
    awayScore: Math.floor(awayScore),
    status,
    reportedAt: new Date(),
    reportedBy: callerUid,
    updatedAt: new Date(),
  }, sa);

  const standings = await recomputeStandings(pid, leagueId, sa);
  return { ok: true, standings };
}
