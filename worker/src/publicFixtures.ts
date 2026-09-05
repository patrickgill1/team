// Public-facing team fixture data. Anonymously readable but gated
// by team.publicFixturesEnabled, so a team has to explicitly flip it
// on before anything about them leaks past auth. Returns JSON the
// public /f/{teamId} page renders.
//
// Response shape (versioned via a top-level `v`):
// {
//   v: 1,
//   team: { id, name, logoUrl?, homeKitColor?, awayKitColor?, audienceType? },
//   upcoming: [ ... game events, soonest first ],
//   recent:   [ ... completed games, most recent first ],
//   roster:   [ ... players whose publicShare.enabled = true ],
// }

import { getDocument, runQuery } from './firestore';
import { parseServiceAccount, ServiceAccount } from './fcm';

interface Env {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
}

const MAX_UPCOMING = 20;
const MAX_RECENT = 10;
const MAX_ROSTER = 40;

function projectAndSA(env: Env): { pid: string; sa: ServiceAccount } | null {
  const pid = env.FIREBASE_PROJECT_ID;
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!pid || !raw) return null;
  return { pid, sa: parseServiceAccount(raw) };
}

function isoOrNull(v: any): string | null {
  if (!v) return null;
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v?.seconds === 'number') return new Date(v.seconds * 1000).toISOString();
  if (typeof v === 'string') return v;
  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Cache for 60s at the edge — coaches update team schedules
      // occasionally and a cold hit shouldn't cost a full Firestore
      // round-trip on every page visit.
      'cache-control': 'public, max-age=60',
      // CORS: this is a public endpoint by design. Allow anywhere.
      'access-control-allow-origin': '*',
    },
  });
}

export async function handlePublicFixtures(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['public', 'team-fixtures', 'TEAMID']
  const teamId = parts[2] || '';
  if (!teamId) return jsonResponse({ ok: false, error: 'team-id-required' }, 400);

  const cfg = projectAndSA(env);
  if (!cfg) return jsonResponse({ ok: false, error: 'server-not-configured' }, 503);
  const { pid, sa } = cfg;

  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!teamDoc) return jsonResponse({ ok: false, error: 'team-not-found' }, 404);
  const teamData: any = (teamDoc as any).data || {};
  if (teamData.publicFixturesEnabled !== true) {
    return jsonResponse({ ok: false, error: 'public-fixtures-not-enabled' }, 404);
  }
  if (teamData.isActive === false) {
    return jsonResponse({ ok: false, error: 'team-archived' }, 404);
  }

  const now = new Date();

  // Pull all game events on this team. Filter/sort in memory —
  // Firestore composite queries with orderBy on a different field
  // than a range filter blow up without a matching index, and events
  // per team are bounded (dozens to low hundreds).
  const events = await runQuery(pid, 'events', [
    { field: 'teamId', op: 'EQUAL', value: teamId },
    { field: 'type',   op: 'EQUAL', value: 'game' },
  ], sa, 250).catch(() => []);

  const games = events
    .map((e: any) => {
      const data = e.data || {};
      const at = isoOrNull(data.date);
      return {
        id: e.id,
        title: String(data.title || 'Match'),
        opponent: String(data.opponent || ''),
        homeAway: data.homeAway || null,
        location: String(data.location || ''),
        fieldNumber: String(data.fieldNumber || ''),
        date: at,
        result: String(data.result || ''),
      };
    })
    .filter(g => !!g.date);

  const upcoming = games
    .filter(g => new Date(g.date!).getTime() >= now.getTime() - 3 * 60 * 60 * 1000) // 3h grace
    .sort((a, b) => new Date(a.date!).getTime() - new Date(b.date!).getTime())
    .slice(0, MAX_UPCOMING);

  const recent = games
    .filter(g => new Date(g.date!).getTime() < now.getTime() - 3 * 60 * 60 * 1000)
    .sort((a, b) => new Date(b.date!).getTime() - new Date(a.date!).getTime())
    .slice(0, MAX_RECENT);

  // Roster: players tied to this team who've opted into public
  // share. Note: `array-contains teamIds` requires no index but we
  // also fall back to legacy single-team players via teamId. Adult
  // teams generally have all-adult roster, so no age/DOB is exposed.
  const players = await runQuery(pid, 'players', [
    { field: 'teamId', op: 'EQUAL', value: teamId },
  ], sa, 200).catch(() => []);

  const roster = players
    .map((p: any) => ({ id: p.id, data: p.data || {} }))
    .filter(p => p.data.isActive !== false)
    .filter(p => p.data.publicShare?.enabled === true)
    .slice(0, MAX_ROSTER)
    .map(p => ({
      id: p.id,
      name: String(p.data.name || 'Player'),
      jerseyNumber: typeof p.data.jerseyNumber === 'number' ? p.data.jerseyNumber : null,
      position: p.data.position || (Array.isArray(p.data.positions) ? p.data.positions[0] : null),
      profilePhotoUrl: p.data.profilePhotoUrl || null,
      preferredFoot: p.data.preferredFoot || null,
      secondaryPosition: p.data.secondaryPosition || null,
      heightCm: typeof p.data.heightCm === 'number' ? p.data.heightCm : null,
      pastClubs: Array.isArray(p.data.pastClubs) ? p.data.pastClubs.slice(0, 4) : null,
    }));

  return jsonResponse({
    v: 1,
    team: {
      id: teamId,
      name: String(teamData.name || 'Team'),
      logoUrl: teamData.logoUrl || null,
      homeKitColor: teamData.homeKitColor || null,
      awayKitColor: teamData.awayKitColor || null,
      audienceType: teamData.audienceType || 'youth',
      season: teamData.season || null,
      league: teamData.league || null,
      homeField: teamData.homeField || null,
    },
    upcoming,
    recent,
    roster,
  });
}

// ────────────────────────────────────────────────────────────────
// /public/voting/:votingId/roster
//
// Sanitized player list for the anonymous /vote page. Replaces a
// direct Firestore `players` list query that previously ran from
// the browser and returned every player's full doc (DOB, medical,
// parentEmails, etc) to any voter. This endpoint returns ONLY the
// fields the ballot renders: name, jersey number, profile photo.
//
// Gated by the match_votings doc existing + isActive. No auth —
// this is the parent-facing vote link that gets shared out via
// text and social. Response is edge-cached briefly.
// ────────────────────────────────────────────────────────────────
const MAX_VOTING_ROSTER = 40;

export async function handlePublicVotingRoster(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['public','voting','VID','roster']
  const votingId = parts[2] || '';
  if (!votingId) return jsonResponse({ ok: false, error: 'voting-id-required' }, 400);

  const cfg = projectAndSA(env);
  if (!cfg) return jsonResponse({ ok: false, error: 'server-not-configured' }, 503);
  const { pid, sa } = cfg;

  const votingDoc = await getDocument(pid, `match_votings/${votingId}`, sa).catch(() => null);
  if (!votingDoc) return jsonResponse({ ok: false, error: 'voting-not-found' }, 404);
  const v: any = (votingDoc as any).data || {};
  const teamId = String(v.teamId || '');
  if (!teamId) return jsonResponse({ ok: false, error: 'voting-missing-team' }, 500);

  // Pull the team's active players. Two queries because some legacy
  // player docs only have teamId (string) while newer ones have
  // teamIds (array). Merge + dedupe.
  const [byTeamIds, byLegacyTeamId] = await Promise.all([
    runQuery(pid, 'players', [
      { field: 'teamIds', op: 'ARRAY_CONTAINS', value: teamId },
    ], sa, 200).catch(() => []),
    runQuery(pid, 'players', [
      { field: 'teamId', op: 'EQUAL', value: teamId },
    ], sa, 200).catch(() => []),
  ]);
  const seen = new Set<string>();
  const combined: any[] = [];
  for (const p of [...byTeamIds, ...byLegacyTeamId]) {
    if (!p?.id || seen.has(p.id)) continue;
    seen.add(p.id);
    combined.push(p);
  }

  const eligible: string[] = Array.isArray(v.eligiblePlayerIds) ? v.eligiblePlayerIds.map(String) : [];

  const roster = combined
    .map((p: any) => ({ id: String(p.id), data: p.data || {} }))
    .filter(p => p.data.isActive !== false)
    // If the voting has an eligibility list, respect it. Otherwise
    // show every active player.
    .filter(p => eligible.length === 0 || eligible.includes(p.id))
    .sort((a, b) => {
      const ja = typeof a.data.jerseyNumber === 'number' ? a.data.jerseyNumber : 999;
      const jb = typeof b.data.jerseyNumber === 'number' ? b.data.jerseyNumber : 999;
      return ja - jb;
    })
    .slice(0, MAX_VOTING_ROSTER)
    .map(p => ({
      id: p.id,
      name: String(p.data.name || 'Player'),
      jerseyNumber: typeof p.data.jerseyNumber === 'number' ? p.data.jerseyNumber : null,
      profilePhotoUrl: p.data.profilePhotoUrl || null,
    }));

  return jsonResponse({ ok: true, teamId, players: roster });
}

// ────────────────────────────────────────────────────────────────
// /public/invite-preview/:inviteId
//
// Returns { ok, title, description, image } for a self-serve /join
// link. Called server-side by the Vercel edge route that injects
// dynamic Open Graph tags into the invite page HTML so WhatsApp /
// iMessage / Slack / Facebook show team-specific link previews
// ("Join STG Liverpool Depends 40+") instead of the generic app
// description.
//
// No auth. Invite IDs are 12-char URL-safe slugs generated with
// crypto.getRandomValues (see src/utils/invites.ts newSlug), so an
// attacker cannot enumerate. Even if they could, the response only
// exposes team name + team cover photo + audience — all of which
// leak to the joiner on the /join page itself.
//
// Edge-cached briefly (60s) since the same invite may get scraped
// once by every messaging app that saw the link.
// ────────────────────────────────────────────────────────────────
export async function handleInvitePreview(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['public','invite-preview','INVITEID']
  const inviteId = parts[2] || '';
  if (!inviteId) return jsonResponse({ ok: false, error: 'invite-id-required' }, 400);

  const cfg = projectAndSA(env);
  if (!cfg) return jsonResponse({ ok: false, error: 'server-not-configured' }, 503);
  const { pid, sa } = cfg;

  const inviteDoc = await getDocument(pid, `invites/${inviteId}`, sa).catch(() => null);
  if (!inviteDoc) return jsonResponse({ ok: false, error: 'invite-not-found' }, 404);
  const inv: any = (inviteDoc as any).data || {};
  const teamId = String(inv.teamId || '');
  if (!teamId) return jsonResponse({ ok: false, error: 'invite-missing-team' }, 500);

  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const t: any = (teamDoc as any)?.data || {};
  const teamName = String(t.name || 'the team');
  const audience = String(t.audienceType || '');

  // Prefer a team-specific hero image. Coaches can upload a cover
  // photo (t.coverPhotoUrl) that shows on the public /f/{teamId}
  // page; reuse it as the OG image so the link preview matches the
  // brand the joiner will see. Fall back to the app logo so we
  // never ship a broken preview.
  const image = String(t.coverPhotoUrl || 'https://app.goalkickr.com/logo512.png');

  // Copy shape per invite type. Adult teams read as pickup /
  // recreational; youth teams read as family-oriented; staff
  // invites frame as "join the coaching staff."
  const inviteType = String(inv.type || '');
  let title = `Join ${teamName}`;
  let description = 'Team management for soccer. RSVPs, chat, stats, and media in one place.';
  if (inviteType === 'team_self_serve_adult' || audience === 'adult') {
    description = `Tap in on ${teamName}. RSVPs, team chat, and match updates on your device.`;
  } else if (inviteType === 'player') {
    const playerName = String(inv.playerName || '').trim();
    title = playerName ? `Follow ${playerName} on ${teamName}` : `Join ${teamName}`;
    description = 'See match updates, clips, and shoutouts as they happen.';
  } else if (inviteType === 'coach') {
    title = `Coach ${teamName}`;
    description = 'Join the coaching staff. RSVPs, roster, stats, and team comms.';
  } else if (inviteType === 'team_manager') {
    title = `Manage ${teamName}`;
    description = 'Team manager access to roster, RSVPs, and comms.';
  }

  return jsonResponse({ ok: true, title, description, image, teamName });
}
