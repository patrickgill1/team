/**
 * Team Wall comment notifications.
 *
 * Companion to wallPosts.ts. When a parent (or anyone) drops a
 * comment on a wall post, we push to:
 *   - the post author (if not the commenter themselves)
 *   - every prior distinct commenter on the same post (thread continuity,
 *     iMessage / Instagram / Twitter pattern)
 * We do NOT push the whole team — too noisy.
 *
 * Endpoint:
 *   POST /wall/notify-comment
 *   Body: { commentId: string }
 *
 * Auth:
 *   Any signed-in caller, but caller.uid must equal comment.senderId.
 *   Blocks a random signed-in user from spamming pushes by POSTing
 *   arbitrary commentIds.
 *
 * Guardrails:
 *   - Recipient list dedupes by uid.
 *   - Commenter's own uid always excluded.
 *   - Post author push honors pushPreferences.broadcast (same key
 *     wall post pushes use — one wall opt-out covers both).
 *   - Prior commenter pushes also honor pushPreferences.broadcast.
 *   - No rate limit in v1. If a thread runs hot (10 comments in a
 *     minute), 10 pings fire. Add a per-user/post 60s dedupe if
 *     that becomes a complaint.
 */

import { requireUser, AuthError } from './auth';
import { parseServiceAccount, ServiceAccount, sendPush } from './fcm';
import { getDocument, runQuery } from './firestore';

interface Env {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
  APP_ORIGIN?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

function projectAndSA(env: Env): { pid: string; sa: ServiceAccount } {
  const pid = env.FIREBASE_PROJECT_ID;
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!pid || !raw) throw new AuthError('server_not_configured', 500);
  return { pid, sa: parseServiceAccount(raw) };
}

function buildPostUrl(env: Env, postId: string): string {
  const origin = env.APP_ORIGIN || 'https://app.goalkickr.com';
  // 2026-08-31: was /wall/p/<id> (the PUBLIC share route). Push
  // recipients are always signed-in team members (collectTokens
  // reads user docs), but /wall/p requires isPublic=true so
  // non-public posts rendered "This post is private" to the
  // notified parent even though they have team access. Route to
  // the authed /wall?post=<id> — Wall scrolls to + highlights the
  // matching post on mount.
  return `${origin}/wall?post=${encodeURIComponent(postId)}`;
}

function truncate(s: string, n: number): string {
  const clean = String(s || '').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

async function collectTokens(
  pid: string,
  sa: ServiceAccount,
  uids: string[],
  excludeUid: string,
): Promise<string[]> {
  const targets = uids.filter((u) => u && u !== excludeUid);
  if (targets.length === 0) return [];
  const tokens: string[] = [];
  for (const uid of targets) {
    try {
      const uDoc = await getDocument(pid, `users/${uid}`, sa);
      const u: any = uDoc?.data || {};
      if (u.isActive === false) continue;
      // Honor the same broadcast opt-out wall posts use. If a user
      // muted wall posts, comments are muted too. No new pref key.
      const prefs = u.pushPreferences || {};
      if (prefs.broadcast === false) continue;
      const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
      for (const t of arr) if (typeof t === 'string' && t.length > 10) tokens.push(t);
    } catch { /* per-user lookup failure — skip */ }
  }
  return Array.from(new Set(tokens));
}

export async function handleWallCommentNotify(
  req: Request,
  env: Env,
  payload: any,
): Promise<Response> {
  const caller = await requireUser(req, env as any).catch(() => null);
  if (!caller) return json({ ok: false, error: 'unauthenticated' }, 401);

  const commentId = String(payload?.commentId || '').trim();
  if (!commentId) return json({ ok: false, error: 'bad_request' }, 400);

  let pid: string, sa: ServiceAccount;
  try { ({ pid, sa } = projectAndSA(env)); }
  catch (err: any) { return json({ ok: false, error: err.code || 'server_not_configured' }, err.status || 500); }

  // Load the comment. Verify caller is the commenter.
  const commentDoc = await getDocument(pid, `wall_comments/${commentId}`, sa).catch(() => null);
  const comment: any = commentDoc?.data;
  if (!comment) return json({ ok: false, error: 'comment_not_found' }, 404);
  if (comment.senderId !== caller.uid) {
    return json({ ok: false, error: 'not_your_comment' }, 403);
  }

  const postId = String(comment.postId || '').trim();
  if (!postId) return json({ ok: false, error: 'comment_missing_postId' }, 400);

  // Load the post to get its author + team context.
  const postDoc = await getDocument(pid, `wall_posts/${postId}`, sa).catch(() => null);
  const post: any = postDoc?.data;
  if (!post) return json({ ok: false, error: 'post_not_found' }, 404);

  const postAuthor = String(post.senderId || '').trim();
  const teamId = String(post.teamId || comment.teamId || '').trim();

  // Enumerate prior distinct commenters on this post. Include the
  // post author for the recipient list; dedupe on our side.
  let priorCommenters: string[] = [];
  try {
    const priorDocs = await runQuery(pid, 'wall_comments', [
      { field: 'postId', op: 'EQUAL', value: postId },
    ], sa, 500);
    const set = new Set<string>();
    for (const d of priorDocs) {
      const sid = String(d.data?.senderId || '').trim();
      if (sid && sid !== caller.uid) set.add(sid);
    }
    priorCommenters = Array.from(set);
  } catch (err) {
    console.warn('[wall-comments] prior-commenters query failed', err);
  }

  const recipients = new Set<string>();
  if (postAuthor && postAuthor !== caller.uid) recipients.add(postAuthor);
  for (const uid of priorCommenters) recipients.add(uid);
  recipients.delete(caller.uid);

  if (recipients.size === 0) {
    return json({ ok: true, sent: 0, note: 'no_recipients' });
  }

  const commenterName = String(comment.senderName || 'Friend').trim();
  const teamName = String(post.teamName || '').trim();
  // Title mirrors the wall-post push shape: team name if we have
  // it, commenter name otherwise. Body carries a truncated comment
  // preview so the parent can decide whether to open.
  const pushTitle = teamName || `${commenterName} commented`;
  const bodyPreview = truncate(comment.content || '', 100);
  const pushBody = bodyPreview
    ? `${commenterName}: ${bodyPreview}`
    : `${commenterName} left a comment.`;
  const url = buildPostUrl(env, postId);

  const tokens = await collectTokens(pid, sa, Array.from(recipients), caller.uid);
  if (tokens.length === 0) {
    return json({ ok: true, sent: 0, note: 'no_tokens', recipients: recipients.size });
  }

  try {
    const result = await sendPush(tokens, {
      title: pushTitle,
      body: pushBody,
      url,
    }, env.FCM_SERVICE_ACCOUNT!);
    return json({
      ok: true,
      sent: result.sent,
      failed: result.failed,
      recipients: recipients.size,
      tokens: tokens.length,
      teamId,
    });
  } catch (err: any) {
    console.warn('[wall-comments] push failed', err);
    return json({ ok: false, error: 'push_failed', detail: String(err?.message || err).slice(0, 200) }, 502);
  }
}
