/**
 * Team Wall notifications for parent-authored posts.
 *
 * Coaches write directly to Firestore and fan out push/email from their
 * own session (Wall.tsx → sendPushToTeam + sendEmailToTeam). Parents
 * cannot: Firestore rules don't let a parent enumerate other users on
 * the team, so the notify shape has to move server-side. This module
 * owns that surface.
 *
 * Endpoint:
 *   POST /wall/notify-parent-post
 *   Body: { postId: string, event?: 'created' | 'approved' }
 *
 * Behavior:
 *   event='created' (parent's session, right after they addDoc the post)
 *     - Push every coach on the team (except the author if they happen
 *       to be one — parents shouldn't be, but the guard is cheap).
 *     - "Tap to review." appended when status='pending' so the coach
 *       lands in the approval queue instead of the read feed.
 *     - Honors team.wallConfig.notifyCoach (default true).
 *
 *   event='approved' (coach's session, right after flipping status
 *     pending→live)
 *     - No coach push — the coach who approved obviously already saw
 *       it, and the OTHER coaches were pinged at create time.
 *     - Email fanout to team parents when
 *       team.wallConfig.allowParentEmail === true. (approval flow)
 *
 *   event='created' + status='live' (approval NOT required by team
 *     config): both the coach push AND the email fanout fire in the
 *     same call.
 *
 * Auth:
 *   requireUser — the endpoint accepts any signed-in caller because
 *   parents don't have any team-scoped role we can gate on. We then
 *   verify:
 *     event='created' → caller.uid must equal the post's senderId
 *       (author calling on their own post — the composer's write path)
 *     event='approved' → caller.uid must be on team.coachIds
 *       (the coach flipping the flag has authority over the fanout)
 *
 *   This blocks a random signed-in user from spamming email fanouts by
 *   POSTing arbitrary postIds.
 *
 * Guardrails baked in:
 *   - Coach-authored posts short-circuit — this endpoint only fires
 *     for parent-authored posts (authorRole='parent', or legacy
 *     senderRole !== 'coach'/'admin'). Coach fanout stays on the
 *     client path.
 *   - allowParentEmail default: false. Coaches opt in per team via
 *     team.wallConfig (owned by another slice; we just read it).
 *   - requireCoachApproval: when true AND status='pending', the email
 *     fanout is skipped even if allowParentEmail is on — waits for
 *     the approval trigger.
 *   - The parent themselves is always excluded from both push and
 *     email recipients (they wrote it, they already know).
 */

import { requireUser, AuthError } from './auth';
import { parseServiceAccount, ServiceAccount, sendPush } from './fcm';
import { getDocument, runQuery, listDocuments } from './firestore';

interface Env {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
  APP_ORIGIN?: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  FROM_NAME?: string;
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

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

// Wall post role helper. The composer stamps `authorRole` on new
// parent-authored posts, but a lot of the existing corpus uses the
// legacy `senderRole` field — treat either as the source of truth and
// bucket into 'coach' | 'parent-ish'. Any non-coach non-admin role is
// treated as a parent-authored post for fanout purposes (adults on
// self-managed accounts, U13+ kids, etc — all get the same broadcast
// posture as "not a coach").
function resolveAuthorRole(data: Record<string, any>): string {
  const raw = String(data?.authorRole || data?.senderRole || '').toLowerCase().trim();
  return raw || 'parent';
}

function isCoachRole(role: string): boolean {
  return role === 'coach' || role === 'team_manager' || role === 'admin' || role === 'club_admin';
}

// Build the wall post URL a coach or parent taps to open the post. The
// public-share route /wall/p/{id} works even when the recipient isn't
// signed in on that device, which is the same shape wallPostShareUrl()
// uses on the client. Falling back to /wall is not helpful — coaches
// approving a pending post want to see THAT post, not the whole feed.
function buildPostUrl(env: Env, postId: string): string {
  const origin = env.APP_ORIGIN || 'https://app.goalkickr.com';
  return `${origin}/wall/p/${postId}`;
}

// ────────────────────────────────────────────────────────────────
// Coach push fanout
// ────────────────────────────────────────────────────────────────
async function pushCoachesOfTeam(
  pid: string,
  sa: ServiceAccount,
  env: Env,
  args: {
    teamId: string;
    coachIds: string[];
    excludeUid: string;
    title: string;
    body: string;
    url: string;
  },
): Promise<{ sent: number; failed: number; recipients: number }> {
  if (!env.FCM_SERVICE_ACCOUNT) return { sent: 0, failed: 0, recipients: 0 };
  const targets = args.coachIds.filter((u) => u && u !== args.excludeUid);
  if (targets.length === 0) return { sent: 0, failed: 0, recipients: 0 };

  const tokens: string[] = [];
  for (const uid of targets) {
    const uDoc = await getDocument(pid, `users/${uid}`, sa).catch(() => null);
    const u: any = uDoc?.data || {};
    if (u.isActive === false) continue;
    // Honor pushPreferences.broadcast when explicitly disabled. Missing
    // pref = default on (matches sendPushToTeam client-side behavior).
    const prefs = u.pushPreferences || {};
    if (prefs.broadcast === false) continue;
    const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
    for (const t of arr) if (typeof t === 'string' && t.length > 10) tokens.push(t);
  }
  const unique = Array.from(new Set(tokens));
  if (unique.length === 0) return { sent: 0, failed: 0, recipients: targets.length };
  try {
    const result = await sendPush(unique, {
      title: args.title,
      body: args.body,
      url: args.url,
      badge: 1,
    }, env.FCM_SERVICE_ACCOUNT);
    return { sent: result.sent, failed: result.failed, recipients: targets.length };
  } catch (err) {
    console.warn('[wall] coach push failed', err);
    return { sent: 0, failed: unique.length, recipients: targets.length };
  }
}

// ────────────────────────────────────────────────────────────────
// Team-parent email fanout
// ────────────────────────────────────────────────────────────────

// Enumerate team roster emails the same way client-side
// getTeamEmails() does (src/utils/notify.ts:747) — union of `teamId`
// and `teamIds array-contains` on users, honoring isActive !== false.
// Runs server-side because parents don't have Firestore permission
// to enumerate other users on their team.
async function collectTeamEmails(
  pid: string,
  sa: ServiceAccount,
  teamId: string,
  excludeUid: string,
): Promise<string[]> {
  const emails = new Set<string>();
  const takeUser = (u: any, id: string): void => {
    if (!id || id === excludeUid) return;
    if (u.isActive === false) return;
    const email = typeof u.email === 'string' ? u.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) return;
    // Honor a wall-specific opt-out if the user set one, otherwise
    // default in. Keep the pref key stable so a future preferences UI
    // can bind to it without a data migration.
    const prefs = u.emailPreferences || {};
    if (prefs.wallPosts === false) return;
    emails.add(email);
  };

  try {
    const s1 = await runQuery(pid, 'users', [
      { field: 'teamId', op: 'EQUAL', value: teamId },
    ], sa, 500);
    for (const d of s1) takeUser(d.data, String(d.data?.uid || d.id));
  } catch (err) {
    console.warn('[wall] users teamId query failed', err);
  }
  try {
    const s2 = await runQuery(pid, 'users', [
      { field: 'teamIds', op: 'ARRAY_CONTAINS', value: teamId },
    ], sa, 500);
    for (const d of s2) takeUser(d.data, String(d.data?.uid || d.id));
  } catch (err) {
    console.warn('[wall] users teamIds query failed', err);
  }
  return [...emails];
}

// Compose the parent-post email. Mirrors the tone of the client-side
// tplWallPost helper in src/utils/notify.ts (used for coach broadcasts)
// but simpler — parents don't have a coach-signature block and the
// category chip is a static "Parent post" pill.
function renderParentPostEmail(args: {
  teamName: string;
  parentName: string;
  contentHtml: string;
  postUrl: string;
  hasPoll: boolean;
  pollQuestion: string | null;
}): { subject: string; html: string } {
  const teamName = escapeHtml(args.teamName);
  const parentName = escapeHtml(args.parentName);
  const subjectPrefix = args.hasPoll ? 'A poll from the Circle' : 'A note from the Circle';
  const subject = `${subjectPrefix} from ${args.parentName} for ${args.teamName}`;
  const safeQuestion = args.pollQuestion ? escapeHtml(args.pollQuestion) : '';
  // Content HTML comes from TipTap and is already sanitized on the
  // client (WallEditor). We don't re-sanitize here — trust the same
  // shape the coach broadcast path uses.
  const contentHtml = args.contentHtml || '';
  const ctaLabel = args.hasPoll ? 'Vote in the poll' : 'Open the post';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0f172a">
      <div style="display:inline-block;background:#06b6d41A;color:#0e7490;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px;border-radius:6px;margin-bottom:12px;">Circle post</div>
      <h2 style="font-size:20px;margin:0 0 6px;color:#0f172a;font-weight:800;line-height:1.25;">${teamName}</h2>
      <p style="margin:0 0 14px;color:#64748b;font-size:13px;">From ${parentName}</p>
      <div style="margin:0 0 18px;color:#0f172a;font-size:15px;line-height:1.65;">
        ${contentHtml}
      </div>
      ${args.hasPoll ? `
        <div style="margin:0 0 18px;padding:16px 18px;background:#f0f9ff;border-left:3px solid #06b6d4;border-radius:8px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#0e7490;">Poll</p>
          <p style="margin:0;color:#0c4a6e;font-size:15px;font-weight:600;line-height:1.4;">${safeQuestion}</p>
        </div>
      ` : ''}
      <p style="margin:18px 0;">
        <a href="${args.postUrl}" style="display:inline-block;padding:12px 20px;background:#06b6d4;color:#ffffff;font-weight:700;text-decoration:none;border-radius:8px;">${ctaLabel}</a>
      </p>
      <p style="margin:14px 0 0;font-size:12px;color:#94a3b8;">You got this because ${parentName} shared a note on the ${teamName} Team Wall. Manage your email preferences in the app.</p>
    </div>
  `;
  return { subject, html };
}

// Batch send via Resend /emails/batch (100 per call). Mirrors the
// campaigns.ts sendViaResend loop shape. Returns the sent count.
async function sendEmailBatch(
  env: Env,
  messages: Array<{ to: string; subject: string; html: string }>,
): Promise<{ sent: number; failed: number }> {
  if (!env.RESEND_API_KEY || messages.length === 0) {
    return { sent: 0, failed: messages.length };
  }
  const from = `${env.FROM_NAME || 'GoalKickr'} <${env.FROM_EMAIL || 'noreply@goalkickr.com'}>`;
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100).map((m) => ({
      from,
      to: m.to,
      subject: m.subject,
      html: m.html,
    }));
    try {
      const r = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(chunk),
      });
      if (r.ok) sent += chunk.length;
      else {
        failed += chunk.length;
        const txt = await r.text().catch(() => '');
        console.warn('[wall] resend batch failed', r.status, txt.slice(0, 300));
      }
    } catch (err) {
      failed += chunk.length;
      console.warn('[wall] resend batch threw', err);
    }
  }
  return { sent, failed };
}

// ────────────────────────────────────────────────────────────────
// Route handler
// ────────────────────────────────────────────────────────────────

// Silence unused-import warnings from tsc — listDocuments is here for
// parity with the paymentRequests module so a future refactor can drop
// in a `list users on team` helper without another import churn.
void listDocuments;

export async function handleWallParentPostNotify(
  req: Request,
  env: Env,
  payload: any,
): Promise<Response> {
  const postId = String(payload?.postId || '').trim();
  if (!postId) return json({ ok: false, error: 'post_id_required' }, 400);
  const eventRaw = String(payload?.event || 'created').toLowerCase();
  const event: 'created' | 'approved' = eventRaw === 'approved' ? 'approved' : 'created';

  const claims = await requireUser(req, env);
  const { pid, sa } = projectAndSA(env);

  const postDoc = await getDocument(pid, `wall_posts/${postId}`, sa).catch(() => null);
  if (!postDoc?.data) return json({ ok: false, error: 'post_not_found' }, 404);
  const post = postDoc.data;

  const teamId = String(post.teamId || '').trim();
  if (!teamId) return json({ ok: false, error: 'post_missing_team' }, 400);

  const senderId = String(post.senderId || post.authorId || '').trim();
  const authorRole = resolveAuthorRole(post);

  // Coach-authored posts bypass this endpoint — the client-side coach
  // fanout in Wall.tsx already covers them. Report noop so the caller
  // (if it accidentally routes a coach post here) can just log.
  if (isCoachRole(authorRole)) {
    return json({ ok: true, skipped: 'coach_authored' });
  }

  // Team look-up drives every decision below.
  const teamDoc = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!teamDoc?.data) return json({ ok: false, error: 'team_not_found' }, 404);
  const team = teamDoc.data;
  const coachIds: string[] = Array.isArray(team.coachIds) ? team.coachIds : [];

  // Authorization on the caller. See file header for reasoning.
  if (event === 'created') {
    if (senderId && claims.uid !== senderId) {
      return json({ ok: false, error: 'not_post_author' }, 403);
    }
  } else {
    // 'approved' — coach must be on the team's coachIds. Club admins
    // aren't automatically approved because the payload comes from a
    // team-level surface; if a club admin ever needs this we can widen
    // the check later.
    if (!coachIds.includes(claims.uid)) {
      return json({ ok: false, error: 'not_team_coach' }, 403);
    }
  }

  const wallConfig: any = team.wallConfig || {};
  // Defaults per spec: notifyCoach on unless explicitly false.
  const notifyCoach = wallConfig.notifyCoach !== false;
  // allowParentEmail defaults OFF — coach must opt-in per team.
  const allowParentEmail = wallConfig.allowParentEmail === true;
  // requireCoachApproval defaults OFF — parents post live by default.
  const requireCoachApproval = wallConfig.requireCoachApproval === true;

  const status = String(post.status || 'live').toLowerCase();
  const parentName = String(post.authorName || post.senderName || 'A parent').trim() || 'A parent';
  const teamName = String(team.name || 'the team').trim() || 'the team';
  const url = buildPostUrl(env, postId);

  // Poll detection — same shape the client composer writes: inline
  // { question, options[] } sub-object on the post doc.
  const poll: any = post.poll || null;
  const hasPoll = !!(poll && typeof poll.question === 'string' && poll.question.trim());
  const pollQuestion = hasPoll ? String(poll.question).trim() : null;

  // ── Coach push ──────────────────────────────────────────────
  let pushSummary: { sent: number; failed: number; recipients: number } | null = null;
  if (event === 'created' && notifyCoach) {
    const title = status === 'pending'
      ? 'From the Circle, ready for your look'
      : 'A note from the Circle';
    const body = status === 'pending'
      ? `${parentName} shared something to the team wall. Tap to give it the nod.`
      : `${parentName} shared something to the team wall. Tap to see.`;
    pushSummary = await pushCoachesOfTeam(pid, sa, env, {
      teamId,
      coachIds,
      excludeUid: claims.uid,
      title,
      body,
      url,
    });
  }

  // ── Email fanout ────────────────────────────────────────────
  // 'created' + status='live' + approval NOT required → fire now.
  // 'created' + status='pending' (approval on) → skip; coach approval
  //   endpoint will call us back with event='approved' when the flag
  //   flips and status is now 'live'.
  // 'approved' + status='live' → fire.
  let emailSummary: { sent: number; failed: number; recipients: number } | null = null;
  const shouldFanoutEmail =
    allowParentEmail &&
    status === 'live' &&
    (
      (event === 'created' && !requireCoachApproval) ||
      (event === 'approved')
    );

  if (shouldFanoutEmail) {
    const recipients = await collectTeamEmails(pid, sa, teamId, senderId || claims.uid);
    if (recipients.length > 0) {
      // Content HTML: the composer stamps sanitized TipTap HTML into
      // `content`. `contentHtml` is accepted as an override for future
      // flexibility; falls back to `content`.
      const contentHtml = String(post.contentHtml || post.content || '');
      const tpl = renderParentPostEmail({
        teamName,
        parentName,
        contentHtml,
        postUrl: url,
        hasPoll,
        pollQuestion,
      });
      const messages = recipients.map((to) => ({ to, subject: tpl.subject, html: tpl.html }));
      const batchResult = await sendEmailBatch(env, messages);
      emailSummary = { ...batchResult, recipients: recipients.length };
    } else {
      emailSummary = { sent: 0, failed: 0, recipients: 0 };
    }
  }

  return json({
    ok: true,
    event,
    status,
    notifyCoach,
    allowParentEmail,
    requireCoachApproval,
    push: pushSummary,
    email: emailSummary,
  });
}
