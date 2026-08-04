/**
 * Parent push fanout for coach XP recognition.
 *
 * Fires when a coach hits Grant XP with a reason. Every parent
 * linked to the player (player.parentIds) gets a push — subject
 * to pushPreferences.broadcast opt-out — with the coach's reason
 * in the body and a deep-link to the player profile so they can
 * see the XP log entry.
 *
 * Called from handleXpGrantCoach (writeGuards.ts) after the
 * per-player writes commit. Failures here MUST NOT fail the
 * outer request — pushes are best-effort.
 *
 * Design decisions (Patrick 2026-08-04):
 * - Only fires for COACH-INITIATED grants (this helper is only
 *   called from handleXpGrantCoach). Auto-XP (attendance, streak,
 *   badge) stays silent to avoid noise.
 * - Reason is required by the coach modal, so we always have
 *   something meaningful to say. Bare "coach tapped +5" pings
 *   don't happen.
 * - Coach is excluded from their own push (if the coach is also
 *   the kid's parent — e.g. Patrick grants XP to his own son
 *   Hunter, Patrick doesn't ping himself).
 * - Title = player first name; body = coach name + reason. Tap
 *   → /player/{id}. Copy warmth per feedback_copy_voice memory.
 */

import { ServiceAccount, sendPush } from './fcm';
import { getDocument } from './firestore';

interface Env {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
  APP_ORIGIN?: string;
}

function firstName(full: string | undefined | null): string {
  const raw = String(full || '').trim();
  if (!raw) return 'your player';
  return raw.split(/\s+/)[0];
}

function truncate(s: string, n: number): string {
  const clean = String(s || '').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

export async function pushXpRecognitionToParents(
  pid: string,
  sa: ServiceAccount,
  env: Env,
  args: {
    playerId: string;
    playerName: string;
    parentIds: string[];
    coachName: string | null;
    reason: string;
    excludeUid?: string;
  },
): Promise<{ sent: number; failed: number; recipients: number }> {
  if (!env.FCM_SERVICE_ACCOUNT) return { sent: 0, failed: 0, recipients: 0 };
  const targets = (args.parentIds || []).filter((u) => u && u !== args.excludeUid);
  if (targets.length === 0) return { sent: 0, failed: 0, recipients: 0 };

  const tokens: string[] = [];
  for (const uid of targets) {
    try {
      const uDoc = await getDocument(pid, `users/${uid}`, sa);
      const u: any = uDoc?.data || {};
      if (u.isActive === false) continue;
      // Honor the same broadcast opt-out wall posts + comments use.
      // If a parent muted broadcasts, XP recognition is muted too.
      const prefs = u.pushPreferences || {};
      if (prefs.broadcast === false) continue;
      const arr: string[] = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
      for (const t of arr) if (typeof t === 'string' && t.length > 10) tokens.push(t);
    } catch { /* per-user lookup failure — skip */ }
  }
  const unique = Array.from(new Set(tokens));
  if (unique.length === 0) return { sent: 0, failed: 0, recipients: targets.length };

  const kidFirst = firstName(args.playerName);
  const coach = (args.coachName || '').trim() || 'Coach';
  const reasonSnippet = truncate(args.reason, 100);
  // Body variants:
  //   With reason (common): `Coach Gill: "Hustled every play"`
  //   Fallback (should never fire — modal requires reason):
  //     `Coach recognized Hunter — tap to see what they said`
  const body = reasonSnippet
    ? `${coach}: "${reasonSnippet}"`
    : `${coach} recognized ${kidFirst}. Tap to see what they said.`;
  const origin = env.APP_ORIGIN || 'https://app.goalkickr.com';
  const url = `${origin}/player/${args.playerId}`;

  try {
    const result = await sendPush(unique, {
      title: kidFirst,
      body,
      url,
    }, env.FCM_SERVICE_ACCOUNT);
    return { sent: result.sent, failed: result.failed, recipients: targets.length };
  } catch (err) {
    console.warn('[xp] parent push failed', err);
    return { sent: 0, failed: unique.length, recipients: targets.length };
  }
}
