/**
 * Client helper for the firefc16-mailer Cloudflare Worker.
 *
 * Reads:
 *   process.env.REACT_APP_NOTIFY_URL     e.g. https://firefc16-mailer.xxx.workers.dev
 *   process.env.REACT_APP_NOTIFY_SECRET  Bearer token (also set as worker secret)
 *
 * If env is missing, helpers no-op (so dev/local builds don't crash) and log a warning.
 *
 * Honors per-user opt-outs read from /users/{uid}.emailPreferences.
 */
// @ts-nocheck

import { collection, getDocs, query, where, doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';

const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
const NOTIFY_SECRET = process.env.REACT_APP_NOTIFY_SECRET;

export type EmailPrefKey = 'devPlan' | 'clip' | 'potm' | 'digest';

export interface EmailPreferences {
  devPlan: boolean;
  clip: boolean;
  potm: boolean;
  digest: boolean;
}

export const DEFAULT_EMAIL_PREFS: EmailPreferences = {
  devPlan: true,
  clip: true,
  potm: true,
  digest: true,
};

export interface NotifyMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

function configured(): boolean {
  if (!NOTIFY_URL || !NOTIFY_SECRET) {
    if (typeof window !== 'undefined' && !(window as any).__notifyWarned) {
      // eslint-disable-next-line no-console
      console.warn('[notify] REACT_APP_NOTIFY_URL / REACT_APP_NOTIFY_SECRET not set — emails disabled.');
      (window as any).__notifyWarned = true;
    }
    return false;
  }
  return true;
}

export async function sendEmail(msg: NotifyMessage): Promise<boolean> {
  if (!configured()) return false;
  try {
    const res = await fetch(`${NOTIFY_URL}/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${NOTIFY_SECRET}`,
      },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[notify] send failed', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notify] send threw', err);
    return false;
  }
}

export async function sendEmailBatch(messages: NotifyMessage[]): Promise<boolean> {
  if (!configured()) return false;
  if (messages.length === 0) return true;
  try {
    const res = await fetch(`${NOTIFY_URL}/send-batch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${NOTIFY_SECRET}`,
      },
      body: JSON.stringify({ messages }),
    });
    return res.ok;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notify] batch send threw', err);
    return false;
  }
}

/** Look up parent emails for a player, honoring each user's emailPreferences[prefKey]. */
export async function getParentEmailsForPlayer(
  playerId: string,
  prefKey: EmailPrefKey
): Promise<{ email: string; name: string }[]> {
  try {
    const playerSnap = await getDoc(doc(db, 'players', playerId));
    if (!playerSnap.exists()) return [];
    const player: any = playerSnap.data();

    const candidateUids: string[] = Array.isArray(player.parentIds) ? [...player.parentIds] : [];
    if (player.parentId && !candidateUids.includes(player.parentId)) candidateUids.push(player.parentId);

    const seenEmails = new Set<string>();
    const recipients: { email: string; name: string }[] = [];

    // Resolve parent users
    for (const uid of candidateUids) {
      try {
        const uSnap = await getDoc(doc(db, 'users', uid));
        if (!uSnap.exists()) continue;
        const u: any = uSnap.data();
        if (u.isActive === false) continue;
        const prefs: EmailPreferences = { ...DEFAULT_EMAIL_PREFS, ...(u.emailPreferences || {}) };
        if (!prefs[prefKey]) continue;
        const email = (u.email || '').trim().toLowerCase();
        if (!email || seenEmails.has(email)) continue;
        seenEmails.add(email);
        recipients.push({ email, name: u.name || '' });
      } catch {
        /* ignore */
      }
    }

    // Fall back to parentEmails on the player doc (e.g. invited but not yet joined)
    if (Array.isArray(player.parentEmails)) {
      for (const raw of player.parentEmails) {
        const email = String(raw || '').trim().toLowerCase();
        if (!email || seenEmails.has(email)) continue;
        // For un-joined parents we have no prefs; default-on (they can opt out after joining)
        seenEmails.add(email);
        recipients.push({ email, name: '' });
      }
    }

    return recipients;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notify] getParentEmailsForPlayer failed', err);
    return [];
  }
}

/**
 * Send a Web Push notification to a list of user UIDs (looks up their saved
 * fcmTokens). Silent no-op if push isn't configured. Honors emailPreferences
 * via the same prefKey when provided.
 */
export async function sendPushToUsers(
  userIds: string[],
  msg: { title: string; body: string; url?: string },
  opts?: { prefKey?: EmailPrefKey }
): Promise<boolean> {
  if (!configured()) return false;
  if (!userIds || userIds.length === 0) return false;
  try {
    const tokens: string[] = [];
    const seen = new Set<string>();
    for (const uid of userIds) {
      try {
        const uSnap = await getDoc(doc(db, 'users', uid));
        if (!uSnap.exists()) continue;
        const u: any = uSnap.data();
        if (u.isActive === false) continue;
        if (opts?.prefKey) {
          const prefs: EmailPreferences = { ...DEFAULT_EMAIL_PREFS, ...(u.emailPreferences || {}) };
          if (!prefs[opts.prefKey]) continue;
        }
        const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
        for (const t of arr) {
          if (typeof t === 'string' && t && !seen.has(t)) { seen.add(t); tokens.push(t); }
        }
      } catch { /* ignore */ }
    }
    if (tokens.length === 0) return false;
    const res = await fetch(`${NOTIFY_URL}/send-push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
      body: JSON.stringify({ tokens, title: msg.title, body: msg.body, url: msg.url }),
    });
    return res.ok;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notify] push send threw', err);
    return false;
  }
}

/**
 * Resolve a player's parent UIDs and fan out a push notification to them.
 * Mirrors getParentEmailsForPlayer + sendEmail, but for FCM push. Parents
 * who haven't installed the app (no fcmTokens) silently get nothing.
 */
export async function sendPushToPlayerParents(
  playerId: string,
  msg: { title: string; body: string; url?: string; path?: string },
  prefKey: EmailPrefKey,
): Promise<boolean> {
  try {
    const playerSnap = await getDoc(doc(db, 'players', playerId));
    if (!playerSnap.exists()) return false;
    const player: any = playerSnap.data();
    const candidateUids: string[] = Array.isArray(player.parentIds) ? [...player.parentIds] : [];
    if (player.parentId && !candidateUids.includes(player.parentId)) candidateUids.push(player.parentId);
    if (candidateUids.length === 0) return false;
    return await sendPushToUsers(candidateUids, msg, { prefKey });
  } catch (err) {
    console.warn('[notify] sendPushToPlayerParents failed', err);
    return false;
  }
}

const APP_BASE = (typeof window !== 'undefined' && window.location?.origin) || 'https://firefc16.com';

const BRAND_NAVY = '#1e3a5f';
const BRAND_NAVY_DARK = '#122340';
const LOGO_URL = `${APP_BASE}/images/logo.png`;

const baseStyle = `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111827;line-height:1.5;background:#f3f4f6;`;

function wrap(inner: string, footer = ''): string {
  return `<div style="${baseStyle}padding:24px 12px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      <div style="background:${BRAND_NAVY};padding:20px 24px;text-align:center;">
        <img src="${LOGO_URL}" alt="Fire FC16" width="56" height="56" style="display:inline-block;border:0;outline:none;text-decoration:none;" />
        <div style="color:#ffffff;font-weight:700;font-size:16px;letter-spacing:0.5px;margin-top:8px;">FIRE FC16</div>
      </div>
      <div style="padding:24px;">
        ${inner}
        <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
          ${footer}
          You can change which emails you receive in your profile on <a href="${APP_BASE}" style="color:${BRAND_NAVY};text-decoration:none;">Fire FC16</a>.
        </div>
      </div>
    </div>
  </div>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;background:${BRAND_NAVY};color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;">${label}</a></p>`;
}

/* ---------------- TEMPLATES ---------------- */

export function tplDevPlan(opts: {
  playerName: string;
  planTitle: string;
  goalCount: number;
  coachName: string;
}): { subject: string; html: string } {
  const subject = `New development plan for ${opts.playerName}: ${opts.planTitle}`;
  const html = wrap(`
    <h2 style="font-size:18px;margin:0 0 12px;color:${BRAND_NAVY_DARK};">New development plan 🎯</h2>
    <p style="margin:0 0 12px;">Coach <b>${opts.coachName}</b> just created a development plan for <b>${opts.playerName}</b>.</p>
    <p style="margin:0 0 16px;"><b>${opts.planTitle}</b><br/><span style="color:#6b7280;font-size:14px;">${opts.goalCount} goal${opts.goalCount === 1 ? '' : 's'} to work on</span></p>
    ${button(`${APP_BASE}/development`, 'View plan')}
  `);
  return { subject, html };
}

export function tplClipUploaded(opts: {
  playerName: string;
  uploaderName: string;
  isVideo: boolean;
  caption?: string;
}): { subject: string; html: string } {
  const kind = opts.isVideo ? 'video clip' : 'photo';
  const subject = `New ${kind} of ${opts.playerName}`;
  const html = wrap(`
    <h2 style="font-size:18px;margin:0 0 12px;color:${BRAND_NAVY_DARK};">${opts.isVideo ? '🎬' : '📸'} New ${kind}</h2>
    <p style="margin:0 0 12px;"><b>${opts.uploaderName}</b> just shared a new ${kind} of <b>${opts.playerName}</b>.</p>
    ${opts.caption ? `<p style="margin:0 0 16px;color:#374151;font-style:italic;">"${opts.caption}"</p>` : ''}
    ${button(`${APP_BASE}/player-media`, 'Open media')}
  `);
  return { subject, html };
}

export function tplPotmWin(opts: {
  playerName: string;
  voteCount: number;
  gameTitle: string;
  isCoWin: boolean;
}): { subject: string; html: string } {
  const subject = `🏆 ${opts.playerName} won Player of the Match!`;
  const html = wrap(`
    <h2 style="font-size:18px;margin:0 0 12px;color:${BRAND_NAVY_DARK};">🏆 Player of the Match</h2>
    <p style="margin:0 0 12px;">Congratulations — <b>${opts.playerName}</b> ${opts.isCoWin ? 'is a co-winner of' : 'won'} Player of the Match for <b>${opts.gameTitle}</b> with ${opts.voteCount} vote${opts.voteCount === 1 ? '' : 's'}!</p>
    ${button(`${APP_BASE}/player-of-match`, 'See results')}
  `);
  return { subject, html };
}

export function tplCoachWhisper(opts: {
  playerName: string;
  coachName: string;
  message: string;
  clipUrl?: string;
  clipCaption?: string;
  recentDevPlanTitle?: string;
}): { subject: string; html: string } {
  const subject = `A note from Coach ${opts.coachName} about ${opts.playerName}`;
  const safeMsg = (opts.message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
  const html = wrap(`
    <h2 style="font-size:18px;margin:0 0 12px;color:${BRAND_NAVY_DARK};">💬 A note about ${opts.playerName}</h2>
    <p style="margin:0 0 12px;color:#374151;">From <b>Coach ${opts.coachName}</b>:</p>
    <div style="margin:0 0 16px;padding:14px 16px;background:#f0f9ff;border-left:3px solid ${BRAND_NAVY};border-radius:6px;color:#0c4a6e;font-size:15px;line-height:1.55;">
      ${safeMsg}
    </div>
    ${opts.recentDevPlanTitle ? `<p style="margin:0 0 12px;font-size:13px;color:#6b7280;">Active development plan: <b style="color:#374151;">${opts.recentDevPlanTitle}</b></p>` : ''}
    ${opts.clipUrl ? `<p style="margin:0 0 12px;font-size:13px;color:#6b7280;">📎 Recent highlight ${opts.clipCaption ? `— "${opts.clipCaption}"` : ''}: <a href="${opts.clipUrl}" style="color:${BRAND_NAVY};">watch clip</a></p>` : ''}
    ${button(`${APP_BASE}/players`, `Open ${opts.playerName}'s profile`)}
  `);
  return { subject, html };
}
