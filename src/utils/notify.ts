/**
 * Client helper for the firefc16-mailer Cloudflare Worker.
 *
 * Reads:
 *   process.env.REACT_APP_NOTIFY_URL     e.g. https://firefc16-mailer.xxx.workers.dev
 *
 * Auth: each request is stamped with a Firebase ID token by workerFetch.
 * The legacy REACT_APP_NOTIFY_SECRET static bearer was retired 2026-07-03
 * because it shipped in every browser bundle.
 *
 * If env is missing, helpers no-op (so dev/local builds don't crash) and log a warning.
 *
 * Honors per-user opt-outs read from /users/{uid}.emailPreferences.
 */
// @ts-nocheck

import { collection, getDocs, query, where, doc, getDoc, updateDoc, arrayRemove } from 'firebase/firestore';
import { db } from './firebase';
import { workerFetch, hasWorkerConfig } from './workerFetch';

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
  if (!hasWorkerConfig()) {
    if (typeof window !== 'undefined' && !(window as any).__notifyWarned) {
      // eslint-disable-next-line no-console
      console.warn('[notify] REACT_APP_NOTIFY_URL not set — emails disabled.');
      (window as any).__notifyWarned = true;
    }
    return false;
  }
  return true;
}

export async function sendEmail(msg: NotifyMessage): Promise<boolean> {
  if (!configured()) return false;
  try {
    const res = await workerFetch('/send', {
      method: 'POST',
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
  if (!configured()) {
    // eslint-disable-next-line no-console
    console.error('[notify] sendEmailBatch aborted: NOTIFY_URL missing from bundle');
    return false;
  }
  if (messages.length === 0) return true;
  try {
    const res = await workerFetch('/send-batch', {
      method: 'POST',
      body: JSON.stringify({ messages }),
    });
    if (!res.ok) {
      // Capture the body so we can see exactly why the worker
      // rejected (401, 400 too-many, 500, etc). Without this it's
      // a silent boolean and impossible to debug.
      const body = await res.text().catch(() => '<no body>');
      // eslint-disable-next-line no-console
      console.error('[notify] worker rejected /send-batch', {
        status: res.status,
        statusText: res.statusText,
        bodySample: body.slice(0, 300),
      });
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notify] batch send threw', err);
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
  msg: { title: string; body: string; url?: string; badge?: number },
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
    const res = await workerFetch('/send-push', {
      method: 'POST',
      body: JSON.stringify({
        tokens, title: msg.title, body: msg.body, url: msg.url,
        // Absolute app-icon badge count (iOS + Android). Callers pass
        // this only when the notification should light up the badge —
        // chat message pushes do, informational broadcasts don't.
        badge: typeof msg.badge === 'number' ? msg.badge : undefined,
      }),
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
/** Push helper for the Club Module's registration funnel — finds the
 *  user uids that map to a set of parent emails so we can send a push
 *  on offer_sent / registration_paid / tryout_invited etc. Some emails
 *  won't match a Fire FC account (cold registrations before signup);
 *  those silently get no push and the email is the fallback. */
export async function findUserUidsByEmails(emails: string[]): Promise<string[]> {
  const lowered = Array.from(new Set(emails.map(e => e?.toLowerCase().trim()).filter(Boolean)));
  if (lowered.length === 0) return [];
  const uids: string[] = [];
  // Firestore caps `in` queries at 30 — chunk to be safe.
  for (let i = 0; i < lowered.length; i += 30) {
    const chunk = lowered.slice(i, i + 30);
    try {
      const snap = await getDocs(query(collection(db, 'users'), where('email', 'in', chunk)));
      snap.forEach(d => {
        const u: any = d.data();
        if (u.uid) uids.push(u.uid);
        else uids.push(d.id);
      });
    } catch (err) {
      console.warn('findUserUidsByEmails query failed', err);
    }
  }
  return Array.from(new Set(uids));
}

/** Convenience: send a push to the parents of a registration / offer
 *  by parent email. No-ops if no parent has a Fire FC account yet. */
export async function sendPushToParentEmails(
  emails: string[],
  msg: { title: string; body: string; url?: string }
): Promise<boolean> {
  const uids = await findUserUidsByEmails(emails);
  if (uids.length === 0) return false;
  return sendPushToUsers(uids, msg, { pushPrefKey: 'broadcast' });
}

/** Push to every authenticated user on a team. Pulls users where
 *  teamId == teamId OR teamIds array-contains teamId, dedupes by uid,
 *  optionally excludes the sender (so the coach who scheduled the
 *  event doesn't get their own push). Honors pushPreferences.events
 *  per user. */
export async function sendPushToTeam(
  teamId: string,
  msg: { title: string; body: string; url?: string },
  opts?: { excludeUid?: string }
): Promise<boolean> {
  if (!teamId) return false;
  const uidSet = new Set<string>();
  try {
    // teamId equality match (legacy single-team users).
    const s1 = await getDocs(query(collection(db, 'users'), where('teamId', '==', teamId)));
    s1.forEach(d => {
      const u: any = d.data();
      const id = u.uid || d.id;
      if (id && id !== opts?.excludeUid) uidSet.add(id);
    });
    // teamIds array-contains (multi-team users — newer model).
    const s2 = await getDocs(query(collection(db, 'users'), where('teamIds', 'array-contains', teamId)));
    s2.forEach(d => {
      const u: any = d.data();
      const id = u.uid || d.id;
      if (id && id !== opts?.excludeUid) uidSet.add(id);
    });
  } catch (err) {
    console.warn('sendPushToTeam lookup failed', err);
  }
  if (uidSet.size === 0) return false;
  return sendPushToUsers(Array.from(uidSet), msg, { pushPrefKey: 'events', fromUid: opts?.excludeUid });
}

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

const BRAND_NAVY = '#15161a';      // charcoal-900 — the app's primary dark
const BRAND_NAVY_DARK = '#0d0d10'; // charcoal-950
const BRAND_CYAN = '#c8202c';      // brand-primary — the app's accent
const BRAND_CYAN_DEEP = '#8c1922'; // brand-primary-dim — for text on light bg
const LOGO_URL = `${APP_BASE}/images/logo.png`;

const baseStyle = `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#15161a;line-height:1.55;background:#f5f3ee;`;

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
        <img src="${LOGO_URL}" alt="GoalKickr" width="64" height="64" style="display:inline-block;border:0;outline:none;text-decoration:none;" />
        <div style="color:#ffffff;font-weight:900;font-size:18px;letter-spacing:2.5px;margin-top:10px;text-transform:uppercase;">GoalKickr</div>
      </div>
      <div style="padding:28px 24px 20px;">
        ${inner}
        ${signatureBlock(signature)}
      </div>
      <div style="background:#f8fafc;padding:14px 24px;font-size:11px;color:#64748b;text-align:center;border-top:1px solid #e2e8f0;">
        ${footer ? `${footer}<br/>` : ''}
        Manage your notification preferences on <a href="${APP_BASE}/settings" style="color:${BRAND_CYAN_DEEP};text-decoration:none;font-weight:600;">GoalKickr</a>.
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

/** Welcome email sent the moment a family accepts an offer. The
 *  Registration is already promoted to a real Player at this point, so
 *  the parent can log in via the same email and see their kid on the
 *  roster. We push two things: install the app + RSVP the first event. */
export function tplWelcomeAfterOffer(opts: {
  playerName: string;
  teamName: string;
  coachName: string;
  appOrigin?: string;
  signature?: CoachSignature;
}): { subject: string; html: string } {
  const subject = `Welcome to ${opts.teamName}`;
  const base = opts.appOrigin || APP_BASE;
  const html = wrap(`
    <div style="display:inline-block;background:${BRAND_CYAN}1A;color:${BRAND_CYAN_DEEP};font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px;border-radius:6px;margin-bottom:12px;">You're in</div>
    <h2 style="font-size:22px;margin:0 0 8px;color:${BRAND_NAVY_DARK};font-weight:800;line-height:1.25;">Welcome to ${opts.teamName}, ${opts.playerName}!</h2>
    <p style="margin:0 0 14px;color:#475569;">
      ${opts.coachName} added ${opts.playerName} to the roster. Here are two quick things to set the season up right:
    </p>
    <ol style="margin:0 0 18px;padding-left:20px;color:#0f172a;line-height:1.7;font-size:15px;">
      <li><b>Open the app</b> — log in with the same email you registered with. Your player is already on the team.</li>
      <li><b>RSVP the first event</b> when it shows up on the calendar so the coach has a head count.</li>
    </ol>
    ${button(base, 'Open GoalKickr')}
    <p style="margin:8px 0 0;font-size:13px;color:#64748b;">Got questions? Just reply to this email and it goes straight to your coach.</p>
  `, { signature: opts.signature || { name: opts.coachName, role: 'Coach', teamName: opts.teamName } });
  return { subject, html };
}

/** Registration-open blast — fired by an admin from the Registrations
 *  page when a new season opens. `registerUrl` is the parent's deep
 *  link including ?return=<playerId>&season=<seasonId> so signup pre-
 *  fills from the existing player doc. */
export function tplRegistrationOpen(opts: {
  playerName: string;
  seasonName: string;
  clubName?: string;
  registerUrl: string;
  customIntro?: string;
  customSignoff?: string;
  feeCents?: number;
  earlyBirdNote?: string;
  signature?: CoachSignature;
}): { subject: string; html: string } {
  const subject = `Registration is open for ${opts.seasonName}`;
  const intro = (opts.customIntro || '').trim();
  const signoff = (opts.customSignoff || '').trim();
  const safeIntro = intro
    ? intro.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')
    : '';
  const safeSignoff = signoff
    ? signoff.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')
    : '';
  const feeLine = opts.feeCents && opts.feeCents > 0
    ? `<p style="margin:0 0 8px;font-size:13px;color:#64748b;">Registration: <b style="color:#0f172a;">$${(opts.feeCents / 100).toFixed(2)}</b>${opts.earlyBirdNote ? ` — <span style="color:#059669;font-weight:700;">${opts.earlyBirdNote}</span>` : ''}</p>`
    : '';
  const html = wrap(`
    <div style="display:inline-block;background:${BRAND_CYAN}1A;color:${BRAND_CYAN_DEEP};font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px;border-radius:6px;margin-bottom:12px;">Registration open</div>
    <h2 style="font-size:22px;margin:0 0 8px;color:${BRAND_NAVY_DARK};font-weight:800;line-height:1.25;">${opts.seasonName} is here</h2>
    <p style="margin:0 0 14px;color:#475569;">Save your spot for <b style="color:#0f172a;">${opts.playerName}</b>. The form is pre-filled — should only take a minute.</p>
    ${safeIntro ? `<div style="margin:0 0 16px;padding:14px 16px;background:#f0f9ff;border-left:3px solid ${BRAND_CYAN};border-radius:8px;color:#0c4a6e;font-size:14px;line-height:1.6;">${safeIntro}</div>` : ''}
    ${feeLine}
    ${button(opts.registerUrl, 'Register now')}
    ${safeSignoff ? `<p style="margin:6px 0 0;color:#475569;font-size:14px;">${safeSignoff}</p>` : ''}
  `, { signature: opts.signature });
  return { subject, html };
}

/** Wall post email — sent when the coach checks 'Also email' on a
 *  new wall post. The post's TipTap-emitted HTML is dropped in
 *  verbatim; we just wrap it in the brand chrome. For posts that
 *  carry a poll, the email gets a 'Vote in the poll' button that
 *  deep-links back to the public wall post URL. */
/** Resolve every email address attached to a team: every user
 *  doc with teamId == X OR teamIds array-contains X. Dedupes by
 *  email. Used by sendEmailToTeam below. */
export async function getTeamEmails(teamId: string, excludeUid?: string): Promise<string[]> {
  if (!teamId) return [];
  const emails = new Set<string>();
  try {
    const s1 = await getDocs(query(collection(db, 'users'), where('teamId', '==', teamId)));
    s1.forEach((d) => {
      const u: any = d.data();
      const id = u.uid || d.id;
      if (id && id === excludeUid) return;
      if (u.isActive === false) return;
      if (typeof u.email === 'string' && u.email.includes('@')) emails.add(u.email.toLowerCase());
    });
    const s2 = await getDocs(query(collection(db, 'users'), where('teamIds', 'array-contains', teamId)));
    s2.forEach((d) => {
      const u: any = d.data();
      const id = u.uid || d.id;
      if (id && id === excludeUid) return;
      if (u.isActive === false) return;
      if (typeof u.email === 'string' && u.email.includes('@')) emails.add(u.email.toLowerCase());
    });
  } catch (err) {
    console.warn('[notify] getTeamEmails failed', err);
  }
  return [...emails];
}

/** Send one email per team member. Uses /send-batch so a single
 *  worker call covers the whole roster. Returns the recipient
 *  count actually sent. */
export async function sendEmailToTeam(
  teamId: string,
  template: { subject: string; html: string },
  opts?: { excludeUid?: string; replyTo?: string },
): Promise<number> {
  const emails = await getTeamEmails(teamId, opts?.excludeUid);
  if (emails.length === 0) return 0;
  const messages: NotifyMessage[] = emails.map((to) => ({
    to,
    subject: template.subject,
    html: template.html,
    ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
  }));
  const ok = await sendEmailBatch(messages);
  return ok ? emails.length : 0;
}

export function tplWallPost(opts: {
  teamName: string;
  senderName: string;
  contentHtml: string;
  category?: string | null;
  pollQuestion?: string | null;
  postUrl?: string | null;
  signature?: CoachSignature;
}): { subject: string; html: string } {
  const categoryLabel = (opts.category && opts.category !== 'announcement')
    ? opts.category.replace(/_/g, ' ')
    : 'announcement';
  const subjectPrefix = opts.pollQuestion ? 'New poll' : 'New post';
  const subject = `${subjectPrefix} from ${opts.senderName} — ${opts.teamName}`;
  const safeQuestion = (opts.pollQuestion || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = wrap(`
    <div style="display:inline-block;background:${BRAND_CYAN}1A;color:${BRAND_CYAN_DEEP};font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;padding:4px 10px;border-radius:6px;margin-bottom:12px;">${categoryLabel}</div>
    <h2 style="font-size:20px;margin:0 0 6px;color:${BRAND_NAVY_DARK};font-weight:800;line-height:1.25;">${opts.teamName}</h2>
    <p style="margin:0 0 14px;color:#64748b;font-size:13px;">From ${opts.senderName}</p>
    <div style="margin:0 0 18px;color:#0f172a;font-size:15px;line-height:1.65;">
      ${opts.contentHtml || ''}
    </div>
    ${opts.pollQuestion ? `
      <div style="margin:0 0 18px;padding:16px 18px;background:#f0f9ff;border-left:3px solid ${BRAND_CYAN};border-radius:8px;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND_CYAN_DEEP};">Poll</p>
        <p style="margin:0;color:#0c4a6e;font-size:15px;font-weight:600;line-height:1.4;">${safeQuestion}</p>
      </div>
    ` : ''}
    ${opts.postUrl
      ? button(opts.postUrl, opts.pollQuestion ? 'Vote in the poll' : 'Open the post')
      : button(APP_BASE + '/wall', 'Open Team Wall')}
    <p style="margin:14px 0 0;font-size:12px;color:#94a3b8;">You received this because ${opts.senderName} posted on the ${opts.teamName} Team Wall. Manage your email preferences in the app.</p>
  `, { signature: opts.signature || { name: opts.senderName, role: 'Coach', teamName: opts.teamName } });
  return { subject, html };
}
