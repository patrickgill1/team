/**
 * Post-game POTM auto-create.
 *
 * Runs on the daily 10am MDT cron (`0 16 * * *`). Scans events whose
 * type='game' date has passed within the last 48h and:
 *   - are not cancelled
 *   - have autoCreatePotm !== false (default true)
 *   - have countsToStats !== false (scrimmages/tournaments opt out)
 *   - don't already have a potmVotingId stamped
 *   - don't have a match_votings doc linked via calendarEventId
 *   - live on a non-demo team
 *
 * For each match:
 *   1. Creates a match_votings doc with the event's metadata
 *   2. Infers eligiblePlayerIds from playerRsvps.byUid where status='going'
 *   3. Posts the "Vote for Player of the Match" CTA to the team's wall
 *   4. Stamps potmVotingId + potmAutoCreatedAt on the event so we never
 *      double-fire on re-scan
 *
 * Idempotency belt-and-suspenders: an event that's been manually
 * voted-on (coach opened PlayerOfMatch and created the voting) has a
 * match_votings doc with calendarEventId=event.id — we detect that via
 * a runQuery and skip.
 */

import { ServiceAccount } from './fcm';
import { getDocument, patchDocument, createDocument, runQuery } from './firestore';

interface Env {
  FCM_SERVICE_ACCOUNT?: string;
  FIREBASE_PROJECT_ID?: string;
}

export async function runPotmAutoCreate(env: Env): Promise<{
  ok: boolean;
  scanned: number;
  created: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let created = 0;

  if (!env.FCM_SERVICE_ACCOUNT) return { ok: false, scanned: 0, created, errors: ['no-service-account'] };
  const { parseServiceAccount } = await import('./fcm');
  let sa: ServiceAccount;
  try { sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT); }
  catch { return { ok: false, scanned: 0, created, errors: ['bad-service-account'] }; }
  const projectId = env.FIREBASE_PROJECT_ID || sa.project_id;
  if (!projectId) return { ok: false, scanned: 0, created, errors: ['no-project-id'] };

  const now = new Date();
  const windowStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  // Post-game buffer: never auto-create while a game may still be
  // on the field. Kids matches run ~60min + warmup / OT / handshake;
  // adult games ~90min + buffer. 3h from kickoff is a safe "the ref
  // has definitely whistled full time" heuristic. Coaches who use
  // GameDay to run the live game get the wall CTA immediately when
  // they tap End Game via the live_games shortcut below — so this
  // buffer only affects coaches who don't run GameDay.
  const GAME_END_BUFFER_MS = 3 * 60 * 60 * 1000;
  const bufferedEnd = new Date(now.getTime() - GAME_END_BUFFER_MS);

  const events = await runQuery(projectId, 'events', [
    { field: 'date', op: 'GREATER_THAN_OR_EQUAL', value: windowStart },
    { field: 'date', op: 'LESS_THAN', value: now },
  ], sa, 300).catch((err: any) => {
    errors.push(`events-query-failed: ${String(err?.message || err).slice(0, 200)}`);
    return [] as Array<{ id: string; data: any }>;
  });

  for (const ev of events) {
    const eid = ev.id;
    const data: any = ev.data || {};

    // Filters that must-all-be-true to fire.
    if (data.type !== 'game') continue;
    if (data.isCancelled === true) continue;
    if (data.autoCreatePotm === false) continue;
    if (data.countsToStats === false) continue;
    if (data.potmVotingId) continue;
    if (!data.teamId) continue;

    // Game-end guard: skip while the match is (likely) still on the
    // field. Two accept paths:
    //   1. GameDay live_games doc for this event has status='final' →
    //      fire immediately (coach ended the game manually).
    //   2. Event kickoff was more than GAME_END_BUFFER_MS ago →
    //      whistle has definitely blown; fire.
    const eventDateRaw: any = data.date;
    let eventMs = 0;
    if (eventDateRaw instanceof Date) eventMs = eventDateRaw.getTime();
    else if (typeof eventDateRaw?.toDate === 'function') { try { eventMs = eventDateRaw.toDate().getTime(); } catch { /* ignore */ } }
    else if (typeof eventDateRaw?.seconds === 'number') eventMs = eventDateRaw.seconds * 1000;
    if (eventMs > bufferedEnd.getTime()) {
      // Still inside the buffer window — allow only if the coach ended
      // the game in GameDay (live_games status=final).
      const liveDoc = await getDocument(projectId, `live_games/${eid}`, sa).catch(() => null);
      if (liveDoc?.data?.status !== 'final') continue;
    }

    // Skip demo teams — no fake CTAs on the screenshot team.
    try {
      const team = await getDocument(projectId, `teams/${data.teamId}`, sa).catch(() => null);
      if (team?.data?.isDemo === true) continue;

      // Also honor team.xpConfig — if the coach turned off gamification,
      // don't push POTM voting onto their wall automatically. They
      // can still create manually.
      if (team?.data?.xpConfig?.enabled === false) continue;

      // Belt-and-suspenders: check for an existing match_votings that
      // links to this calendar event (coach already created manually
      // between rescans). Skip if found.
      const existing = await runQuery(projectId, 'match_votings', [
        { field: 'calendarEventId', op: 'EQUAL', value: eid },
      ], sa, 1).catch(() => [] as Array<{ id: string; data: any }>);
      if (existing.length > 0) {
        // Stamp the event so we don't re-check next tick.
        await patchDocument(projectId, `events/${eid}`, {
          potmVotingId: existing[0].id,
          potmAutoCreatedAt: now,
        }, sa).catch(err => {
          errors.push(`stamp-existing-failed: ${eid}`);
          console.warn('[potm-auto] stamp existing failed', eid, err);
        });
        continue;
      }

      // Infer eligible players from playerRsvps.byUid status='going'.
      // PlayerRsvps map is keyed by playerId with { status, byUid? }.
      const eligiblePlayerIds: string[] = [];
      if (data.playerRsvps && typeof data.playerRsvps === 'object') {
        for (const [pid, entry] of Object.entries(data.playerRsvps as any)) {
          if (!pid) continue;
          if ((entry as any)?.status === 'going') eligiblePlayerIds.push(pid);
        }
      }

      // Resolve season for the game date so the voting rolls into the
      // right season leaderboard.
      let seasonId: string | undefined;
      try {
        const seasons = await runQuery(projectId, 'seasons', [
          { field: 'teamId', op: 'EQUAL', value: data.teamId },
        ], sa, 20).catch(() => [] as Array<{ id: string; data: any }>);
        const gameDate = data.date?.toDate ? data.date.toDate() : new Date(data.date);
        const match = seasons.find(s => {
          const start = s.data?.startDate?.toDate ? s.data.startDate.toDate() : (s.data?.startDate ? new Date(s.data.startDate) : null);
          const end = s.data?.endDate?.toDate ? s.data.endDate.toDate() : (s.data?.endDate ? new Date(s.data.endDate) : null);
          if (!start || !end) return false;
          return gameDate >= start && gameDate <= end && s.data?.isActive !== false;
        });
        if (match) seasonId = match.id;
      } catch (err) {
        console.warn('[potm-auto] season lookup failed', eid, err);
      }

      // Identity fallback pattern from digest.ts:375-376.
      const senderId: string = String(team?.data?.headCoachId || 'team-wall-bot');
      const senderName: string = 'GoalKickr';

      // Build the match_votings doc (shape mirrors PlayerOfMatch client
      // create at src/pages/PlayerOfMatch.tsx:170-184).
      const gameDate = data.date?.toDate ? data.date.toDate() : new Date(data.date);
      const votingPayload: Record<string, any> = {
        gameId: eid,
        gameTitle: data.title || 'Match',
        gameDate,
        calendarEventId: eid,
        isActive: true,
        votes: [],
        teamId: data.teamId,
        createdBy: senderId,
        createdByName: senderName,
        createdAt: now,
        eligiblePlayerIds,
      };
      if (data.location) votingPayload.location = data.location;
      if (data.opponent) votingPayload.opponent = data.opponent;
      if (data.homeAway) votingPayload.homeAway = data.homeAway;
      if (seasonId) votingPayload.seasonId = seasonId;

      const votingId = await createDocument(projectId, 'match_votings', votingPayload, sa);

      // Post the "Vote for Player of the Match" CTA to the team wall.
      // Content markdown mirrors autoPostPotmVotingOpenToWall() so
      // the wall renderer treats worker-generated + client-generated
      // posts identically.
      const content = [
        '## Vote for Player of the Match',
        `**${votingPayload.gameTitle}**`,
        '',
        `[Cast your vote →](/vote/${votingId})`,
        '',
        '_Results reveal when voting closes. Vote for anyone but your own kid._',
      ].join('\n');
      await createDocument(projectId, 'wall_posts', {
        teamId: data.teamId,
        content,
        senderId,
        senderName,
        senderRole: 'coach',
        timestamp: now,
        attachments: null,
        reactions: [],
        wallPinnedTop: null,
        postedFrom: 'potm',
      }, sa).catch(err => {
        console.warn('[potm-auto] wall post failed', eid, err);
      });

      // Stamp the event so we never re-fire on this event.
      await patchDocument(projectId, `events/${eid}`, {
        potmVotingId: votingId,
        potmAutoCreatedAt: now,
      }, sa);

      created++;
    } catch (err: any) {
      const msg = String(err?.message || err).slice(0, 200);
      errors.push(`event-failed: ${eid}: ${msg}`);
      console.warn('[potm-auto] event failed', eid, err);
    }
  }

  return { ok: true, scanned: events.length, created, errors };
}
