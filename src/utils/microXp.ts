import { workerFetch } from './workerFetch';

// Micro-XP grants — worker-routed since 2026-07-24. Every XP write now
// goes through POST /xp/log-grant so the player_xp_events audit row,
// player.xp increment, and (optional) badge stamp land as a single
// atomic commit under the service account. Rules deny client writes
// against player_xp_events for exactly this reason; the client has no
// legal path to hand-write the audit trail.
//
// Contract summary (see worker /xp/log-grant handler for the source of truth):
//   Request: { playerId, teamId, source, xp, sourceRef?, note?, alsoStampBadge? }
//   Response: { outcome: 'created' | 'already_exists' | 'capped', eventId, newPlayerXp?, newXpCareer? }
//   Auth: coach of teamId OR (for kid-actionable sources) player parent / self kid.
//   Idempotency: pass sourceRef for anything that could be double-tapped
//     (self-heal effects, retries, backfill). ALREADY_EXISTS is treated
//     as success.
//
// Fail-closed gate the client still owns:
//   - xpEnabled === false → immediate no-op, no network call. Caller
//     computes this from team.xpConfig.enabled. The worker enforces the
//     same gate authoritatively; the local check just saves a round-trip
//     when the team hasn't opted in.
//
// Fire-and-forget: callers should NOT block UX on the return value.
// Errors are logged (console.warn) and swallowed into { ok: false }.
//
// NOTE: We used to do a local pre-flight against player.xpDailyCount to
// short-circuit capped grants. That was removed 2026-07-24 — the field
// name was stale (worker writes xpDailyCountBySource) so the read never
// matched, and the worker enforces caps authoritatively either way.
// Cheaper to eat one extra worker round-trip on capped calls than to
// carry the dead code.

export interface AwardMicroXpOpts {
  /** Player receiving the XP. Required. */
  playerId: string;
  /** Team the action fired against — worker uses this for the coach
   *  auth check and to pull xpConfig / seasonId. Required. */
  teamId: string;
  /** SOURCE_ENUM key — must match one of the values the worker
   *  accepts (see the /xp/log-grant contract). Required. */
  source: string;
  /** XP amount, 1..500 integer. Required. */
  xp: number;
  /** Deterministic doc id for the player_xp_events row. When set,
   *  a re-run with the same id gets ALREADY_EXISTS back and is a
   *  no-op — safe for retries + mount-effect self-heals. */
  sourceRef?: string;
  /** Optional short note stamped on the event row. */
  note?: string;
  /** Optional atomic badge stamp — worker writes badges.{slug} on the
   *  player doc as part of the same commit as the XP increment. */
  alsoStampBadge?: { slug: string; earnedAt: string };
  /** Team.xpConfig.enabled precheck. false → no network call. */
  xpEnabled?: boolean;
  /** Legacy signature compat — unused server-side. The worker derives
   *  the cap bucket from `source`. Kept in the type so old callers
   *  compile without change. */
  actionKey?: string;
}

export interface AwardMicroXpResult {
  ok: boolean;
  outcome?: 'created' | 'already_exists' | 'capped';
  error?: string;
  /** Post-write player.xp (season total). Present when the worker
   *  returns it — callers can compare to a pre-read priorXp to fire
   *  a level-up whisper. */
  newPlayerXp?: number;
  /** Post-write player.xpCareer. */
  newXpCareer?: number;
}

/** Fire an XP grant through the worker. See file header for the
 *  contract + fail-closed rules. */
export async function awardMicroXp(opts: AwardMicroXpOpts): Promise<AwardMicroXpResult> {
  const { playerId, teamId, source } = opts;
  const xp = Number(opts.xp);
  if (!playerId || !teamId || !source) return { ok: false, error: 'missing-required' };
  if (!Number.isFinite(xp) || xp <= 0) return { ok: false, error: 'invalid-xp' };
  if (opts.xpEnabled === false) return { ok: false };

  const body: Record<string, any> = {
    playerId,
    teamId,
    source,
    xp: Math.trunc(xp),
  };
  if (opts.sourceRef) body.sourceRef = opts.sourceRef;
  if (opts.note) body.note = opts.note;
  if (opts.alsoStampBadge) body.alsoStampBadge = opts.alsoStampBadge;

  try {
    const res = await workerFetch('/xp/log-grant', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('[microXp] worker rejected grant', {
        playerId,
        source,
        status: res.status,
        error: data?.error,
      });
      return { ok: false, error: data?.error || `http-${res.status}` };
    }
    return {
      ok: true,
      outcome: data?.outcome,
      newPlayerXp: typeof data?.newPlayerXp === 'number' ? data.newPlayerXp : undefined,
      newXpCareer: typeof data?.newXpCareer === 'number' ? data.newXpCareer : undefined,
    };
  } catch (err) {
    console.warn('[microXp] worker call failed', playerId, source, err);
    return { ok: false, error: (err as Error).message };
  }
}
