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

import { collection, getDocs, query, where, doc, getDoc, updateDoc, arrayRemove } from 'firebase/firestore';
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

// Push preferences are independent of email preferences. Parents who
// mute the weekly digest email don't want their game-day push muted too.
export type PushPrefKey = 'chat' | 'helpdesk' | 'events' | 'broadcast';

export interface PushPreferences {
  chat: boolean;
  helpdesk: boolean;
  events: boolean;
  broadcast: boolean;
}

export const DEFAULT_PUSH_PREFS: PushPreferences = {
  chat: true,
  helpdesk: true,
  events: true,
  broadcast: true,
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
  opts?: { prefKey?: EmailPrefKey; pushPrefKey?: PushPrefKey; fromUid?: string }
): Promise<boolean> {
  if (!configured()) return false;
  if (!userIds || userIds.length === 0) return false;
  try {
    // tokenToUids maps each token back to all users it belongs to, so
    // when the worker reports dead tokens we know whose user doc to clean.
    const tokens: string[] = [];
    const seen = new Set<string>();
    const tokenToUids: Record<string, Set<string>> = {};
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
        if (opts?.pushPrefKey) {
          const pprefs: PushPreferences = { ...DEFAULT_PUSH_PREFS, ...(u.pushPreferences || {}) };
          if (!pprefs[opts.pushPrefKey]) continue;
        }
        // Recipient-side mute: this user has chosen not to be pushed
        // when `fromUid` posts. The message still lands in the thread
        // (mute is personal preference, not block).
        if (opts?.fromUid && Array.isArray(u.mutedUserIds) && u.mutedUserIds.includes(opts.fromUid)) continue;
        const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
        for (const t of arr) {
          if (typeof t !== 'string' || !t) continue;
          if (!tokenToUids[t]) tokenToUids[t] = new Set();
          tokenToUids[t].add(uid);
          if (!seen.has(t)) { seen.add(t); tokens.push(t); }
        }
      } catch { /* ignore */ }
    }
    if (tokens.length === 0) {
      console.warn('[notify] push: no FCM tokens registered for any recipient');
      return false;
    }
    const res = await fetch(`${NOTIFY_URL}/send-push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
      body: JSON.stringify({ tokens, title: msg.title, body: msg.body, url: msg.url }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[notify] push: worker returned ${res.status}`, body);
      return false;
    }
    // Worker returns { invalidTokens: [...] } for tokens FCM rejected as
    // UNREGISTERED / NOT_FOUND. Strip those from every user doc that
    // held them, so we stop wasting calls on dead devices forever.
    try {
      const data: any = await res.json();
      const invalid: string[] = Array.isArray(data?.invalidTokens) ? data.invalidTokens : [];
      for (const dead of invalid) {
        const uids = tokenToUids[dead];
        if (!uids) continue;
        for (const uid of Array.from(uids)) {
          try {
            await updateDoc(doc(db, 'users', uid), { fcmTokens: arrayRemove(dead) });
          } catch { /* ignore — best-effort cleanup */ }
        }
      }
      if (invalid.length > 0) {
        console.info(`[notify] pruned ${invalid.length} dead FCM token(s)`);
      }
    } catch { /* response body parse — ignore */ }
    return true;
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
  opts?: EmailPrefKey | { prefKey?: EmailPrefKey; pushPrefKey?: PushPrefKey },
): Promise<boolean> {
  try {
    const playerSnap = await getDoc(doc(db, 'players', playerId));
    if (!playerSnap.exists()) return false;
    const player: any = playerSnap.data();
    const candidateUids: string[] = Array.isArray(player.parentIds) ? [...player.parentIds] : [];
    if (player.parentId && !candidateUids.includes(player.parentId)) candidateUids.push(player.parentId);
    if (candidateUids.length === 0) return false;
    // Back-compat: callers used to pass just a string EmailPrefKey.
    const normalized = typeof opts === 'string' ? { prefKey: opts } : (opts || {});
    return await sendPushToUsers(candidateUids, msg, normalized);
  } catch (err) {
    console.warn('[notify] sendPushToPlayerParents failed', err);
    return false;
  }
}

// Canonical web origin for email/HTML asset URLs. We can't use
// window.location.origin alone because on the Capacitor iOS shell it's
// `capacitor://localhost` — any image embedded in an email would 404.
import { getShareOrigin } from './origin';
const APP_BASE = getShareOrigin();

const BRAND_NAVY = '#0f172a';      // slate-900 — the app's primary dark
const BRAND_NAVY_DARK = '#020617'; // slate-950
const BRAND_CYAN = '#06b6d4';      // cyan-500 — the app's accent
const BRAND_CYAN_DEEP = '#0e7490'; // cyan-700 — for text on light bg
const LOGO_URL = `${APP_BASE}/images/logo.png`;

const baseStyle = `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.55;background:#f0f9ff;`;

/** Coach signature payload — name, role, team, optional email for
 *  replies, optional avatar URL. Threaded through templates that
 *  originate from a coach (dev plan, clip upload, parent whisper).
 *  Skipped for system-authored emails like POTM win. */
export interface CoachSignature {
  name: string;
  role?: string;     // "Head Coach", "Assistant Coach", etc.
  teamName?: string; // "Fire FC PG (U10)"
  email?: string;
  avatarUrl?: string;
}

function signatureBlock(sig?: CoachSignature): string {
  if (!sig || !sig.name) return '';
  const initial = (sig.name || '?').charAt(0).toUpperCase();
  const avatar = sig.avatarUrl
    ? `<img src="${sig.avatarUrl}" alt="" width="40" height="40" style="display:block;border-radius:50%;border:0;outline:none;object-fit:cover;" />`
    : `<div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,${BRAND_CYAN} 0%,${BRAND_CYAN_DEEP} 100%);color:#ffffff;font-weight:800;font-size:16px;text-align:center;line-height:40px;">${initial}</div>`;
  const meta: string[] = [];
  if (sig.role) meta.push(sig.role);
  if (sig.teamName) meta.push(sig.teamName);
  const metaLine = meta.length ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">${meta.join(' · ')}</div>` : '';
  const replyLine = sig.email
    ? `<div style="font-size:12px;color:#64748b;margin-top:4px;">Reply at <a href="mailto:${sig.email}" style="color:${BRAND_CYAN_DEEP};text-decoration:none;">${sig.email}</a></div>`
    : '';
  return `
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;">
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="vertical-align:middle;padding-right:10px;">${avatar}</td>
          <td style="vertical-align:middle;">
            <div style="font-weight:700;font-size:14px;color:#0f172a;">${sig.name}</div>
            ${metaLine}
            ${replyLine}
          </td>
        </tr>
      </table>
    </div>`;
}

function wrap(inner: string, opts: { footer?: string; signature?: CoachSignature } = {}): string {
  const { footer = '', signature } = opts;
  return `<div style="${baseStyle}padding:24px 12px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
      <div style="background:linear-gradient(135deg,${BRAND_NAVY_DARK} 0%,${BRAND_NAVY} 100%);padding:24px;text-align:center;border-bottom:3px solid ${BRAND_CYAN};">
        <img src="${LOGO_URL}" alt="Fire FC" width="64" height="64" style="display:inline-block;border:0;outline:none;text-decoration:none;" />
        <div style="color:#ffffff;font-weight:900;font-size:18px;letter-spacing:2.5px;margin-top:10px;text-transform:uppercase;">Fire FC</div>
      </div>
      <div style="padding:28px 24px 20px;">
        ${inner}
        ${signatureBlock(signature)}
      </div>
      <div style="background:#f8fafc;padding:14px 24px;font-size:11px;color:#64748b;text-align:center;border-top:1px solid #e2e8f0;">
        ${footer ? `${footer}<br/>` : ''}
        Manage your notification preferences on <a href="${APP_BASE}/settings" style="color:${BRAND_CYAN_DEEP};text-decoration:none;font-weight:600;">Fire FC</a>.
      </div>
    </div>
  </div>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:0 0 16px;"><a href="${href}" style="display:inline-block;background:linear-gradient(135deg,${BRAND_CYAN} 0%,${BRAND_CYAN_DEEP} 100%);color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:14px;letter-spacing:0.3px;box-shadow:0 2px 8px rgba(6,182,212,0.25);">${label}</a></p>`;
}

/* ---------------- TEMPLATES ---------------- */

export function tplDevPlan(opts: {
  playerName: string;
  planTitle: string;
  goalCount: number;
  coachName: string;
  signature?: CoachSignature;
}): { subject: string; html: string } {
  const subject = `New development plan for ${opts.playerName}: ${opts.planTitle}`;
  const html = wrap(`
    <div style="display:inline-block;background:${BRAND_CYAN}1A;color:${BRAND_CYAN_DEEP};font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px;border-radius:6px;margin-bottom:12px;">New development plan</div>
    <h2 style="font-size:22px;margin:0 0 8px;color:${BRAND_NAVY_DARK};font-weight:800;line-height:1.25;">${opts.planTitle}</h2>
    <p style="margin:0 0 18px;color:#475569;">For <b style="color:#0f172a;">${opts.playerName}</b> — ${opts.goalCount} goal${opts.goalCount === 1 ? '' : 's'} to work on this cycle.</p>
    ${button(`${APP_BASE}/development`, 'Open the plan')}
  `, { signature: opts.signature || { name: opts.coachName, role: 'Coach' } });
  return { subject, html };
}

export function tplClipUploaded(opts: {
  playerName: string;
  uploaderName: string;
  isVideo: boolean;
  caption?: string;
  signature?: CoachSignature;
}): { subject: string; html: string } {
  const kind = opts.isVideo ? 'video clip' : 'photo';
  const subject = `New ${kind} of ${opts.playerName}`;
  const html = wrap(`
    <div style="display:inline-block;background:${BRAND_CYAN}1A;color:${BRAND_CYAN_DEEP};font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px;border-radius:6px;margin-bottom:12px;">New ${kind}</div>
    <h2 style="font-size:22px;margin:0 0 8px;color:${BRAND_NAVY_DARK};font-weight:800;line-height:1.25;">${opts.playerName} caught on camera</h2>
    <p style="margin:0 0 12px;color:#475569;">Shared by <b style="color:#0f172a;">${opts.uploaderName}</b>.</p>
    ${opts.caption ? `<div style="margin:0 0 18px;padding:12px 14px;background:#f1f5f9;border-left:3px solid ${BRAND_CYAN};border-radius:6px;color:#334155;font-style:italic;">"${opts.caption}"</div>` : ''}
    ${button(`${APP_BASE}/player-media`, `Watch the ${opts.isVideo ? 'clip' : 'photo'}`)}
  `, { signature: opts.signature || { name: opts.uploaderName } });
  return { subject, html };
}

export function tplPotmWin(opts: {
  playerName: string;
  voteCount: number;
  gameTitle: string;
  isCoWin: boolean;
}): { subject: string; html: string } {
  const subject = `${opts.playerName} won Player of the Match`;
  const html = wrap(`
    <div style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px;border-radius:6px;margin-bottom:12px;">Player of the Match</div>
    <h2 style="font-size:22px;margin:0 0 8px;color:${BRAND_NAVY_DARK};font-weight:800;line-height:1.25;">${opts.playerName} ${opts.isCoWin ? 'is a co-winner!' : 'took home POTM!'}</h2>
    <p style="margin:0 0 18px;color:#475569;">${opts.voteCount} vote${opts.voteCount === 1 ? '' : 's'} for ${opts.gameTitle}. Hard-earned recognition from the team.</p>
    ${button(`${APP_BASE}/player-of-match`, 'See the results')}
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
  signature?: CoachSignature;
}): { subject: string; html: string } {
  const subject = `A note from Coach ${opts.coachName} about ${opts.playerName}`;
  const safeMsg = (opts.message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
  const html = wrap(`
    <div style="display:inline-block;background:${BRAND_CYAN}1A;color:${BRAND_CYAN_DEEP};font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px;border-radius:6px;margin-bottom:12px;">A note from your coach</div>
    <h2 style="font-size:22px;margin:0 0 8px;color:${BRAND_NAVY_DARK};font-weight:800;line-height:1.25;">About ${opts.playerName}</h2>
    <div style="margin:14px 0 18px;padding:16px 18px;background:#f0f9ff;border-left:3px solid ${BRAND_CYAN};border-radius:8px;color:#0c4a6e;font-size:15px;line-height:1.6;">
      ${safeMsg}
    </div>
    ${opts.recentDevPlanTitle ? `<p style="margin:0 0 8px;font-size:13px;color:#64748b;">Active development plan: <b style="color:#0f172a;">${opts.recentDevPlanTitle}</b></p>` : ''}
    ${opts.clipUrl ? `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">Recent highlight${opts.clipCaption ? ` — "${opts.clipCaption}"` : ''}: <a href="${opts.clipUrl}" style="color:${BRAND_CYAN_DEEP};font-weight:600;">watch clip</a></p>` : ''}
    ${button(`${APP_BASE}/players`, `Open ${opts.playerName}'s profile`)}
  `, { signature: opts.signature || { name: opts.coachName, role: 'Coach' } });
  return { subject, html };
}
