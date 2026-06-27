// Branded email verification + password reset sender. Replaces
// Firebase Auth's default flow (which sends from
// noreply@<project>.firebaseapp.com and links to a generic page)
// with our own Resend-powered email that links back to the team
// app's /auth/action route for a branded experience.
//
// Patrick: 'I would love to brand this as well. need also to brand
// the success page and then have a link to open app. also make
// sure nothing says soccer-app-71... looks so unprofessional, and
// that includes where the email is coming from.'
//
// Flow:
//   1. Team app signUp() calls POST /auth/send-verification { email }
//   2. Worker uses Admin SDK to generateEmailVerificationLink with
//      continueUrl pointing at firefc.app/auth/action.
//   3. Worker rewrites the Firebase link's host from
//      <project>.firebaseapp.com to our APP_ORIGIN (so the link in
//      the email matches our brand).
//   4. Worker sends the branded email via Resend.
//   5. User clicks link -> lands on team app's /auth/action page
//      -> applyActionCode runs -> branded success -> 'Open the
//      app' button.

import { getAccessToken } from './fcm';
import { ServiceAccount, parseServiceAccount } from './fcm';

const IDENTITY_TOOLKIT_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface AuthMailEnv {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  FROM_NAME?: string;
  APP_ORIGIN?: string;
}

function getSa(env: AuthMailEnv): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try { return parseServiceAccount(env.FCM_SERVICE_ACCOUNT); } catch { return null; }
}

function projectId(env: AuthMailEnv): string | null {
  if (env.FIREBASE_PROJECT_ID) return env.FIREBASE_PROJECT_ID;
  return getSa(env)?.project_id || null;
}

interface OobCodePayload {
  requestType: 'VERIFY_EMAIL' | 'PASSWORD_RESET';
  email: string;
  continueUrl: string;
  returnOobLink: true;
}

/** Use Firebase's Identity Toolkit REST endpoint (sendOobCode) to
 *  generate the action link without actually triggering Firebase's
 *  built-in email send. We get back the oobCode + the full link we
 *  can drop into our own email. */
async function generateActionLink(
  pid: string,
  sa: ServiceAccount,
  payload: OobCodePayload,
): Promise<string> {
  const token = await getAccessToken(sa, IDENTITY_TOOLKIT_SCOPE);
  const url = `https://identitytoolkit.googleapis.com/v1/projects/${pid}/accounts:sendOobCode`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Identity Toolkit ${r.status}: ${txt.slice(0, 300)}`);
  }
  const j: any = await r.json();
  if (!j.oobLink) throw new Error('No oobLink in response');
  return j.oobLink as string;
}

/** Firebase's generated link uses <project>.firebaseapp.com as the
 *  host. Rewrite it to point at our team app's /auth/action route
 *  so the user never sees the Firebase hostname. The team app's
 *  React route at /auth/action reads the oobCode + mode from the
 *  query string and runs applyActionCode locally. */
function rewriteLinkHost(firebaseLink: string, appOrigin: string): string {
  try {
    const u = new URL(firebaseLink);
    const base = appOrigin.replace(/\/$/, '');
    // Preserve the query string verbatim — Firebase encodes mode,
    // oobCode, apiKey, lang, etc, and the team app's route honors
    // each of those when calling applyActionCode.
    return `${base}/auth/action${u.search}`;
  } catch {
    return firebaseLink;
  }
}

function brandedHtml(opts: {
  kind: 'verify' | 'reset';
  link: string;
  appOrigin: string;
}): { subject: string; html: string } {
  const isVerify = opts.kind === 'verify';
  const subject = isVerify
    ? 'Verify your email for GoalKickr'
    : 'Reset your GoalKickr password';
  const heading = isVerify ? 'Verify your email' : 'Reset your password';
  const body = isVerify
    ? `<p>Confirm this is you so your coach can reach you and your team chat keeps working.</p>`
    : `<p>Click the button below to set a new password. The link expires in one hour.</p>`;
  const cta = isVerify ? 'Verify email' : 'Reset password';
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>GoalKickr</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,system-ui,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f6f8;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <tr><td style="padding:28px 28px 12px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:2px;color:#dc2626;text-transform:uppercase;">GoalKickr</div>
          <h2 style="font-size:22px;margin:8px 0 14px;color:#0f172a;font-weight:800;">${heading}</h2>
        </td></tr>
        <tr><td style="padding:0 28px 16px;font-size:15px;line-height:1.6;color:#0f172a;">
          ${body}
        </td></tr>
        <tr><td style="padding:8px 28px 28px;">
          <a href="${opts.link}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;">${cta}</a>
          <p style="margin:18px 0 0;font-size:12px;color:#64748b;">If the button doesn't work, copy and paste this link into your browser:<br><span style="color:#475569;word-break:break-all;">${opts.link}</span></p>
        </td></tr>
        <tr><td style="padding:18px 28px 24px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;">
          Didn't request this? You can safely ignore this email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, html };
}

async function sendViaResend(env: AuthMailEnv, to: string, template: { subject: string; html: string }): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: `${env.FROM_NAME || 'GoalKickr'} <${env.FROM_EMAIL || 'noreply@goalkickr.com'}>`,
      to,
      subject: template.subject,
      html: template.html,
    }),
  });
  if (!r.ok) {
    console.error('[authMail] resend send failed', r.status, (await r.text()).slice(0, 300));
    return false;
  }
  return true;
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Anonymous endpoint — the caller is the team app's signup flow,
 *  which doesn't have an auth token yet (user just created). The
 *  worst-case abuse is someone triggering verification emails to
 *  arbitrary addresses — but Firebase Auth itself rate-limits the
 *  oob-code generation per project, so the blast radius is bounded.
 *  Pre-flight the email shape to drop obvious junk. */
export async function handleSendVerification(request: Request, env: AuthMailEnv): Promise<Response> {
  let body: any = {};
  try { body = await request.json(); } catch { return json({ error: 'bad-json' }, 400); }
  const email = String(body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 200) {
    return json({ error: 'bad-email' }, 400);
  }

  const pid = projectId(env);
  const sa = getSa(env);
  if (!pid || !sa) return json({ error: 'firestore-not-configured' }, 503);
  const appOrigin = env.APP_ORIGIN || 'https://firefc.app';

  try {
    const firebaseLink = await generateActionLink(pid, sa, {
      requestType: 'VERIFY_EMAIL',
      email,
      continueUrl: appOrigin,
      returnOobLink: true,
    });
    const brandedLink = rewriteLinkHost(firebaseLink, appOrigin);
    const tpl = brandedHtml({ kind: 'verify', link: brandedLink, appOrigin });
    const ok = await sendViaResend(env, email, tpl);
    return json({ ok });
  } catch (e: any) {
    console.error('[authMail] verification send failed', (e as Error).message);
    // EMAIL_NOT_FOUND from identity-toolkit means we tried to send a
    // verification to an account that doesn't exist — treat as
    // benign success so the client UX doesn't reveal account state.
    if (String(e?.message || '').includes('EMAIL_NOT_FOUND')) {
      return json({ ok: true });
    }
    return json({ error: 'send-failed', detail: String(e?.message || '').slice(0, 200) }, 500);
  }
}
