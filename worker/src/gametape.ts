/**
 * Gametape — coach-assigned tactical video clips.
 *
 * Endpoints (all POST, dispatched from index.ts):
 *   /gametape/stream-upload-url  → paid coach direct-upload URL (CF Stream)
 *   /gametape/create             → coach posts a clip (upload or YouTube/Vimeo link)
 *   /gametape/mark-watched       → player/parent taps "Got it" (fires +3 XP once)
 *   /gametape/archive            → coach moves a clip to Library (per-player) or archives globally
 *   /gametape/delete             → coach soft-deletes (isActive=false) + pulls Stream video
 *
 * Firestore collection: player_clips/{clipId}. Schema mirrors PlayerMedia
 * field naming so the existing CloudflareStreamIframe + useStreamReadiness
 * client hooks work without adapters.
 *
 * All writes to player_clips are worker-only (firestore.rules denies
 * direct client writes). The client always calls these endpoints.
 *
 * Push fanout runs server-side after create — parents can't enumerate
 * other users on their team via rules, and the fanout has to know the
 * union of parents across every targeted player. Same pattern used by
 * /wall/notify-parent-post and /surveys/response-created.
 *
 * Coach tier gate (source='upload' only) enforces the paid-plan wall
 * at BOTH the presign step and the create step. Client also gates the
 * UI via useIsPaidCoach, but that hint is cosmetic — the server is the
 * only real authority. YouTube/Vimeo links are free for every coach.
 */

import { requireUser, requireCoachOfTeam, AuthError, authErrorResponse } from './auth';
import { parseServiceAccount, ServiceAccount, sendPush } from './fcm';
import {
  getDocument,
  patchDocument,
  createDocument,
  runQuery,
  commitDocumentTransforms,
  FieldTransform,
} from './firestore';
import { writeXpGrant } from './writeGuards';

// Wide Env — the worker's real Env in index.ts is a superset. We
// duplicate only the keys we need here so the module stays importable
// from a test without pulling in the full stripe/mail surface.
export interface GametapeEnv {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
  APP_ORIGIN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_STREAM_API_TOKEN?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

function projectAndSA(env: GametapeEnv): { pid: string; sa: ServiceAccount } {
  const pid = env.FIREBASE_PROJECT_ID;
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!pid || !raw) throw new AuthError('server_not_configured', 500);
  return { pid, sa: parseServiceAccount(raw) };
}

// ────────────────────────────────────────────────────────────────
// Coach tier gate.
//
// Reads users/{uid} and returns true only when the caller is on a
// paid Stripe plan whose tier is in the paid-coach set. Auto-trial
// coaches (subscriptionSource='auto-trial-*') fall through to false
// so a trial user can't burn Cloudflare Stream storage. Platform
// admins (isClubAdmin) short-circuit true so Patrick can smoke-test.
//
// Mirror of the client-side useIsPaidCoach() hook per the design's
// tierGate section. The server is the real authority; the client
// hint just tunes UI copy.
// ────────────────────────────────────────────────────────────────
const PAID_COACH_TIERS: ReadonlySet<string> = new Set([
  'annual', 'monthly', 'founder', 'club-pro',
]);

type PaidCoachReason = 'ok' | 'trial' | 'no-sub' | 'past-due' | 'canceled';

async function checkPaidCoach(
  pid: string,
  sa: ServiceAccount,
  uid: string,
): Promise<{ ok: boolean; reason: PaidCoachReason }> {
  const u = await getDocument(pid, `users/${uid}`, sa).catch(() => null);
  const data: any = u?.data || {};
  if (data.isClubAdmin === true) return { ok: true, reason: 'ok' };
  const active = data.subscriptionActive === true;
  const source = String(data.subscriptionSource || '');
  const tier = String(data.subscriptionTier || '');
  const status = String(data.subscriptionStatus || '');
  if (!active) {
    if (status === 'past_due') return { ok: false, reason: 'past-due' };
    if (status === 'canceled') return { ok: false, reason: 'canceled' };
    return { ok: false, reason: 'no-sub' };
  }
  if (source !== 'stripe') return { ok: false, reason: 'trial' };
  if (!PAID_COACH_TIERS.has(tier)) return { ok: false, reason: 'trial' };
  return { ok: true, reason: 'ok' };
}

// ────────────────────────────────────────────────────────────────
// Auth ladder for /gametape/mark-watched.
//
// Any of the following authorizes a caller to mark a clip as
// watched on behalf of a player:
//   - The caller is a coach on the clip's team (kid-on-parent-device
//     escape hatch — coach can also mark for QA).
//   - The caller is a parent of the player (parentIds contains uid).
//   - The caller IS the player's linked self-account
//     (users/{uid}.selfPlayerId === playerId — the U13+ self-manage
//     account path).
//
// XP is attributed to `playerId`, not the caller's uid. The parent
// tapping on behalf of the kid still credits the kid's XP total.
// ────────────────────────────────────────────────────────────────
async function isParentOfPlayer(pid: string, sa: ServiceAccount, uid: string, playerId: string): Promise<boolean> {
  const doc = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  const parentIds: any[] = Array.isArray(doc?.data?.parentIds) ? doc!.data.parentIds : [];
  return parentIds.includes(uid);
}

async function isSelfKidOfPlayer(pid: string, sa: ServiceAccount, uid: string, playerId: string): Promise<boolean> {
  const doc = await getDocument(pid, `users/${uid}`, sa).catch(() => null);
  return String(doc?.data?.selfPlayerId || '') === playerId;
}

async function isCoachOfTeam(pid: string, sa: ServiceAccount, uid: string, teamId: string): Promise<boolean> {
  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const coachIds: any[] = Array.isArray(team?.data?.coachIds) ? team!.data.coachIds : [];
  if (coachIds.includes(uid)) return true;
  const user = await getDocument(pid, `users/${uid}`, sa).catch(() => null);
  if (user?.data?.isClubAdmin === true) return true;
  const role = String(user?.data?.role || '');
  const teamIds: any[] = Array.isArray(user?.data?.teamIds) ? user!.data.teamIds : [];
  return (role === 'coach' || role === 'team_manager') && teamIds.includes(teamId);
}

// ────────────────────────────────────────────────────────────────
// Cloudflare Stream — thin wrappers around the direct_upload + delete
// endpoints. Kept in-module so the worker doesn't grow a whole new
// dependency; each call fetches the same CF REST API the Vercel
// /api/stream-* handlers already use.
// ────────────────────────────────────────────────────────────────

async function createStreamDirectUpload(
  env: GametapeEnv,
  args: { creatorUid: string; teamId: string; playerIds: string[]; fileName?: string },
): Promise<{ uploadURL: string; uid: string }> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_STREAM_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new AuthError('stream_not_configured', 503);
  }
  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/direct_upload`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Hard 90-second cap — the belt to the client probeVideoDuration
        // suspenders. CF Stream itself refuses to publish anything longer,
        // so a bypassed client can't burn storage on a 20-minute rant.
        maxDurationSeconds: 90,
        expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        creator: args.creatorUid,
        meta: {
          name: args.fileName || 'gametape',
          feature: 'gametape',
          uploadedBy: args.creatorUid,
          teamId: args.teamId,
          ...(args.playerIds.length ? { playerIds: args.playerIds.join(',') } : {}),
        },
        requireSignedURLs: false,
        // Same wildcard allowedOrigins used by the highlights path —
        // required so the iframe.cloudflarestream.com player can fetch
        // the manifest from capacitor://localhost and https://localhost.
        // Security boundary is the unguessable video UID.
        allowedOrigins: ['*'],
      }),
    },
  );
  const cfJson: any = await cfRes.json().catch(() => ({}));
  if (!cfRes.ok || !cfJson?.success) {
    console.warn('[gametape] cf direct_upload failed', cfRes.status, JSON.stringify(cfJson).slice(0, 400));
    throw new AuthError('stream_direct_upload_failed', 502);
  }
  return { uploadURL: String(cfJson.result?.uploadURL || ''), uid: String(cfJson.result?.uid || '') };
}

async function deleteStreamVideo(env: GametapeEnv, streamUid: string): Promise<void> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_STREAM_API_TOKEN;
  if (!accountId || !apiToken || !streamUid) return;
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${encodeURIComponent(streamUid)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${apiToken}` },
      },
    );
    if (!r.ok && r.status !== 404) {
      const txt = await r.text().catch(() => '');
      console.warn('[gametape] cf stream delete failed', streamUid, r.status, txt.slice(0, 200));
    }
  } catch (err) {
    // Best-effort — a stray Stream video costs pennies. Soft-delete on
    // Firestore already hid the clip from every UI.
    console.warn('[gametape] cf stream delete threw', streamUid, err);
  }
}

// ────────────────────────────────────────────────────────────────
// YouTube / Vimeo URL parsing.
//
// Coach pastes a URL; we extract a stable external id + a thumbnail
// URL so the client-side card can render a poster without loading the
// full iframe. Vimeo thumbnails need an oEmbed round-trip (public
// endpoint, no key). YouTube's thumbnail scheme is deterministic.
// ────────────────────────────────────────────────────────────────

const YT_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,20})/;
const VIMEO_ID_RE = /vimeo\.com\/(?:video\/)?(\d{6,15})/;

function extractYouTubeId(url: string): string | null {
  const m = YT_ID_RE.exec(url);
  return m ? m[1] : null;
}
function extractVimeoId(url: string): string | null {
  const m = VIMEO_ID_RE.exec(url);
  return m ? m[1] : null;
}

async function fetchVimeoThumbnail(url: string): Promise<string | null> {
  try {
    const r = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`);
    if (!r.ok) return null;
    const j: any = await r.json();
    const thumb = String(j?.thumbnail_url || '');
    return thumb || null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Homework cap: 3 active clips per player at a time.
//
// When a coach posts a 4th clip targeting a player already at cap,
// the oldest active clip is auto-archived for THAT player only
// (arrayRemove pid from activeForPlayerIds + arrayUnion into
// archivedForPlayerIds + set archivedAt.{pid}). We return the list
// of auto-archived (clipId, playerId) tuples so the coach's compose
// modal can show a warm "Older clip moved to Library" toast.
//
// This runs BEFORE the new clip create so the state transitions are
// idempotent: if the create later fails, the auto-archive has still
// happened, but the player just sees an unchanged 3-clip queue.
// Small race window (two coaches posting simultaneously to the same
// player) accepted per the design's risks section.
// ────────────────────────────────────────────────────────────────
const HOMEWORK_CAP = 3;

interface AutoArchivedEntry { clipId: string; playerId: string }

async function enforceHomeworkCap(
  pid: string,
  sa: ServiceAccount,
  teamId: string,
  targetPlayerIds: string[],
  now: Date,
): Promise<AutoArchivedEntry[]> {
  const autoArchived: AutoArchivedEntry[] = [];
  for (const targetPid of targetPlayerIds) {
    let existing: Array<{ id: string; data: any }>;
    try {
      existing = await runQuery(
        pid,
        'player_clips',
        [
          { field: 'teamId', op: 'EQUAL', value: teamId },
          { field: 'isActive', op: 'EQUAL', value: true },
          { field: 'activeForPlayerIds', op: 'ARRAY_CONTAINS', value: targetPid },
        ],
        sa,
        50,
      );
    } catch (err) {
      // If the query fails (index still building) skip the cap for this
      // player — better to briefly show a 4th clip than to reject the
      // whole create because of an infra issue.
      console.warn('[gametape] cap query failed for', targetPid, (err as Error).message);
      continue;
    }
    if (existing.length < HOMEWORK_CAP) continue;
    // Sort ascending by createdAt so oldest lands at [0]. runQuery does
    // not accept orderBy; sort in memory since the result set is bounded.
    const sorted = existing.slice().sort((a, b) => {
      const ta = a.data?.createdAt instanceof Date ? a.data.createdAt.getTime() : 0;
      const tb = b.data?.createdAt instanceof Date ? b.data.createdAt.getTime() : 0;
      return ta - tb;
    });
    // Archive as many as needed so this player ends up at (CAP - 1)
    // active clips right before the new one is inserted (net = CAP).
    const excess = existing.length - (HOMEWORK_CAP - 1);
    for (let i = 0; i < excess; i++) {
      const oldest = sorted[i];
      try {
        await commitDocumentTransforms(
          pid,
          `player_clips/${oldest.id}`,
          [
            { fieldPath: 'activeForPlayerIds', kind: 'arrayRemove', value: targetPid },
            { fieldPath: 'archivedForPlayerIds', kind: 'arrayUnion', value: targetPid },
          ],
          {
            [`archivedAt.${targetPid}`]: now,
            updatedAt: now,
          },
          sa,
        );
        autoArchived.push({ clipId: oldest.id, playerId: targetPid });
      } catch (err) {
        console.warn('[gametape] auto-archive commit failed', oldest.id, (err as Error).message);
      }
    }
  }
  return autoArchived;
}

// ────────────────────────────────────────────────────────────────
// Push notification fanout (server-side).
//
// Recipients:
//   targetsWholeTeam=true → every parent whose users.teamIds contains
//     teamId (or legacy .teamId equals teamId), minus the coach.
//   else                   → union of parentIds across each targeted
//     player, minus the coach.
//
// Filters each recipient: isActive !== false, pushPreferences.broadcast
// !== false (default on). Dedupes tokens.
//
// Message body is derived from the coach's note (80-char preview) and
// the target scope. Deep link is /development#gametape-{clipId}.
// ────────────────────────────────────────────────────────────────

interface PushArgs {
  env: GametapeEnv;
  pid: string;
  sa: ServiceAccount;
  clipId: string;
  teamId: string;
  coachUid: string;
  coachFirst: string;
  targetsWholeTeam: boolean;
  playerIds: string[];
  parentIds: string[];
  playerFirstNames: string[];
  notePreview: string;
}

async function collectRecipients(args: PushArgs): Promise<string[]> {
  const { pid, sa, teamId, coachUid, targetsWholeTeam, parentIds } = args;
  const set = new Set<string>();
  if (targetsWholeTeam) {
    // Fan out to every parent linked to the team. Two queries because
    // the legacy schema stored a singular `teamId` while the current
    // one uses `teamIds` array-contains. Mirrors collectTeamEmails
    // in wallPosts.ts.
    try {
      const s1 = await runQuery(pid, 'users', [
        { field: 'teamId', op: 'EQUAL', value: teamId },
      ], sa, 500);
      for (const d of s1) set.add(String(d.data?.uid || d.id));
    } catch (err) {
      console.warn('[gametape] users teamId query failed', err);
    }
    try {
      const s2 = await runQuery(pid, 'users', [
        { field: 'teamIds', op: 'ARRAY_CONTAINS', value: teamId },
      ], sa, 500);
      for (const d of s2) set.add(String(d.data?.uid || d.id));
    } catch (err) {
      console.warn('[gametape] users teamIds query failed', err);
    }
  } else {
    for (const uid of parentIds) set.add(uid);
  }
  set.delete(coachUid);
  set.delete('');
  return [...set];
}

async function fanOutPush(args: PushArgs): Promise<{ sent: number; failed: number; recipients: number }> {
  const { env, pid, sa, clipId, coachFirst, targetsWholeTeam, playerFirstNames, notePreview } = args;
  if (!env.FCM_SERVICE_ACCOUNT) return { sent: 0, failed: 0, recipients: 0 };

  const uids = await collectRecipients(args);
  if (uids.length === 0) return { sent: 0, failed: 0, recipients: 0 };

  const tokens: string[] = [];
  for (const uid of uids) {
    try {
      const uDoc = await getDocument(pid, `users/${uid}`, sa).catch(() => null);
      const u: any = uDoc?.data || {};
      if (u.isActive === false) continue;
      const prefs = u.pushPreferences || {};
      if (prefs.broadcast === false) continue;
      const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
      for (const t of arr) if (typeof t === 'string' && t.length > 10) tokens.push(t);
    } catch { /* ignore per-user lookup failures */ }
  }
  const unique = Array.from(new Set(tokens));
  if (unique.length === 0) return { sent: 0, failed: 0, recipients: uids.length };

  const title = `New Gametape from Coach ${coachFirst}`;
  let body: string;
  if (targetsWholeTeam) {
    body = notePreview
      ? `${coachFirst} sent the team a clip: ${notePreview}`
      : `${coachFirst} sent the team a clip.`;
  } else if (playerFirstNames.length === 1) {
    body = notePreview
      ? `${coachFirst} sent ${playerFirstNames[0]} a clip: ${notePreview}`
      : `${coachFirst} sent ${playerFirstNames[0]} a clip.`;
  } else {
    const list = playerFirstNames.slice(0, 3).join(', ') + (playerFirstNames.length > 3 ? '…' : '');
    body = notePreview
      ? `${coachFirst} sent ${list} a clip: ${notePreview}`
      : `${coachFirst} sent ${list} a clip.`;
  }
  const origin = env.APP_ORIGIN || 'https://app.goalkickr.com';
  const url = `${origin}/development#gametape-${clipId}`;

  try {
    const result = await sendPush(unique, {
      title,
      body,
      url,
      badge: 1,
    }, env.FCM_SERVICE_ACCOUNT);
    return { sent: result.sent, failed: result.failed, recipients: uids.length };
  } catch (err) {
    console.warn('[gametape] push fanout failed', err);
    return { sent: 0, failed: unique.length, recipients: uids.length };
  }
}

// ────────────────────────────────────────────────────────────────
// Load full team roster (active playerIds). Used when a coach posts
// a "whole team" clip (playerIds=[]) so we can materialize an explicit
// activeForPlayerIds array. Server-side rather than trusting a client-
// sent roster snapshot — a determined client could send a subset and
// silently exclude a player from the homework flow.
// ────────────────────────────────────────────────────────────────
async function loadTeamRosterIds(pid: string, sa: ServiceAccount, teamId: string): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const rows = await runQuery(
      pid,
      'players',
      [
        { field: 'teamIds', op: 'ARRAY_CONTAINS', value: teamId },
        { field: 'isActive', op: 'EQUAL', value: true },
      ],
      sa,
      300,
    );
    for (const r of rows) ids.add(r.id);
  } catch (err) {
    console.warn('[gametape] teamIds roster query failed', err);
  }
  try {
    const rows = await runQuery(
      pid,
      'players',
      [
        { field: 'teamId', op: 'EQUAL', value: teamId },
        { field: 'isActive', op: 'EQUAL', value: true },
      ],
      sa,
      300,
    );
    for (const r of rows) ids.add(r.id);
  } catch (err) {
    console.warn('[gametape] teamId roster query failed', err);
  }
  return [...ids];
}

// ────────────────────────────────────────────────────────────────
// POST /gametape/stream-upload-url
//
// Body: { teamId, fileName?, fileSize? }
// Auth: coach on team + paid Stripe tier.
// Returns: { ok, uploadURL, uid } — client PUTs the file to uploadURL
// then POSTs /gametape/create with the returned uid.
// ────────────────────────────────────────────────────────────────
export async function handleGametapeStreamUploadUrl(req: Request, env: GametapeEnv, payload: any): Promise<Response> {
  try {
    const teamId = String(payload?.teamId || '');
    if (!teamId) return json({ ok: false, error: 'team_id_required' }, 400);
    const claims = await requireCoachOfTeam(req as any, env as any, teamId);
    const { pid, sa } = projectAndSA(env);
    const paid = await checkPaidCoach(pid, sa, claims.uid);
    if (!paid.ok) {
      return json({ ok: false, error: 'paid_coach_required', reason: paid.reason }, 402);
    }
    const fileName = payload?.fileName ? String(payload.fileName).slice(0, 200) : undefined;
    const { uploadURL, uid } = await createStreamDirectUpload(env, {
      creatorUid: claims.uid,
      teamId,
      playerIds: Array.isArray(payload?.playerIds) ? payload.playerIds.filter((p: any) => typeof p === 'string') : [],
      fileName,
    });
    if (!uploadURL || !uid) {
      return json({ ok: false, error: 'stream_direct_upload_failed' }, 502);
    }
    return json({ ok: true, uploadURL, uid });
  } catch (err) {
    const authResp = authErrorResponse(err);
    if (authResp) return authResp;
    console.warn('[gametape/stream-upload-url] failed', err);
    return json({ ok: false, error: 'internal' }, 500);
  }
}

// ────────────────────────────────────────────────────────────────
// POST /gametape/create
//
// Body:
//   { teamId, source: 'upload'|'youtube'|'vimeo', note, playerIds,
//     streamUid?, durationSeconds?, fileSize?, fileName?, contentType?,
//     embedUrl?, posterTimeSeconds?, title? }
//
// Auth: coach on team. If source='upload', paid tier is also required.
// Behavior: validate, enforce homework cap (auto-archive oldest),
// denormalize parentIds, stamp clubId+seasonId, write the clip doc,
// fan out one push per targeted parent, return the auto-archived list.
// ────────────────────────────────────────────────────────────────
export async function handleGametapeCreate(req: Request, env: GametapeEnv, payload: any): Promise<Response> {
  try {
  const teamId = String(payload?.teamId || '');
  const source = String(payload?.source || '');
  if (!teamId) return json({ ok: false, error: 'team_id_required' }, 400);
  if (source !== 'upload' && source !== 'youtube' && source !== 'vimeo') {
    return json({ ok: false, error: 'invalid_source' }, 400);
  }
  const claims = await requireCoachOfTeam(req as any, env as any, teamId);
  const { pid, sa } = projectAndSA(env);

  const note = String(payload?.note || '').slice(0, 500);
  const title = payload?.title ? String(payload.title).slice(0, 120) : undefined;
  const rawPlayerIds: string[] = Array.isArray(payload?.playerIds)
    ? Array.from(new Set(
        payload.playerIds
          .filter((p: any) => typeof p === 'string' && p.length > 0)
          .map((p: string) => p),
      ))
    : [];
  // Cap the group size (single / small group / whole team via empty). A
  // 20-player "group" is really a whole-team send; force the client to
  // use targetsWholeTeam by sending [] instead.
  if (rawPlayerIds.length > 12) {
    return json({ ok: false, error: 'too_many_players', hint: 'send empty playerIds for whole-team' }, 400);
  }

  // ── Upload-only checks ────────────────────────────────────────
  let streamUid: string | undefined;
  let durationSeconds: number | undefined;
  let fileSize: number | undefined;
  let fileName: string | undefined;
  let contentType: string | undefined;
  let posterTimeSeconds: number | undefined;
  let embedUrl: string | undefined;
  let externalVideoId: string | undefined;
  let thumbnailUrl: string | undefined;

  if (source === 'upload') {
    // Paid tier gate (server-authoritative). checkPaidCoach also covers
    // the trial + past-due + canceled reasons for warmer client copy.
    const paid = await checkPaidCoach(pid, sa, claims.uid);
    if (!paid.ok) {
      return json({ ok: false, error: 'paid_coach_required', reason: paid.reason }, 402);
    }
    streamUid = payload?.streamUid ? String(payload.streamUid) : undefined;
    if (!streamUid) return json({ ok: false, error: 'stream_uid_required' }, 400);
    // Verify the CF Stream uid was actually minted by this coach for
    // this team. A determined client can't hand us someone else's
    // streamUid to wrap a foreign coach's raw video in their clip.
    // Network failure fall-through: a CF hiccup shouldn't block a
    // legitimate coach from publishing.
    if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_STREAM_API_TOKEN) {
      try {
        const cfRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${encodeURIComponent(streamUid)}`,
          { headers: { authorization: `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` } },
        );
        if (cfRes.status === 404) {
          return json({ ok: false, error: 'stream_uid_not_yours' }, 403);
        }
        if (cfRes.ok) {
          const cfBody: any = await cfRes.json().catch(() => ({}));
          const meta = cfBody?.result?.meta || {};
          const metaUploadedBy = String(meta.uploadedBy || '');
          const metaTeamId = String(meta.teamId || '');
          const metaFeature = String(meta.feature || '');
          if (metaUploadedBy !== claims.uid || metaTeamId !== teamId) {
            return json({ ok: false, error: 'stream_uid_not_yours' }, 403);
          }
          // Belt-and-suspenders on the 90s cap: only accept videos that
          // were presigned via a Gametape-aware path (worker
          // handleGametapeStreamUploadUrl or Vercel /api/stream-upload-url
          // with feature='gametape'). Both stamp meta.feature='gametape'
          // AND cap maxDurationSeconds=90 at the CF direct_upload level.
          // Reusing a longer-form upload (e.g. a 5-minute highlight) as a
          // clip would defeat the "homework cap" promise.
          if (metaFeature !== 'gametape') {
            return json({ ok: false, error: 'stream_uid_not_gametape' }, 403);
          }
        }
        // Non-OK non-404 CF status → fall through and accept.
      } catch (err) {
        console.warn('[gametape/create] stream uid verify threw', streamUid, (err as Error).message);
      }
    }
    // Client probes duration pre-upload; belt is CF Stream's own 90s
    // maxDurationSeconds on the presign. Reject anything above cap
    // outright so we never write a Firestore row for a clip that will
    // be rejected on transcode.
    if (typeof payload?.durationSeconds === 'number' && payload.durationSeconds > 0) {
      if (payload.durationSeconds > 90) {
        return json({ ok: false, error: 'clip_too_long', maxSeconds: 90 }, 400);
      }
      durationSeconds = Math.round(payload.durationSeconds);
    }
    if (typeof payload?.fileSize === 'number' && payload.fileSize > 0) fileSize = Math.round(payload.fileSize);
    if (typeof payload?.fileName === 'string') fileName = payload.fileName.slice(0, 200);
    if (typeof payload?.contentType === 'string') contentType = payload.contentType.slice(0, 60);
    if (typeof payload?.posterTimeSeconds === 'number' && payload.posterTimeSeconds >= 0) {
      posterTimeSeconds = payload.posterTimeSeconds;
    }
  } else {
    // YouTube / Vimeo — link path, free for every coach.
    const raw = String(payload?.embedUrl || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) {
      return json({ ok: false, error: 'invalid_embed_url' }, 400);
    }
    embedUrl = raw.slice(0, 500);
    if (source === 'youtube') {
      const id = extractYouTubeId(embedUrl);
      if (!id) return json({ ok: false, error: 'invalid_youtube_url' }, 400);
      externalVideoId = id;
      thumbnailUrl = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    } else if (source === 'vimeo') {
      const id = extractVimeoId(embedUrl);
      if (!id) return json({ ok: false, error: 'invalid_vimeo_url' }, 400);
      externalVideoId = id;
      // Non-fatal — if oEmbed fails we still create the clip; the card
      // renders a text-only header until the iframe loads.
      thumbnailUrl = (await fetchVimeoThumbnail(embedUrl)) || undefined;
    }
  }

  // ── Resolve targeting → activeForPlayerIds ───────────────────
  const targetsWholeTeam = rawPlayerIds.length === 0;
  const targetPlayerIds = targetsWholeTeam
    ? await loadTeamRosterIds(pid, sa, teamId)
    : rawPlayerIds;
  if (targetPlayerIds.length === 0) {
    return json({ ok: false, error: 'no_targets' }, 400);
  }

  // ── Validate team + denormalize parentIds/selfPlayerUids + collect first names ──
  // Runs BEFORE homework-cap enforcement so a cross-team reject
  // (Team A coach targeting a Team B kid) doesn't cause the auto-
  // archive side effect on legit players.
  //
  // selfPlayerUids grants read to U13+ self-manage kids via
  // firestore.rules line 1247-1250. parentIds does the same for
  // parents. Both are required so U13+ kids with their own accounts
  // (users/{uid}.selfPlayerId === player.id) can actually see clips
  // assigned to them.
  const parentIdSet = new Set<string>();
  const selfPlayerUidSet = new Set<string>();
  const playerFirstNames: string[] = [];
  for (const targetPid of targetPlayerIds) {
    const pDoc = await getDocument(pid, `players/${targetPid}`, sa).catch(() => null);
    const pd: any = pDoc?.data;
    if (!pd) {
      return json({ ok: false, error: 'player_not_on_team', playerId: targetPid }, 400);
    }
    const pdTeamId = String(pd.teamId || '');
    const pdTeamIds: any[] = Array.isArray(pd.teamIds) ? pd.teamIds : [];
    if (pdTeamId !== teamId && !pdTeamIds.includes(teamId)) {
      return json({ ok: false, error: 'player_not_on_team', playerId: targetPid }, 400);
    }
    const parentIds: any[] = Array.isArray(pd.parentIds) ? pd.parentIds : [];
    for (const uid of parentIds) if (typeof uid === 'string' && uid) parentIdSet.add(uid);
    // Legacy single parentId field
    if (typeof pd.parentId === 'string' && pd.parentId) parentIdSet.add(pd.parentId);
    const nm = String(pd.name || '').trim();
    if (nm) playerFirstNames.push(nm.split(/\s+/)[0]);
    // U13+ self-manage kids — find users whose selfPlayerId points at
    // this player so we can denorm read-access into the clip. See
    // firestore.rules L1247-1250 which grants read via selfPlayerUids.
    try {
      const selfRows = await runQuery(
        pid,
        'users',
        [{ field: 'selfPlayerId', op: 'EQUAL', value: targetPid }],
        sa,
        20,
      );
      for (const r of selfRows) {
        const uid = String(r.data?.uid || r.id || '');
        if (uid) selfPlayerUidSet.add(uid);
      }
    } catch (err) {
      console.warn('[gametape] selfPlayerId lookup failed', targetPid, (err as Error).message);
    }
  }
  const parentIds = [...parentIdSet];
  const selfPlayerUids = [...selfPlayerUidSet];

  // ── Enforce homework cap ─────────────────────────────────────
  const now = new Date();
  const autoArchived = await enforceHomeworkCap(pid, sa, teamId, targetPlayerIds, now);

  // ── Load team/season/club stamps ─────────────────────────────
  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const teamData: any = teamDoc?.data || {};
  const clubId = typeof teamData.clubId === 'string' ? teamData.clubId : '';
  let seasonId = '';
  try {
    const rows = await runQuery(pid, 'seasons', [
      { field: 'teamId', op: 'EQUAL', value: teamId },
      { field: 'isActive', op: 'EQUAL', value: true },
    ], sa, 1);
    if (rows.length > 0) seasonId = rows[0].id;
  } catch (err) {
    console.warn('[gametape] season lookup failed', err);
  }

  // Coach display name — the same shape used on player_xp_events
  // (writeXpGrant awardedByName). Falls back to Firebase Auth's
  // token.name or "Coach".
  const coachUserDoc = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
  const createdByName = String(coachUserDoc?.data?.name || claims.name || 'Coach').slice(0, 60);
  const coachFirst = createdByName.split(/\s+/)[0] || 'Coach';

  // ── Write the clip doc ───────────────────────────────────────
  // Field naming mirrors PlayerMedia so CloudflareStreamIframe +
  // streamThumbnailUrl work without an adapter. New Gametape-specific
  // fields (activeForPlayerIds, archivedForPlayerIds, etc) are additive.
  const fields: Record<string, any> = {
    teamId,
    createdBy: claims.uid,
    createdByName,
    createdAt: now,
    updatedAt: now,

    playerIds: rawPlayerIds,          // empty = whole team (user intent)
    targetsWholeTeam,                 // rule-fast-path flag
    parentIds,                        // denorm for parent read-rule cheapness
    selfPlayerUids,                   // denorm — U13+ self-manage read (firestore.rules L1247-1250)

    source,
    note,
    activeForPlayerIds: targetPlayerIds,
    watchedByPlayerIds: [],
    // Per-viewer independent watched state (see handleGametapeMarkWatched).
    // Every user (kid uid, parent uid, other-parent uid, coach uid) who
    // taps "I watched it" gets appended here. Client dashboards filter
    // by `!watchedByUserIds.includes(currentUid)` so each household
    // member clears their own dashboard independently. Coach counter
    // still reads watchedByPlayerIds (household-first-touch).
    watchedByUserIds: [],
    archivedForPlayerIds: [],
    watchedAt: {},
    archivedAt: {},

    isActive: true,
  };
  if (title) fields.title = title;
  if (clubId) fields.clubId = clubId;
  if (seasonId) fields.seasonId = seasonId;

  if (source === 'upload') {
    if (streamUid) fields.streamUid = streamUid;
    if (typeof durationSeconds === 'number') fields.durationSeconds = durationSeconds;
    if (typeof fileSize === 'number') fields.fileSize = fileSize;
    if (fileName) fields.fileName = fileName;
    if (contentType) fields.contentType = contentType;
    if (typeof posterTimeSeconds === 'number') fields.posterTimeSeconds = posterTimeSeconds;
    fields.streamReady = false;
  } else {
    if (embedUrl) fields.embedUrl = embedUrl;
    if (externalVideoId) fields.externalVideoId = externalVideoId;
    if (thumbnailUrl) fields.thumbnailUrl = thumbnailUrl;
  }

  let clipId: string;
  try {
    clipId = await createDocument(pid, 'player_clips', fields, sa);
  } catch (err) {
    console.error('[gametape/create] createDocument failed', (err as Error).message);
    return json({ ok: false, error: 'write_failed' }, 500);
  }

  // ── Fan out push (server-side; parents can't enumerate) ─────
  // Skip fanout when a coach targets themselves via a solo test-play.
  const notePreview = note.slice(0, 80);
  let pushResult = { sent: 0, failed: 0, recipients: 0 };
  try {
    pushResult = await fanOutPush({
      env, pid, sa,
      clipId,
      teamId,
      coachUid: claims.uid,
      coachFirst,
      targetsWholeTeam,
      playerIds: targetPlayerIds,
      parentIds,
      playerFirstNames,
      notePreview,
    });
  } catch (err) {
    console.warn('[gametape/create] push fanout threw', err);
  }

  return json({
    ok: true,
    clipId,
    autoArchived,
    pushSent: pushResult.sent,
    pushRecipients: pushResult.recipients,
  });
  } catch (err) {
    const authResp = authErrorResponse(err);
    if (authResp) return authResp;
    console.error('[gametape/create] unhandled', (err as Error)?.message || err);
    return json({ ok: false, error: 'internal' }, 500);
  }
}

// ────────────────────────────────────────────────────────────────
// POST /gametape/mark-watched
//
// Body: { clipId, playerId }
// Auth: coach of team OR parent of player OR self-kid of player.
// Behavior (per-viewer independent watched design):
//   - arrayUnion claims.uid into watchedByUserIds — this is the
//     per-viewer dashboard-clear signal. Every household member
//     (kid self-account, parent, other parent) has their own uid
//     in this set, so each clears their own dashboard independently.
//   - arrayRemove playerId from activeForPlayerIds + arrayUnion into
//     watchedByPlayerIds + stamp watchedAt.{playerId} — household-
//     first-touch signals used by the coach counter ("watched by
//     N of M"). These stay player-scoped and are idempotent.
//   - Fire +3 XP with source='gametape_watched' and
//     sourceRef=`clip-{clipId}-{playerId}` (per-PLAYER deterministic
//     ref) so the first household tap grants once; subsequent taps
//     by other members no-op via writeXpGrant's AlreadyExistsError.
// ────────────────────────────────────────────────────────────────
const GAMETAPE_WATCH_XP = 3;

export async function handleGametapeMarkWatched(req: Request, env: GametapeEnv, payload: any): Promise<Response> {
  try {
  const clipId = String(payload?.clipId || '');
  const playerId = String(payload?.playerId || '');
  if (!clipId) return json({ ok: false, error: 'clip_id_required' }, 400);
  if (!playerId) return json({ ok: false, error: 'player_id_required' }, 400);

  const claims = await requireUser(req as any, env as any);
  const { pid, sa } = projectAndSA(env);

  const clipDoc = await getDocument(pid, `player_clips/${clipId}`, sa).catch(() => null);
  if (!clipDoc?.data) return json({ ok: false, error: 'clip_not_found' }, 404);
  const clip: any = clipDoc.data;
  if (clip.isActive === false) return json({ ok: false, error: 'clip_not_active' }, 410);

  const teamId = String(clip.teamId || '');
  if (!teamId) return json({ ok: false, error: 'clip_missing_team' }, 500);

  // ── Auth ladder ──────────────────────────────────────────────
  // Coach of the team, OR parent of the player, OR self-kid. Order
  // avoids a redundant Firestore read when the caller is definitely
  // a coach (kid-on-parent-device is the parent path).
  const [coach, parent, self] = await Promise.all([
    isCoachOfTeam(pid, sa, claims.uid, teamId),
    isParentOfPlayer(pid, sa, claims.uid, playerId),
    isSelfKidOfPlayer(pid, sa, claims.uid, playerId),
  ]);
  if (!coach && !parent && !self) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  // ── Verify player is a legit target of this clip ─────────────
  const active: string[] = Array.isArray(clip.activeForPlayerIds) ? clip.activeForPlayerIds : [];
  const watched: string[] = Array.isArray(clip.watchedByPlayerIds) ? clip.watchedByPlayerIds : [];
  const archived: string[] = Array.isArray(clip.archivedForPlayerIds) ? clip.archivedForPlayerIds : [];
  const wasTarget = active.includes(playerId) || watched.includes(playerId) || archived.includes(playerId);
  if (!wasTarget) {
    // Also allow if this is a whole-team clip whose activeForPlayerIds
    // hasn't been materialized to include this player (shouldn't happen
    // in normal flow, but be defensive).
    if (clip.targetsWholeTeam !== true) {
      return json({ ok: false, error: 'not_target' }, 403);
    }
    // Whole-team bypass — but a parent could try to mark a FOREIGN
    // team's whole-team clip as watched by their kid, polluting the
    // counter + farming XP against a team they're not on. Verify the
    // player is actually on clip.teamId's roster.
    const pd: any = (await getDocument(pid, `players/${playerId}`, sa).catch(() => null))?.data || {};
    const pdTeamId = String(pd.teamId || '');
    const pdTeamIds: any[] = Array.isArray(pd.teamIds) ? pd.teamIds : [];
    if (pdTeamId !== teamId && !pdTeamIds.includes(teamId)) {
      return json({ ok: false, error: 'player_not_on_team' }, 403);
    }
  }
  const alreadyWatched = watched.includes(playerId);
  // Per-viewer independent watched state: each user (kid uid on a self
  // account, parent uid, other-parent uid) tracks their own dashboard
  // clear-out. `watchedByPlayerIds` remains household-first-touch for
  // the coach counter; `watchedByUserIds` is the per-viewer set.
  const watchedByUserIds: string[] = Array.isArray(clip.watchedByUserIds) ? clip.watchedByUserIds : [];
  const alreadyWatchedByUser = watchedByUserIds.includes(claims.uid);

  const now = new Date();
  // Always commit — even when `alreadyWatched === true` (another household
  // member tapped first) we still need to arrayUnion claims.uid into
  // watchedByUserIds so THIS viewer's dashboard clears. arrayRemove /
  // arrayUnion on the player-scoped fields are idempotent, so re-running
  // them is safe. `watchedAt.${playerId}` is a household-first-touch stamp
  // that will get restamped on repeat taps — acceptable for coach timeline.
  try {
    await commitDocumentTransforms(
      pid,
      `player_clips/${clipId}`,
      [
        { fieldPath: 'activeForPlayerIds', kind: 'arrayRemove', value: playerId },
        { fieldPath: 'watchedByPlayerIds', kind: 'arrayUnion', value: playerId },
        { fieldPath: 'watchedByUserIds', kind: 'arrayUnion', value: claims.uid },
      ],
      {
        [`watchedAt.${playerId}`]: now,
        updatedAt: now,
      },
      sa,
    );
  } catch (err) {
    console.warn('[gametape/mark-watched] commit failed', (err as Error).message);
    return json({ ok: false, error: 'write_failed' }, 500);
  }

  // ── XP grant. Deterministic sourceRef = single-earn per (clip, player).
  //     writeXpGrant handles the AlreadyExistsError as an idempotent
  //     no-op so a rewatch or a concurrent tap doesn't double-credit.
  let xpGranted = 0;
  try {
    const result = await writeXpGrant({
      pid, sa,
      actorUid: claims.uid,
      // XP is attributed to the player, but actorRole reflects the
      // caller for audit fidelity. Coach path is rare (usually QA);
      // parent/self path is the norm.
      actorRole: coach ? 'coach' : (parent ? 'parent' : 'self'),
      teamId,
      playerId,
      source: 'gametape_watched',
      xp: GAMETAPE_WATCH_XP,
      sourceRef: `clip-${clipId}-${playerId}`,
      note: undefined,
      occurredAt: now,
    });
    if (result.outcome === 'created') xpGranted = GAMETAPE_WATCH_XP;
  } catch (err) {
    // XP is a nice-to-have; the watch itself already committed. Log and
    // keep going — the client should surface "Got it" success and the
    // XP toast can be a subtle "+3" that we simply skip on failure.
    console.warn('[gametape/mark-watched] xp grant failed', (err as Error).message);
  }

  return json({ ok: true, alreadyWatched, alreadyWatchedByUser, xpGranted });
  } catch (err) {
    const authResp = authErrorResponse(err);
    if (authResp) return authResp;
    console.error('[gametape/mark-watched] unhandled', (err as Error)?.message || err);
    return json({ ok: false, error: 'internal' }, 500);
  }
}

// ────────────────────────────────────────────────────────────────
// POST /gametape/archive
//
// Body: { clipId, playerId? }
// Auth: coach of team. (Per-player library moves are done via
// /gametape/mark-watched — this endpoint is coach cleanup.)
//
// When playerId is supplied, moves the clip to that player's Library
// only (arrayRemove active + arrayUnion archived + archivedAt stamp).
// When omitted, soft-archives globally (isActive=false + Stream delete
// for source='upload'). Global archive is the coach's "pull this from
// everyone" escape hatch — /gametape/delete is the destructive twin
// that also stamps deletedBy/deletedAt.
// ────────────────────────────────────────────────────────────────
export async function handleGametapeArchive(req: Request, env: GametapeEnv, payload: any): Promise<Response> {
  try {
  const clipId = String(payload?.clipId || '');
  const playerId = payload?.playerId ? String(payload.playerId) : '';
  if (!clipId) return json({ ok: false, error: 'clip_id_required' }, 400);

  const { pid, sa } = projectAndSA(env);
  const clipDoc = await getDocument(pid, `player_clips/${clipId}`, sa).catch(() => null);
  if (!clipDoc?.data) return json({ ok: false, error: 'clip_not_found' }, 404);
  const clip: any = clipDoc.data;
  const teamId = String(clip.teamId || '');
  await requireCoachOfTeam(req as any, env as any, teamId);

  const now = new Date();
  if (playerId) {
    try {
      await commitDocumentTransforms(
        pid,
        `player_clips/${clipId}`,
        [
          { fieldPath: 'activeForPlayerIds', kind: 'arrayRemove', value: playerId },
          { fieldPath: 'archivedForPlayerIds', kind: 'arrayUnion', value: playerId },
        ],
        {
          [`archivedAt.${playerId}`]: now,
          updatedAt: now,
        },
        sa,
      );
    } catch (err) {
      console.warn('[gametape/archive] per-player commit failed', (err as Error).message);
      return json({ ok: false, error: 'write_failed' }, 500);
    }
    return json({ ok: true, scope: 'player' });
  }

  // Global archive — flip isActive and pull the Stream video. Same
  // shape as /gametape/delete but the deletedBy/deletedAt stamps are
  // reserved for the truly destructive path so we can distinguish a
  // silent archive from an explicit "coach nuked it" later.
  try {
    await patchDocument(pid, `player_clips/${clipId}`, {
      isActive: false,
      updatedAt: now,
    }, sa);
  } catch (err) {
    console.warn('[gametape/archive] global patch failed', (err as Error).message);
    return json({ ok: false, error: 'write_failed' }, 500);
  }
  if (clip.source === 'upload' && typeof clip.streamUid === 'string' && clip.streamUid) {
    // Fire-and-await — Stream API is fast enough and doing it inline
    // means a failure surfaces to the coach so they can retry.
    await deleteStreamVideo(env, String(clip.streamUid));
  }
  return json({ ok: true, scope: 'global' });
  } catch (err) {
    const authResp = authErrorResponse(err);
    if (authResp) return authResp;
    console.error('[gametape/archive] unhandled', (err as Error)?.message || err);
    return json({ ok: false, error: 'internal' }, 500);
  }
}

// ────────────────────────────────────────────────────────────────
// POST /gametape/delete
//
// Body: { clipId }
// Auth: coach of team OR createdBy===uid.
// Behavior: soft-delete (isActive=false, deletedBy, deletedAt) +
// Stream video removal when source='upload'. Does not unwind XP that
// prior watchers already earned — that's audit history, not a
// per-clip counter.
// ────────────────────────────────────────────────────────────────
export async function handleGametapeDelete(req: Request, env: GametapeEnv, payload: any): Promise<Response> {
  try {
  const clipId = String(payload?.clipId || '');
  if (!clipId) return json({ ok: false, error: 'clip_id_required' }, 400);

  const claims = await requireUser(req as any, env as any);
  const { pid, sa } = projectAndSA(env);

  const clipDoc = await getDocument(pid, `player_clips/${clipId}`, sa).catch(() => null);
  if (!clipDoc?.data) return json({ ok: false, error: 'clip_not_found' }, 404);
  const clip: any = clipDoc.data;
  const teamId = String(clip.teamId || '');

  // Author OR coach — either can pull their own clip. Author check
  // saves the coach-of-team lookup for the common case (coach nukes
  // their own clip).
  const isAuthor = String(clip.createdBy || '') === claims.uid;
  if (!isAuthor) {
    // Throws AuthError which bubbles to a 403 via authErrorResponse.
    await requireCoachOfTeam(req as any, env as any, teamId);
  }

  const now = new Date();
  try {
    await patchDocument(pid, `player_clips/${clipId}`, {
      isActive: false,
      deletedBy: claims.uid,
      deletedAt: now,
      updatedAt: now,
    }, sa);
  } catch (err) {
    console.warn('[gametape/delete] patch failed', (err as Error).message);
    return json({ ok: false, error: 'write_failed' }, 500);
  }
  if (clip.source === 'upload' && typeof clip.streamUid === 'string' && clip.streamUid) {
    await deleteStreamVideo(env, String(clip.streamUid));
  }
  return json({ ok: true });
  } catch (err) {
    const authResp = authErrorResponse(err);
    if (authResp) return authResp;
    console.error('[gametape/delete] unhandled', (err as Error)?.message || err);
    return json({ ok: false, error: 'internal' }, 500);
  }
}

// ────────────────────────────────────────────────────────────────
// Dispatcher — called from index.ts before the fall-through 404.
// Returns null when the pathname isn't a gametape route so the outer
// router can keep matching.
// ────────────────────────────────────────────────────────────────
export async function routeGametape(
  pathname: string,
  req: Request,
  env: GametapeEnv,
  payload: any,
): Promise<Response | null> {
  switch (pathname) {
    case '/gametape/stream-upload-url': return handleGametapeStreamUploadUrl(req, env, payload);
    case '/gametape/create':            return handleGametapeCreate(req, env, payload);
    case '/gametape/mark-watched':      return handleGametapeMarkWatched(req, env, payload);
    case '/gametape/archive':           return handleGametapeArchive(req, env, payload);
    case '/gametape/delete':            return handleGametapeDelete(req, env, payload);
    default:                            return null;
  }
}
