/**
 * Registration funnel drip emails. Fired by the daily cron in
 * worker/src/index.ts. Three buckets:
 *
 *   1. Account-but-no-registration  → 24h after user signup, no
 *      Registration on file under their email. Nudge to finish.
 *   2. Registration-but-unpaid       → 48h after pending_payment
 *      registration was submitted, still pending. Reminder with the
 *      payment link.
 *   3. Offer-expiring                → 48h before an offer's
 *      expiresAt with no response yet. Nudge to accept.
 *
 * Each touch writes `lastDripSentAt` + `lastDripKind` on the target
 * doc so we don't re-spam. Each send also logs an `email_sent`
 * activity (channel: 'drip_X') for the CRM timeline.
 *
 * Tuning: send max 1 drip per user per day. The cadence cron runs
 * once daily so this is naturally bounded.
 */

import { ServiceAccount } from './fcm';
import {
  createDocument,
  getDocument,
  listDocuments,
  patchDocument,
  runQuery,
} from './firestore';

interface DripEnv {
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

interface SendOne {
  to: string;
  subject: string;
  html: string;
}

const DAY = 24 * 60 * 60 * 1000;

export async function runRegistrationDrips(env: DripEnv): Promise<{ ok: boolean; counts: Record<string, number>; errors: string[] }> {
  const errors: string[] = [];
  const counts = { accountNoReg: 0, unpaid: 0, offerExpiring: 0 };

  if (!env.FCM_SERVICE_ACCOUNT) return { ok: false, counts, errors: ['no-service-account'] };
  const { parseServiceAccount } = await import('./fcm');
  let sa: ServiceAccount;
  try { sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT); } catch { return { ok: false, counts, errors: ['invalid-service-account'] }; }
  const projectId = env.FIREBASE_PROJECT_ID || sa.project_id;
  if (!projectId) return { ok: false, counts, errors: ['no-project-id'] };

  const now = Date.now();

  // ── Drip 1: account-but-no-registration ───────────────────────
  // Users who signed up 24-72h ago and have no Registration matching
  // their email. (We bound the upper end so we don't spam old accounts
  // every day forever.)
  try {
    const users = await listDocuments(projectId, 'users', sa, 500);
    for (const u of users) {
      const email = String(u.data?.email || '').toLowerCase().trim();
      if (!email) continue;
      const createdAt = toMs(u.data?.createdAt);
      const ageHrs = (now - createdAt) / (60 * 60 * 1000);
      if (ageHrs < 24 || ageHrs > 72) continue;
      // Skip users who've already been dripped for this stage.
      if (u.data?.lastDripKind === 'incomplete_registration') continue;
      // Skip if a registration exists.
      const regs = await runQuery(projectId, 'registrations', [
        { field: 'parentEmail', op: 'EQUAL', value: email },
      ], sa, 1).catch(() => []);
      const hasReg = regs.length > 0 || await hasRegistrationByEmail(projectId, email, sa);
      if (hasReg) continue;
      // Send + record.
      const ok = await sendDripEmail(env, {
        to: email,
        subject: 'You started — finish your Fire FC registration',
        html: incompleteRegistrationHtml(env, u.data?.name || email.split('@')[0]),
      });
      if (ok) {
        counts.accountNoReg++;
        await patchDocument(projectId, `users/${u.id}`, {
          lastDripSentAt: new Date(),
          lastDripKind: 'incomplete_registration',
        }, sa).catch(() => {});
        await logDripActivity(projectId, sa, {
          clubId: u.data?.clubId,
          parentEmail: email,
          channel: 'drip_incomplete_registration',
          subject: 'You started — finish your Fire FC registration',
        });
      }
    }
  } catch (err: any) {
    errors.push(`accountNoReg: ${err?.message || err}`);
  }

  // ── Drip 2: registration-but-unpaid ───────────────────────────
  try {
    const regs = await runQuery(projectId, 'registrations', [
      { field: 'status', op: 'EQUAL', value: 'pending_payment' },
    ], sa, 500);
    for (const r of regs) {
      const createdAt = toMs(r.data?.createdAt);
      const ageHrs = (now - createdAt) / (60 * 60 * 1000);
      if (ageHrs < 48 || ageHrs > 168) continue; // 2-7 days old
      if (r.data?.lastDripKind === 'unpaid_reminder') continue;
      const email = String(r.data?.parents?.[0]?.email || '').toLowerCase().trim();
      if (!email) continue;
      const playerName = `${r.data?.player?.firstName || ''} ${r.data?.player?.lastName || ''}`.trim() || 'your player';
      const ok = await sendDripEmail(env, {
        to: email,
        subject: `Quick reminder — finish ${playerName}'s registration`,
        html: unpaidReminderHtml(env, playerName, r.id),
      });
      if (ok) {
        counts.unpaid++;
        await patchDocument(projectId, `registrations/${r.id}`, {
          lastDripSentAt: new Date(),
          lastDripKind: 'unpaid_reminder',
        }, sa).catch(() => {});
        await logDripActivity(projectId, sa, {
          clubId: r.data?.clubId,
          registrationId: r.id,
          parentEmail: email,
          channel: 'drip_unpaid_reminder',
          subject: `Quick reminder — finish ${playerName}'s registration`,
        });
      }
    }
  } catch (err: any) {
    errors.push(`unpaid: ${err?.message || err}`);
  }

  // ── Drip 3: offer-expiring ────────────────────────────────────
  try {
    const offers = await runQuery(projectId, 'offers', [
      { field: 'status', op: 'EQUAL', value: 'sent' },
    ], sa, 500);
    for (const o of offers) {
      const exp = toMs(o.data?.expiresAt);
      if (!exp) continue;
      const hoursLeft = (exp - now) / (60 * 60 * 1000);
      // 24-60h before expiry — send once.
      if (hoursLeft < 24 || hoursLeft > 60) continue;
      if (o.data?.lastDripKind === 'offer_expiring') continue;
      const email = String(o.data?.parentEmail || '').toLowerCase().trim();
      if (!email) continue;
      const ok = await sendDripEmail(env, {
        to: email,
        subject: `Your ${o.data?.teamName || 'team'} offer expires soon`,
        html: offerExpiringHtml(env, o.id, o.data?.playerName || 'your player', o.data?.teamName || 'the team', hoursLeft),
      });
      if (ok) {
        counts.offerExpiring++;
        await patchDocument(projectId, `offers/${o.id}`, {
          lastDripSentAt: new Date(),
          lastDripKind: 'offer_expiring',
        }, sa).catch(() => {});
        await logDripActivity(projectId, sa, {
          clubId: o.data?.clubId,
          registrationId: o.data?.registrationId,
          parentEmail: email,
          channel: 'drip_offer_expiring',
          subject: `Your ${o.data?.teamName || 'team'} offer expires soon`,
        });
      }
    }
  } catch (err: any) {
    errors.push(`offerExpiring: ${err?.message || err}`);
  }

  return { ok: errors.length === 0, counts, errors };
}

// ── Send + log helpers ────────────────────────────────────────

async function sendDripEmail(env: DripEnv, msg: SendOne): Promise<boolean> {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function logDripActivity(projectId: string, sa: ServiceAccount, opts: {
  clubId?: string;
  registrationId?: string;
  parentEmail?: string;
  channel: string;
  subject: string;
}) {
  if (!opts.clubId) return;
  try {
    await createDocument(projectId, 'activities', {
      clubId: opts.clubId,
      kind: 'email_sent',
      registrationId: opts.registrationId,
      parentEmail: opts.parentEmail,
      actorUid: 'system',
      actorName: 'Drip',
      payload: { subject: opts.subject, channel: opts.channel },
      createdAt: new Date(),
    }, sa);
  } catch {/* ignore */}
}

async function hasRegistrationByEmail(projectId: string, email: string, sa: ServiceAccount): Promise<boolean> {
  // Fallback when there's no top-level parentEmail field on the
  // registration — scan recent registrations and match by parents[].email.
  try {
    const regs = await listDocuments(projectId, 'registrations', sa, 200);
    return regs.some(r => Array.isArray(r.data?.parents) && r.data.parents.some((p: any) => String(p?.email || '').toLowerCase() === email));
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

// ── Email templates (inline; same brand language as notify.ts) ─

const NAVY = '#0f172a';
const CYAN = '#06b6d4';

function wrap(inner: string): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#f0f9ff;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
      <div style="background:${NAVY};padding:20px;text-align:center;border-bottom:3px solid ${CYAN};">
        <div style="color:#fff;font-weight:900;letter-spacing:2.5px;font-size:16px;text-transform:uppercase;">Fire FC</div>
      </div>
      <div style="padding:24px;color:${NAVY};line-height:1.6;font-size:15px;">${inner}</div>
    </div>
  </div>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:16px 0;"><a href="${href}" style="display:inline-block;background:${CYAN};color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;">${label}</a></p>`;
}

function incompleteRegistrationHtml(env: DripEnv, name: string): string {
  return wrap(`
    <h2 style="margin:0 0 12px;font-size:22px;color:${NAVY};">Hey ${name}, you're almost there!</h2>
    <p style="margin:0 0 12px;color:#475569;">You started your Fire FC account but haven't finished registering your player yet. Takes about 90 seconds — and once you're in the pool, your coach can reach out.</p>
    ${button(`${env.APP_ORIGIN}/register`, 'Finish registering')}
    <p style="margin:0;font-size:13px;color:#94a3b8;">Questions? Just reply to this email.</p>
  `);
}

function unpaidReminderHtml(env: DripEnv, playerName: string, registrationId: string): string {
  return wrap(`
    <h2 style="margin:0 0 12px;font-size:22px;color:${NAVY};">${playerName}'s spot is reserved</h2>
    <p style="margin:0 0 12px;color:#475569;">We've got ${playerName}'s registration on file, but payment hasn't come through yet. Wrap it up so they're in the pool for tryouts:</p>
    ${button(`${env.APP_ORIGIN}/register?registration=${registrationId}`, 'Complete payment')}
    <p style="margin:0;font-size:13px;color:#94a3b8;">If you've already paid in person or by check, ignore this — your club admin will mark it on their end.</p>
  `);
}

function offerExpiringHtml(env: DripEnv, offerId: string, playerName: string, teamName: string, hoursLeft: number): string {
  const hrs = Math.max(1, Math.round(hoursLeft));
  return wrap(`
    <h2 style="margin:0 0 12px;font-size:22px;color:${NAVY};">${teamName} is still holding ${playerName}'s spot</h2>
    <p style="margin:0 0 12px;color:#475569;">Your offer expires in about <b>${hrs} hour${hrs === 1 ? '' : 's'}</b>. Tap below to accept or decline:</p>
    ${button(`${env.APP_ORIGIN}/offer/${offerId}`, 'Open offer')}
    <p style="margin:0;font-size:13px;color:#94a3b8;">Questions? Reply to this email and we'll loop in your coach.</p>
  `);
}
