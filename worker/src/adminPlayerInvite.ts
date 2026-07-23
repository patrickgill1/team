/**
 * Admin-side player invite retrofit endpoint.
 *
 * The client (Players.tsx handleImportRow / InlineDevPlanCard etc.)
 * already creates player invites via createPlayerInvite +
 * buildParentInviteEmail + sendEmail from the coach's session. This
 * endpoint is the ADMIN portal's counterpart: coach doesn't have to
 * be signed in on their phone for support to re-fire a Circle invite
 * to a stranded parent email.
 *
 * Auth: x-api-key header matching ADMIN_API_KEY. Not exposed to app
 * users; only the admin.goalkickr.com Next.js server calls it.
 *
 * Payload:
 *   { playerId, email, actorUid?, actorName?, relationship? }
 *
 * Side effects (all admin-SDK writes, no rule checks):
 *   1. Creates invites/{slug} doc mirroring createPlayerInvite shape.
 *   2. Renders a warm parent-invite email (subject + HTML + text).
 *   3. Sends via Resend.
 *
 * Returns { ok, inviteId, inviteUrl }.
 */

import { getDocument, createDocument } from './firestore';
import { parseServiceAccount, type ServiceAccount } from './fcm';

interface Env {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
  APP_ORIGIN?: string;
  ADMIN_API_KEY?: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  FROM_NAME?: string;
}

const APP_NAME = 'GoalKickr';
const APP_STORE_URL = 'https://apps.apple.com/us/app/goalkickr/id6749113213';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function newSlug(): string {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

function firstName(full: string): string {
  return (full || '').trim().split(/\s+/)[0] || 'the coach';
}

function relationshipNoun(r?: string): string {
  switch (r) {
    case 'grandparent': return 'grandparent';
    case 'aunt_uncle':  return 'family';
    case 'guardian':    return 'guardian';
    case 'sibling':     return 'family';
    case 'other':       return 'family';
    default:            return 'parent';
  }
}

// Kept intentionally lean vs the main app's ornate template. Coach-
// name-signed, one CTA button, App Store link, done. If we ever want
// the fully-branded version, extract the shared builder into a
// package both worker + client import.
function buildInviteEmail(opts: {
  playerName: string;
  teamName: string;
  coachName: string;
  inviteLink: string;
  relationship?: string;
}) {
  const coachFirst = firstName(opts.coachName);
  const noun = relationshipNoun(opts.relationship);
  const subject = `${coachFirst} invited you to ${opts.teamName} on ${APP_NAME}`;
  const text = [
    'Hi,',
    '',
    `${opts.coachName} added ${opts.playerName} to ${opts.teamName} on ${APP_NAME}.`,
    '',
    `Tap the link below to set up your ${noun} account so you can RSVP to events, get team messages, and follow ${opts.playerName}:`,
    '',
    opts.inviteLink,
    '',
    `App Store: ${APP_STORE_URL}`,
    '',
    `— The ${APP_NAME} team`,
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#0d0d10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#f5f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
    <tr><td style="padding:0 0 24px 0;">
      <div style="font-size:22px;font-weight:800;letter-spacing:0.5px;">
        <span style="color:#f5f5f7;">GOAL</span><span style="color:#ef4444;">KICKR</span>
      </div>
    </td></tr>
    <tr><td style="padding:0 0 16px 0;font-size:16px;line-height:1.5;">
      Hi,
    </td></tr>
    <tr><td style="padding:0 0 16px 0;font-size:16px;line-height:1.5;">
      <strong style="color:#f5f5f7;">${opts.coachName}</strong> added <strong style="color:#f5f5f7;">${opts.playerName}</strong> to <strong style="color:#f5f5f7;">${opts.teamName}</strong> on ${APP_NAME}.
    </td></tr>
    <tr><td style="padding:0 0 24px 0;font-size:16px;line-height:1.5;color:#d4d4d8;">
      Tap the button to set up your ${noun} account so you can RSVP to events, get team messages, and follow ${opts.playerName}.
    </td></tr>
    <tr><td style="padding:0 0 24px 0;">
      <a href="${opts.inviteLink}" style="display:inline-block;padding:14px 24px;background:#ef4444;color:#ffffff;font-weight:800;text-decoration:none;border-radius:10px;font-size:15px;">
        Join ${opts.playerName}'s Circle
      </a>
    </td></tr>
    <tr><td style="padding:0 0 16px 0;font-size:13px;line-height:1.5;color:#a1a1aa;">
      Or paste this link: <a href="${opts.inviteLink}" style="color:#f97316;word-break:break-all;">${opts.inviteLink}</a>
    </td></tr>
    <tr><td style="padding:16px 0 0 0;border-top:1px solid #27272a;font-size:12px;color:#71717a;">
      Get the app: <a href="${APP_STORE_URL}" style="color:#a1a1aa;">App Store</a>
      &nbsp;·&nbsp; The ${APP_NAME} team
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

async function sendViaResend(
  env: Env,
  to: string,
  template: { subject: string; html: string; text: string },
): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: `${env.FROM_NAME || 'GoalKickr'} <${env.FROM_EMAIL || 'noreply@goalkickr.com'}>`,
      to,
      subject: template.subject,
      html: template.html,
      text: template.text,
    }),
  });
  if (!r.ok) {
    console.error('[admin-player-invite] resend send failed', r.status, (await r.text()).slice(0, 300));
    return false;
  }
  return true;
}

export async function handleAdminSendPlayerInvite(req: Request, env: Env, payload: any): Promise<Response> {
  const providedKey = req.headers.get('x-api-key') || '';
  if (!env.ADMIN_API_KEY || providedKey !== env.ADMIN_API_KEY) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const playerId = String(payload?.playerId || '').trim();
  const email = String(payload?.email || '').trim().toLowerCase();
  const actorUid = String(payload?.actorUid || '').trim() || 'admin';
  const actorName = String(payload?.actorName || 'Coach').trim() || 'Coach';
  const relationship = payload?.relationship ? String(payload.relationship) : undefined;
  if (!playerId) return json({ ok: false, error: 'missing_playerId' }, 400);
  if (!email || !email.includes('@')) return json({ ok: false, error: 'invalid_email' }, 400);

  const pid = env.FIREBASE_PROJECT_ID;
  const rawSa = env.FCM_SERVICE_ACCOUNT;
  if (!pid || !rawSa) return json({ ok: false, error: 'server_not_configured' }, 500);
  let sa: ServiceAccount;
  try { sa = parseServiceAccount(rawSa); }
  catch { return json({ ok: false, error: 'sa_parse_failed' }, 500); }

  // Load player -> team so the email can address it correctly.
  const player = await getDocument(pid, `players/${playerId}`, sa).catch(() => null);
  if (!player?.data) return json({ ok: false, error: 'player_not_found' }, 404);
  const playerName = String(player.data.name || 'your player');
  const teamId = String(player.data.teamId || (Array.isArray(player.data.teamIds) ? player.data.teamIds[0] : '') || '');
  if (!teamId) return json({ ok: false, error: 'player_has_no_team' }, 409);
  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const teamName = String(team?.data?.name || 'the team');

  // Create the invite doc. Mirrors createPlayerInvite's shape so
  // consumeInvite on the app side treats it identically to a
  // coach-generated invite.
  const slug = newSlug();
  const ttlDays = 30;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
  const inv: Record<string, any> = {
    id: slug,
    type: 'player',
    teamId,
    playerId,
    createdBy: actorUid,
    createdAt: new Date(),
    expiresAt,
    maxUses: 5,
    usedCount: 0,
    usedBy: [],
    sourceEmail: email,
  };
  if (relationship) inv.relationship = relationship;
  try {
    await createDocument(pid, 'invites', inv, sa, slug);
  } catch (err) {
    return json({ ok: false, error: 'invite_create_failed', detail: String((err as Error)?.message || err).slice(0, 200) }, 500);
  }

  const appOrigin = env.APP_ORIGIN || 'https://app.goalkickr.com';
  const inviteLink = `${appOrigin}/join/${slug}`;
  const template = buildInviteEmail({ playerName, teamName, coachName: actorName, inviteLink, relationship });
  const sent = await sendViaResend(env, email, template);
  if (!sent) {
    return json({ ok: false, error: 'send_failed', inviteId: slug, inviteUrl: inviteLink }, 502);
  }
  return json({ ok: true, inviteId: slug, inviteUrl: inviteLink });
}
