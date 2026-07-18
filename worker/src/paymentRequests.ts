/**
 * Team payment_requests — coach-owned collection of one-off, recurring,
 * and catalog payments. Orthogonal to /events feeCents drop-in path.
 *
 * All writes go through /payments/* worker endpoints so:
 *   - Only coach-of-team can create / close / mark-cash
 *   - Personal-club fallback auto-fires for standalone coaches
 *   - clubId is snapshotted at create time (mid-flight team re-parenting
 *     can't reroute funds)
 *   - paidUids / stripeSubscriptionIds / purchases[] can only be
 *     written by the Stripe webhook (never parents directly)
 *
 * This file owns the CRUD handlers (create, close, mark-paid-cash) and
 * the fanout pushes. Stripe checkout / subscription / refund handlers
 * live in worker/src/stripe.ts to reuse the shared stripeRequest +
 * form encoders. Both sides share the id conventions and metadata
 * shape documented on handleCreatePaymentRequest below.
 */

import {
  requireCoachOfTeam,
  requireUser,
  AuthError,
} from './auth';
import { parseServiceAccount, ServiceAccount } from './fcm';
import {
  getDocument,
  patchDocument,
  createDocument,
  commitDocumentTransforms,
  AlreadyExistsError,
} from './firestore';
import { intervalLabel, type PaymentRecurringInterval } from './paymentIntervals';

interface Env {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
  APP_ORIGIN?: string;
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

// Resolve a clubId for a payment_request. If the team already has one,
// snapshot it. Otherwise auto-create a personal club at
// clubs/personal_{coachUid} the same way /events feeCents does. Copies
// the logic from writeGuards.handleClubsPersonalCreateIfMissing but
// keeps it self-contained so this module has one round-trip signature.
async function ensureClubForTeam(
  pid: string,
  sa: ServiceAccount,
  teamId: string,
  coachUid: string,
  coachEmail: string | null,
): Promise<{ clubId: string; created: boolean }> {
  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  if (!team?.data) throw new AuthError('team_not_found', 404);
  const existing = String(team.data.clubId || '');
  if (existing) return { clubId: existing, created: false };

  const clubId = `personal_${coachUid}`;
  const user = await getDocument(pid, `users/${coachUid}`, sa).catch(() => null);
  const coachName = String(user?.data?.name || coachEmail?.split('@')[0] || 'My').trim() || 'My';
  try {
    await createDocument(pid, 'clubs', {
      name: `${coachName}'s Team`,
      ownerUid: coachUid,
      adminUids: [],
      teamIds: [teamId],
      isActive: true,
      isDefaultSoloClub: true,
      createdAt: new Date(),
      createdBy: coachUid,
    }, sa, clubId);
  } catch (err) {
    if (!(err instanceof AlreadyExistsError)) throw err;
  }
  await patchDocument(pid, `teams/${teamId}`, { clubId }, sa);
  try {
    await commitDocumentTransforms(
      pid,
      `users/${coachUid}`,
      [{ fieldPath: 'clubIds', kind: 'arrayUnion', value: clubId }],
      null,
      sa,
    );
  } catch (err) {
    console.warn('[payments] personal-club user.clubIds arrayUnion failed', err);
  }
  return { clubId, created: true };
}

// ────────────────────────────────────────────────────────────────
// POST /payments/create
// Body: {
//   teamId, kind: 'one_off'|'recurring'|'catalog',
//   title, description?, feeCoveredBy?: 'player'|'coach',
//   targetPlayerIds?: 'all'|string[], dueDate?: iso,
//   // one_off: feeCents
//   // recurring: intervalCents, interval: 'week'|'month'|'season'|'year'
//   // catalog: items: CatalogItem[]
// }
// Returns { ok, id, clubId }
// ────────────────────────────────────────────────────────────────
export async function handleCreatePaymentRequest(
  req: Request,
  env: Env,
  payload: any,
): Promise<Response> {
  const teamId = String(payload?.teamId || '').trim();
  if (!teamId) return json({ ok: false, error: 'team_id_required' }, 400);
  const kind = String(payload?.kind || '');
  if (!['one_off', 'recurring', 'catalog'].includes(kind)) {
    return json({ ok: false, error: 'invalid_kind' }, 400);
  }
  const title = String(payload?.title || '').trim().slice(0, 120);
  if (!title) return json({ ok: false, error: 'title_required' }, 400);

  const claims = await requireCoachOfTeam(req, env, teamId);
  const { pid, sa } = projectAndSA(env);

  const { clubId } = await ensureClubForTeam(pid, sa, teamId, claims.uid, claims.email || null);

  // Guard: the request is worthless if the club can't accept charges.
  // Verifier flagged a standalone-coach dead-end where the request was
  // created but every parent hit `club-not-stripe-ready` at checkout.
  // Fail fast so the create UI surfaces the "connect Stripe first" hint
  // instead of shipping a broken payment to families.
  const clubDoc = await getDocument(pid, `clubs/${clubId}`, sa).catch(() => null);
  const stripeAccountId = String(clubDoc?.data?.stripeAccountId || '');
  const chargesEnabled = clubDoc?.data?.stripeChargesEnabled === true;
  if (!stripeAccountId || !chargesEnabled) {
    return json({
      ok: false,
      error: 'club-not-stripe-ready',
      hint: 'Connect Stripe from Team HQ first so families can actually pay.',
    }, 409);
  }

  const feeCoveredBy: 'player' | 'coach' =
    payload?.feeCoveredBy === 'coach' ? 'coach' : 'player';
  const description = payload?.description ? String(payload.description).slice(0, 2000) : undefined;
  const targetsRaw = payload?.targetPlayerIds;
  const targetPlayerIds: 'all' | string[] =
    targetsRaw === 'all' || targetsRaw == null
      ? 'all'
      : Array.isArray(targetsRaw)
        ? targetsRaw.filter((s: unknown) => typeof s === 'string').slice(0, 200)
        : 'all';
  const dueDate = payload?.dueDate ? new Date(payload.dueDate) : null;
  const user = await getDocument(pid, `users/${claims.uid}`, sa).catch(() => null);
  const createdByName = String(user?.data?.name || claims.email?.split('@')[0] || 'Coach').slice(0, 80);

  const base: Record<string, any> = {
    teamId,
    clubId,
    createdBy: claims.uid,
    createdByName,
    createdAt: new Date(),
    updatedAt: new Date(),
    isActive: true,
    title,
    kind,
    feeCoveredBy,
    status: 'active',
    targetPlayerIds,
  };
  if (description) base.description = description;
  if (dueDate && !isNaN(dueDate.getTime())) base.dueDate = dueDate;

  if (kind === 'one_off') {
    const feeCents = Number(payload?.feeCents || 0);
    if (feeCents <= 0) return json({ ok: false, error: 'fee_required' }, 400);
    if (feeCoveredBy === 'player' && feeCents < 100) {
      return json({ ok: false, error: 'fee_min_100', hint: 'Below $1.00 the gross-up ratio gets ugly.' }, 400);
    }
    base.feeCents = Math.round(feeCents);
    base.paidUids = [];
    base.paidByCoach = [];
    base.paidByCoachPlayerIds = [];
  } else if (kind === 'recurring') {
    const intervalCents = Number(payload?.intervalCents || 0);
    const interval = String(payload?.interval || '') as PaymentRecurringInterval;
    if (intervalCents <= 0) return json({ ok: false, error: 'interval_cents_required' }, 400);
    if (!['week', 'month', 'season', 'year'].includes(interval)) {
      return json({ ok: false, error: 'invalid_interval' }, 400);
    }
    if (feeCoveredBy === 'player' && intervalCents < 100) {
      return json({ ok: false, error: 'interval_min_100' }, 400);
    }
    base.intervalCents = Math.round(intervalCents);
    base.interval = interval;
    base.stripeSubscriptionIds = {};
    base.cancelledUids = [];
    base.paidByCoach = [];
    base.paidByCoachPlayerIds = [];
  } else {
    // catalog
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    if (rawItems.length === 0) return json({ ok: false, error: 'items_required' }, 400);
    const items = rawItems.slice(0, 100).map((raw: any, idx: number) => {
      const priceCents = Math.max(0, Math.round(Number(raw?.priceCents || 0)));
      return {
        id: String(raw?.id || `item_${Date.now()}_${idx}`),
        name: String(raw?.name || 'Item').slice(0, 100),
        priceCents,
        description: raw?.description ? String(raw.description).slice(0, 500) : undefined,
        imageUrl: raw?.imageUrl ? String(raw.imageUrl).slice(0, 500) : undefined,
        maxPerPlayer: raw?.maxPerPlayer != null ? Math.max(1, Math.round(Number(raw.maxPerPlayer))) : undefined,
        isActive: raw?.isActive !== false,
      };
    }).filter((i: any) => i.priceCents > 0);
    if (items.length === 0) return json({ ok: false, error: 'items_priced_required' }, 400);
    base.items = items;
    base.purchases = [];
  }

  const id = await createDocument(pid, 'payment_requests', base, sa);

  // Fire-and-forget push to targeted parents.
  try {
    await sendCreationPush(pid, sa, env, { ...base, id }, teamId);
    await patchDocument(pid, `payment_requests/${id}`, { notifiedAt: new Date() }, sa);
  } catch (err) {
    console.warn('[payments] creation push failed', err);
  }

  return json({ ok: true, id, clubId });
}

// ────────────────────────────────────────────────────────────────
// POST /payments/close
// Body: { paymentRequestId, archive?: boolean }
// Coach-only. isActive: false + status. Does NOT cancel live Stripe
// subs — coach has to cancel each subscriber separately (or use the
// dedicated subscription-cancel endpoint) so the intent is explicit.
// ────────────────────────────────────────────────────────────────
export async function handleClosePaymentRequest(
  req: Request,
  env: Env,
  payload: any,
): Promise<Response> {
  const id = String(payload?.paymentRequestId || '').trim();
  if (!id) return json({ ok: false, error: 'payment_request_id_required' }, 400);
  const archive = payload?.archive === true;
  const { pid, sa } = projectAndSA(env);
  const doc = await getDocument(pid, `payment_requests/${id}`, sa).catch(() => null);
  if (!doc?.data) return json({ ok: false, error: 'not_found' }, 404);
  await requireCoachOfTeam(req, env, String(doc.data.teamId || ''));
  await patchDocument(pid, `payment_requests/${id}`, {
    status: archive ? 'archived' : 'closed',
    isActive: false,
    updatedAt: new Date(),
  }, sa);
  return json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
// POST /payments/mark-paid-cash
// Body: { paymentRequestId, uid?, playerId?, paid: boolean }
// Coach-only. Mirrors /events/mark-paid — for recurring, snapshots
// the CURRENT period only. Documented in coach confirmation copy.
// ────────────────────────────────────────────────────────────────
export async function handlePaymentMarkPaidCash(
  req: Request,
  env: Env,
  payload: any,
): Promise<Response> {
  const id = String(payload?.paymentRequestId || '').trim();
  const uid = payload?.uid ? String(payload.uid) : '';
  const playerId = payload?.playerId ? String(payload.playerId) : '';
  const paid = payload?.paid !== false;
  if (!id) return json({ ok: false, error: 'payment_request_id_required' }, 400);
  if (!uid && !playerId) return json({ ok: false, error: 'uid_or_player_required' }, 400);
  const { pid, sa } = projectAndSA(env);
  const doc = await getDocument(pid, `payment_requests/${id}`, sa).catch(() => null);
  if (!doc?.data) return json({ ok: false, error: 'not_found' }, 404);
  await requireCoachOfTeam(req, env, String(doc.data.teamId || ''));

  const transforms: Array<{ fieldPath: string; kind: 'arrayUnion' | 'arrayRemove'; value: string }> = [];
  if (uid) {
    transforms.push({
      fieldPath: 'paidByCoach',
      kind: paid ? 'arrayUnion' : 'arrayRemove',
      value: uid,
    });
  }
  if (playerId) {
    transforms.push({
      fieldPath: 'paidByCoachPlayerIds',
      kind: paid ? 'arrayUnion' : 'arrayRemove',
      value: playerId,
    });
  }
  await commitDocumentTransforms(
    pid,
    `payment_requests/${id}`,
    transforms,
    { updatedAt: new Date() },
    sa,
  );
  return json({
    ok: true,
    paid,
    kind: doc.data.kind,
    hint: doc.data.kind === 'recurring'
      ? 'Recurring requests: cash-paid covers THIS period only. Re-mark each cycle.'
      : undefined,
  });
}

// ────────────────────────────────────────────────────────────────
// GET /payments/list?teamId=... — parent-friendly outstanding list.
// Not required for v1 (client can read Firestore directly with the
// public rule below), but useful for cross-team aggregate on the
// parent dashboard card. Punted — dashboard card reads Firestore.
// ────────────────────────────────────────────────────────────────

// Push fanout to parents of the targeted players.
async function sendCreationPush(
  pid: string,
  sa: ServiceAccount,
  env: Env,
  req: Record<string, any>,
  teamId: string,
): Promise<void> {
  const { sendPush } = await import('./fcm');
  if (!env.FCM_SERVICE_ACCOUNT) return;

  // Resolve targeted players.
  const targetKind = req.targetPlayerIds;
  let playerIds: string[] = [];
  if (targetKind === 'all' || !Array.isArray(targetKind)) {
    // Enumerate active players on the team.
    const { runQuery } = await import('./firestore');
    const docs = await runQuery(pid, 'players', [
      { field: 'teamIds', op: 'ARRAY_CONTAINS', value: teamId },
    ], sa, 200).catch(() => []);
    playerIds = docs
      .filter((d: any) => d?.data?.isActive !== false)
      .map((d: any) => d.id);
  } else {
    playerIds = targetKind as string[];
  }

  // Resolve parent uids across those players.
  const parentUids = new Set<string>();
  for (const pidStr of playerIds) {
    const doc = await getDocument(pid, `players/${pidStr}`, sa).catch(() => null);
    const parents: string[] = Array.isArray(doc?.data?.parentIds) ? doc.data.parentIds : [];
    for (const u of parents) if (typeof u === 'string') parentUids.add(u);
  }
  if (parentUids.size === 0) return;

  // Collect FCM tokens honoring push prefs.
  const tokens: string[] = [];
  for (const uid of parentUids) {
    const uDoc = await getDocument(pid, `users/${uid}`, sa).catch(() => null);
    const u: any = uDoc?.data || {};
    if (u.isActive === false) continue;
    if (u.pushPreferences?.broadcast === false) continue;
    const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
    for (const t of arr) if (typeof t === 'string' && t.length > 10) tokens.push(t);
  }
  if (tokens.length === 0) return;

  const kind = String(req.kind || '');
  const price =
    kind === 'one_off' && req.feeCents
      ? `$${(Number(req.feeCents) / 100).toFixed(2)}`
      : kind === 'recurring' && req.intervalCents
        ? `$${(Number(req.intervalCents) / 100).toFixed(2)} ${intervalLabel(req.interval as PaymentRecurringInterval)}`
        : kind === 'catalog'
          ? 'Team store open'
          : '';
  const title = kind === 'catalog' ? 'Team store' : String(req.title || 'Team payment');
  const body = kind === 'catalog'
    ? `Coach ${req.createdByName || ''} opened the team store. Tap to shop.`
    : `Coach ${req.createdByName || ''} added ${req.title || 'a payment'}${price ? ` for ${price}` : ''}. Tap to pay.`;

  const appOrigin = env.APP_ORIGIN || 'https://app.goalkickr.com';
  const url = `${appOrigin}/payments`;

  try {
    await sendPush(Array.from(new Set(tokens)), {
      title,
      body,
      url,
      badge: 1,
    }, env.FCM_SERVICE_ACCOUNT);
  } catch (err) {
    console.warn('[payments] push failed', err);
  }
}

// Also-callable helper for the Stripe webhook — pushes coach + parent
// after a successful payment. Kept public so worker/src/stripe.ts can
// import without pulling in the whole write-guard surface.
export async function pushPaymentConfirmed(
  pid: string,
  sa: ServiceAccount,
  env: Env,
  args: {
    paymentRequestId: string;
    payerUid: string;
    payerName: string;
    amountCents: number;
    kind: 'one_off' | 'recurring' | 'catalog';
    isRenewal?: boolean;
  },
): Promise<void> {
  if (!env.FCM_SERVICE_ACCOUNT) return;
  const { sendPush } = await import('./fcm');
  const doc = await getDocument(pid, `payment_requests/${args.paymentRequestId}`, sa).catch(() => null);
  if (!doc?.data) return;
  const teamId = String(doc.data.teamId || '');
  const title = String(doc.data.title || 'Team payment');

  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const coachIds: string[] = Array.isArray(team?.data?.coachIds) ? team.data.coachIds : [];
  const tokens: string[] = [];
  for (const uid of coachIds) {
    const uDoc = await getDocument(pid, `users/${uid}`, sa).catch(() => null);
    const u: any = uDoc?.data || {};
    if (u.isActive === false) continue;
    const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
    for (const t of arr) if (typeof t === 'string' && t.length > 10) tokens.push(t);
  }
  if (tokens.length === 0) return;
  const amount = `$${(args.amountCents / 100).toFixed(2)}`;
  const body = args.isRenewal
    ? `${args.payerName} renewed ${title} for ${amount}.`
    : `${args.payerName} paid ${amount} for ${title}.`;
  const appOrigin = env.APP_ORIGIN || 'https://app.goalkickr.com';
  try {
    await sendPush(Array.from(new Set(tokens)), {
      title: 'Payment received',
      body,
      url: `${appOrigin}/coach/payments/${args.paymentRequestId}`,
      badge: 1,
    }, env.FCM_SERVICE_ACCOUNT);
  } catch (err) {
    console.warn('[payments] confirmed push failed', err);
  }
}

export async function pushPaymentFailed(
  pid: string,
  sa: ServiceAccount,
  env: Env,
  args: {
    paymentRequestId: string;
    payerUid: string;
    amountCents: number;
  },
): Promise<void> {
  if (!env.FCM_SERVICE_ACCOUNT) return;
  const { sendPush } = await import('./fcm');
  const doc = await getDocument(pid, `payment_requests/${args.paymentRequestId}`, sa).catch(() => null);
  if (!doc?.data) return;
  const teamId = String(doc.data.teamId || '');
  const title = String(doc.data.title || 'Team payment');

  const team = await getDocument(pid, `teams/${teamId}`, sa).catch(() => null);
  const coachIds: string[] = Array.isArray(team?.data?.coachIds) ? team.data.coachIds : [];

  const parentDoc = await getDocument(pid, `users/${args.payerUid}`, sa).catch(() => null);
  const parent: any = parentDoc?.data || {};

  const collect = async (uid: string, out: string[]): Promise<void> => {
    const uDoc = await getDocument(pid, `users/${uid}`, sa).catch(() => null);
    const u: any = uDoc?.data || {};
    if (u.isActive === false) return;
    const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
    for (const t of arr) if (typeof t === 'string' && t.length > 10) out.push(t);
  };

  const parentTokens: string[] = [];
  await collect(args.payerUid, parentTokens);
  const coachTokens: string[] = [];
  for (const uid of coachIds) await collect(uid, coachTokens);

  const amount = `$${(args.amountCents / 100).toFixed(2)}`;
  const appOrigin = env.APP_ORIGIN || 'https://app.goalkickr.com';
  const parentBody = `Payment for ${title} didn't go through. Stripe will retry. You can update your card anytime.`;
  const coachBody = `${parent?.name || 'A parent'}'s payment for ${title} (${amount}) didn't go through. Stripe will retry.`;

  if (parentTokens.length > 0) {
    await sendPush(parentTokens, {
      title: 'Payment issue',
      body: parentBody,
      url: `${appOrigin}/payments`,
      badge: 1,
    }, env.FCM_SERVICE_ACCOUNT).catch(() => {});
  }
  if (coachTokens.length > 0) {
    await sendPush(coachTokens, {
      title: 'Payment issue',
      body: coachBody,
      url: `${appOrigin}/coach/payments/${args.paymentRequestId}`,
      badge: 1,
    }, env.FCM_SERVICE_ACCOUNT).catch(() => {});
  }
}

// Silence unused-import warnings for callers that don't need
// requireUser (declared for future /payments/list variant).
void requireUser;
