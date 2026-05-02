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

const APP_BASE = (typeof window !== 'undefined' && window.location?.origin) || 'https://firefc16.com';

const baseStyle = `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111827;line-height:1.5;`;

function wrap(inner: string, footer = ''): string {
  return `<div style="${baseStyle}max-width:560px;margin:0 auto;padding:24px;">
    <div style="font-size:20px;font-weight:800;color:#dc2626;margin-bottom:16px;">🔥 Fire FC16</div>
    ${inner}
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
      ${footer}
      You can change which emails you receive in your profile on Fire FC16.
    </div>
  </div>`;
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
    <h2 style="font-size:18px;margin:0 0 12px;">New development plan 🎯</h2>
    <p style="margin:0 0 12px;">Coach <b>${opts.coachName}</b> just created a development plan for <b>${opts.playerName}</b>.</p>
    <p style="margin:0 0 16px;"><b>${opts.planTitle}</b><br/><span style="color:#6b7280;font-size:14px;">${opts.goalCount} goal${opts.goalCount === 1 ? '' : 's'} to work on</span></p>
    <p style="margin:0 0 16px;">
      <a href="${APP_BASE}/player-development" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;">View plan</a>
    </p>
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
    <h2 style="font-size:18px;margin:0 0 12px;">${opts.isVideo ? '🎬' : '📸'} New ${kind}</h2>
    <p style="margin:0 0 12px;"><b>${opts.uploaderName}</b> just shared a new ${kind} of <b>${opts.playerName}</b>.</p>
    ${opts.caption ? `<p style="margin:0 0 16px;color:#374151;font-style:italic;">"${opts.caption}"</p>` : ''}
    <p style="margin:0 0 16px;">
      <a href="${APP_BASE}/player-media" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;">Open media</a>
    </p>
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
    <h2 style="font-size:18px;margin:0 0 12px;">🏆 Player of the Match</h2>
    <p style="margin:0 0 12px;">Congratulations — <b>${opts.playerName}</b> ${opts.isCoWin ? 'is a co-winner of' : 'won'} Player of the Match for <b>${opts.gameTitle}</b> with ${opts.voteCount} vote${opts.voteCount === 1 ? '' : 's'}!</p>
    <p style="margin:0 0 16px;">
      <a href="${APP_BASE}/player-of-match" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;">See results</a>
    </p>
  `);
  return { subject, html };
}
