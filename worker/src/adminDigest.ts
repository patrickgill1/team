/**
 * Weekly admin roundup — fires off the same Sunday-night cron as the
 * parent digest but targets club admins with operational signal:
 *
 *   - Candidates in the tryout pool 3+ days with NO favorites + NO
 *     hold + NO offer (the "slipping through the cracks" list).
 *   - Registrations in pending_payment 7+ days (unpaid stragglers).
 *   - Offers still pending response with <72h until expiry.
 *
 * Sent to every user with isClubAdmin: true in the matching club.
 */

import { ServiceAccount, parseServiceAccount } from './fcm';
import { listDocuments, runQuery } from './firestore';

interface DigestEnv {
  // Legacy — retained for source-level compatibility; not read at
  // runtime here.
  NOTIFY_SECRET?: string;
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  APP_ORIGIN: string;
  FCM_SERVICE_ACCOUNT?: string;
  FIREBASE_PROJECT_ID?: string;
}

const DAY = 24 * 60 * 60 * 1000;

interface UnengagedCandidate {
  registrationId: string;
  playerName: string;
  ageGroup?: string;
  daysInPool: number;
  status: string;
}

interface UnpaidStraggler {
  registrationId: string;
  playerName: string;
  parentEmail: string;
  daysOld: number;
  amountCents: number;
}

interface ExpiringOffer {
  offerId: string;
  playerName: string;
  teamName: string;
  hoursLeft: number;
}

export async function runAdminWeeklyRoundup(env: DigestEnv): Promise<{ ok: boolean; clubs: number; admins: number; errors: string[] }> {
  const errors: string[] = [];
  let clubs = 0;
  let admins = 0;
  if (!env.FCM_SERVICE_ACCOUNT) return { ok: false, clubs, admins, errors: ['no-service-account'] };
  let sa: ServiceAccount;
  try { sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT); } catch { return { ok: false, clubs, admins, errors: ['invalid-service-account'] }; }
  const projectId = env.FIREBASE_PROJECT_ID || sa.project_id;
  if (!projectId) return { ok: false, clubs, admins, errors: ['no-project-id'] };

  const now = Date.now();

  // Pull all clubs once. Per-club then computes the digest sections.
  let clubDocs;
  try {
    clubDocs = await listDocuments(projectId, 'clubs', sa, 500);
  } catch (err: any) {
    return { ok: false, clubs: 0, admins: 0, errors: [String(err?.message || err)] };
  }

  for (const club of clubDocs) {
    const clubId = club.id;
    const clubName = club.data?.name || 'Your club';

    // Gather sections.
    const unengaged: UnengagedCandidate[] = [];
    const unpaid: UnpaidStraggler[] = [];
    const expiring: ExpiringOffer[] = [];

    try {
      const regs = await runQuery(projectId, 'registrations', [
        { field: 'clubId', op: 'EQUAL', value: clubId },
      ], sa, 1000);

      for (const r of regs) {
        const status = r.data?.status;
        const createdAt = toMs(r.data?.createdAt);
        const ageDays = (now - createdAt) / DAY;
        const playerName = `${r.data?.player?.firstName || ''} ${r.data?.player?.lastName || ''}`.trim() || 'Unknown';

        // Unengaged: 3+ days in pool, no favorites, no hold, not in a
        // terminal state.
        const anyFavorite = Object.values(r.data?.coachStates || {}).some((s: any) => s?.favorite);
        const isHeld = !!r.data?.heldByUid;
        const terminal = ['offer_sent', 'accepted', 'declined', 'withdrawn'].includes(status);
        if (ageDays > 3 && !anyFavorite && !isHeld && !terminal) {
          unengaged.push({
            registrationId: r.id,
            playerName,
            ageGroup: r.data?.player?.ageGroup,
            daysInPool: Math.floor(ageDays),
            status,
          });
        }

        // Unpaid stragglers: pending_payment 7+ days.
        if (status === 'pending_payment' && ageDays > 7) {
          unpaid.push({
            registrationId: r.id,
            playerName,
            parentEmail: String(r.data?.parents?.[0]?.email || '').toLowerCase(),
            daysOld: Math.floor(ageDays),
            amountCents: Number(r.data?.amountPaidCents || r.data?.registrationFeeCents || 0),
          });
        }
      }
    } catch (err: any) {
      errors.push(`club ${clubId} regs: ${err?.message || err}`);
    }

    try {
      const offers = await runQuery(projectId, 'offers', [
        { field: 'clubId', op: 'EQUAL', value: clubId },
        { field: 'status', op: 'EQUAL', value: 'sent' },
      ], sa, 500);
      for (const o of offers) {
        const exp = toMs(o.data?.expiresAt);
        if (!exp) continue;
        const hoursLeft = (exp - now) / (60 * 60 * 1000);
        if (hoursLeft > 0 && hoursLeft <= 72) {
          expiring.push({
            offerId: o.id,
            playerName: o.data?.playerName || 'Unknown',
            teamName: o.data?.teamName || 'A team',
            hoursLeft: Math.floor(hoursLeft),
          });
        }
      }
    } catch (err: any) {
      errors.push(`club ${clubId} offers: ${err?.message || err}`);
    }

    // Skip if there's nothing to say.
    if (unengaged.length === 0 && unpaid.length === 0 && expiring.length === 0) continue;

    // Send to every club admin.
    let admins_in_club;
    try {
      admins_in_club = await runQuery(projectId, 'users', [
        { field: 'isClubAdmin', op: 'EQUAL', value: true },
      ], sa, 200);
    } catch (err: any) {
      errors.push(`club ${clubId} admins: ${err?.message || err}`);
      continue;
    }

    const html = buildHtml(env, clubName, unengaged, unpaid, expiring);
    const subject = `${clubName} — ${unengaged.length + unpaid.length + expiring.length} items need attention`;

    for (const u of admins_in_club) {
      const email = String(u.data?.email || '').trim();
      if (!email) continue;
      const ok = await sendOne(env, email, subject, html);
      if (ok) admins++;
    }
    clubs++;
  }

  return { ok: errors.length === 0, clubs, admins, errors };
}

async function sendOne(env: DigestEnv, to: string, subject: string, html: string): Promise<boolean> {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
        to: [to],
        subject,
        html,
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function toMs(v: any): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'number') return v;
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  const n = Date.parse(String(v));
  return isNaN(n) ? 0 : n;
}

// ── HTML ──────────────────────────────────────────────────────

const NAVY = '#0f172a';
const CYAN = '#06b6d4';
const AMBER = '#f59e0b';
const ROSE = '#f43f5e';

function buildHtml(env: DigestEnv, clubName: string, unengaged: UnengagedCandidate[], unpaid: UnpaidStraggler[], expiring: ExpiringOffer[]): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#f0f9ff;padding:24px;">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
      <div style="background:${NAVY};padding:20px;text-align:center;border-bottom:3px solid ${CYAN};">
        <div style="color:#fff;font-weight:900;letter-spacing:2.5px;font-size:16px;text-transform:uppercase;">${clubName} · Admin Roundup</div>
      </div>
      <div style="padding:24px;color:${NAVY};line-height:1.6;font-size:14px;">
        <p style="margin:0 0 18px;color:#475569;">Weekly snapshot of items that need an admin or coach to do something. Tap any link to open the full view.</p>

        ${section(env, 'Candidates needing attention', `${unengaged.length} candidate${unengaged.length === 1 ? '' : 's'} have been in the pool 3+ days with no favorites and no offer.`, unengaged.map(c => `
          <li style="padding:8px 0;border-bottom:1px solid #f1f5f9;">
            <a href="${env.APP_ORIGIN}/club/person/${c.registrationId}" style="color:${NAVY};text-decoration:none;font-weight:700;">${c.playerName}</a>
            <div style="font-size:12px;color:#64748b;">${c.ageGroup || '?'} · ${c.daysInPool} days in pool · status: ${c.status}</div>
          </li>`).join(''), `${env.APP_ORIGIN}/club/tryouts`, 'Open Tryouts', AMBER)}

        ${section(env, 'Unpaid stragglers', `${unpaid.length} registration${unpaid.length === 1 ? '' : 's'} have been pending payment for 7+ days.`, unpaid.map(u => `
          <li style="padding:8px 0;border-bottom:1px solid #f1f5f9;">
            <span style="font-weight:700;">${u.playerName}</span>
            <div style="font-size:12px;color:#64748b;">${u.parentEmail} · ${u.daysOld} days · $${(u.amountCents / 100).toFixed(2)}</div>
          </li>`).join(''), `${env.APP_ORIGIN}/club/registrations`, 'Open Registrations', ROSE)}

        ${section(env, 'Offers expiring soon', `${expiring.length} offer${expiring.length === 1 ? '' : 's'} expire in the next 72 hours.`, expiring.map(o => `
          <li style="padding:8px 0;border-bottom:1px solid #f1f5f9;">
            <span style="font-weight:700;">${o.playerName}</span> <span style="color:#64748b;">→ ${o.teamName}</span>
            <div style="font-size:12px;color:#64748b;">~${o.hoursLeft}h remaining</div>
          </li>`).join(''), `${env.APP_ORIGIN}/club/tryouts`, 'Open Tryouts', CYAN)}

        <p style="margin:24px 0 0;font-size:11px;color:#94a3b8;text-align:center;">You're receiving this because you're a club admin. Mute under Settings → Notification preferences (coming soon).</p>
      </div>
    </div>
  </div>`;
}

function section(_env: DigestEnv, title: string, summary: string, items: string, linkHref: string, linkLabel: string, accent: string): string {
  if (!items.trim()) return '';
  return `<div style="margin:0 0 22px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <div style="width:8px;height:8px;border-radius:50%;background:${accent};"></div>
      <h3 style="margin:0;font-size:14px;color:${NAVY};font-weight:800;letter-spacing:0.3px;text-transform:uppercase;">${title}</h3>
    </div>
    <p style="margin:0 0 8px;color:#475569;font-size:13px;">${summary}</p>
    <ul style="list-style:none;padding:0;margin:0;border-top:1px solid #f1f5f9;">${items}</ul>
    <p style="margin:8px 0 0;"><a href="${linkHref}" style="color:${CYAN};font-weight:700;text-decoration:none;font-size:13px;">${linkLabel} →</a></p>
  </div>`;
}
