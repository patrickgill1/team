// Email-on-player precheck for the signup lockdown gate.
//
// Why this exists: SimpleAuth blocks signups that don't have
// EITHER an invite code OR an email already listed on some
// player.parentEmails (a coach pre-added them). The check used to
// query Firestore directly from the client, but `players` list
// requires auth — and the user isn't authenticated yet during
// signup. Firestore returned permission-denied and the UI showed
// 'Something went wrong on our end.'
//
// This endpoint runs the same query on the worker side (with the
// service account, no auth required) and returns just a boolean
// so the client can show the right error copy.
//
// Anonymous endpoint. Safe because: returns only a boolean, never
// any player data; rate-limited at the Cloudflare edge; lookup is
// a single .array-contains query against an already-indexed field.

import { runQuery } from './firestore';
import { ServiceAccount, parseServiceAccount } from './fcm';

export interface PrecheckEnv {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
}

function getSa(env: PrecheckEnv): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try { return parseServiceAccount(env.FCM_SERVICE_ACCOUNT); } catch { return null; }
}

function projectId(env: PrecheckEnv): string | null {
  if (env.FIREBASE_PROJECT_ID) return env.FIREBASE_PROJECT_ID;
  return getSa(env)?.project_id || null;
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function handleParentEmailPrecheck(request: Request, env: PrecheckEnv): Promise<Response> {
  let payload: any = {};
  try { payload = await request.json(); } catch { return json({ ok: false, error: 'bad-json' }, 400); }
  const raw = String(payload?.email || '').trim().toLowerCase();
  if (!raw || !raw.includes('@') || raw.length > 200) {
    return json({ ok: false, error: 'bad-email' }, 400);
  }

  const pid = projectId(env);
  const sa = getSa(env);
  if (!pid || !sa) return json({ ok: false, error: 'firestore-not-configured' }, 503);

  try {
    const rows = await runQuery(
      pid,
      'players',
      [{ field: 'parentEmails', op: 'ARRAY_CONTAINS', value: raw }],
      sa,
      1,
    );
    return json({ ok: true, hasPlayer: (rows?.length || 0) > 0 });
  } catch (e) {
    console.error('[precheck] failed:', (e as Error).message);
    // Fail OPEN on infra hiccups — better to let signup proceed
    // than block on a transient query failure. Server logs it.
    return json({ ok: true, hasPlayer: true, soft: true });
  }
}
