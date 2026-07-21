#!/usr/bin/env tsx
/**
 * Backfill: seed the players/{pid}/dev_checkins subcollection from
 * every practice-log entry across every development_plan the player
 * has ever had (active, archived, completed, deleted-but-still-in-doc).
 *
 * Why: streak used to be derived from active plans only, so retiring
 * plan A silently reset the counter for a kid who kept practicing on
 * plan B. The rework (2026-07-21) moves the source of truth to a
 * player-owned check-in subcollection. This script seeds that
 * subcollection from the ONLY moment archived plans are re-included,
 * so an existing streak (Patrick's son) transfers over intact.
 *
 * After seeding, currentStreakDays + longestStreakDays are recomputed
 * from the seeded check-ins with the team's Sunday-skip rest-day
 * config honored.
 *
 * Idempotent — check-in docs use set() with the Denver day key so a
 * second run merges cleanly. Re-running against the same input never
 * duplicates a day.
 *
 * Usage:
 *   npx tsx scripts/backfill-player-streak.ts                 # dry-run
 *   npx tsx scripts/backfill-player-streak.ts --apply         # write
 *   npx tsx scripts/backfill-player-streak.ts --apply --player=abc123
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const APPLY = process.argv.includes('--apply');
const PLAYER_ONLY = (() => {
  const arg = process.argv.find(a => a.startsWith('--player='));
  return arg ? arg.slice('--player='.length) : null;
})();
const tag = APPLY ? 'APPLY' : 'DRY  ';

const SA_PATH = path.resolve(__dirname, 'firebase-service-account.json');
if (!fs.existsSync(SA_PATH)) {
  console.error('Service account JSON not found at', SA_PATH);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(SA_PATH) });
const db = admin.firestore();

/** "YYYY-MM-DD" in America/Denver — the docId shape for
 *  players/{pid}/dev_checkins/{dayKey}. Matches the worker. */
function denverDayKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

/** Local-time "YYYY-M-D" bucket key that the client-side streak walk
 *  produces (see computeStreakDaysFromKeys). We bucket on LOCAL date
 *  in Denver TZ so the streak math matches the runtime app for
 *  Patrick's tz — matches the client's `${year}-${month}-${date}`
 *  format (0-indexed month, no zero pad). */
function localBucketKey(d: Date): string {
  // Use Denver components explicitly to stay tz-safe when running
  // this script off-tz (e.g. Cloud Shell UTC).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(d);
  const y = Number(parts.find(p => p.type === 'year')?.value);
  const m = Number(parts.find(p => p.type === 'month')?.value);
  const day = Number(parts.find(p => p.type === 'day')?.value);
  // getMonth() is 0-indexed; Intl month is 1-indexed. Subtract 1.
  return `${y}-${m - 1}-${day}`;
}

/** Sunday-skip aware "walk back from today" streak, matching the
 *  client's computeStreakDaysFromKeys. */
function computeStreakFromKeys(dayKeys: Set<string>, restDayOfWeek: number | null): number {
  if (dayKeys.size === 0) return 0;
  const skipDow: number | null = (restDayOfWeek === null || restDayOfWeek === undefined) ? 0 : restDayOfWeek;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  const todayKey = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
  if (!dayKeys.has(todayKey) && (skipDow == null || cursor.getDay() !== skipDow)) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  for (; ;) {
    if (skipDow != null && cursor.getDay() === skipDow) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    const k = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
    if (dayKeys.has(k)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else break;
  }
  return streak;
}

/** Longest-ever consecutive run in a Set of day keys (Sunday-skip aware). */
function computeLongestFromKeys(dayKeys: Set<string>, restDayOfWeek: number | null): number {
  if (dayKeys.size === 0) return 0;
  const skipDow: number | null = (restDayOfWeek === null || restDayOfWeek === undefined) ? 0 : restDayOfWeek;
  const dates: Date[] = [];
  for (const key of dayKeys) {
    const [y, m, d] = key.split('-').map(n => parseInt(n, 10));
    if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) continue;
    const dt = new Date(y, m, d);
    dt.setHours(0, 0, 0, 0);
    dates.push(dt);
  }
  dates.sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0) return 0;
  const first = dates[0];
  const last = dates[dates.length - 1];
  const cursor = new Date(first);
  let run = 0;
  let max = 0;
  while (cursor.getTime() <= last.getTime()) {
    const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
    const isRest = skipDow != null && cursor.getDay() === skipDow;
    if (isRest) {
      // Bridges — do not increment, do not reset.
    } else if (dayKeys.has(key)) {
      run += 1;
      if (run > max) max = run;
    } else {
      run = 0;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return max;
}

/** Coerce a practiceLog entry's `date` to a JS Date. Mirrors the
 *  client's coerceLogDate: handles Firestore Timestamp, plain Date,
 *  and the legacy {seconds, nanoseconds} map left over from the
 *  pre-3.2.57 cleanFirestoreData bug. */
function coerceLogDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') {
    try { return raw.toDate(); } catch { /* fall through */ }
  }
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number' || typeof raw === 'string') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw.seconds === 'number') {
    const ms = raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

interface CheckinSeed {
  date: Date;
  dayKey: string;              // Denver "YYYY-MM-DD" (docId)
  localKey: string;            // local "YYYY-M-D" (for streak math)
  planId: string;
  goalId: string;
  goalTitle: string;
  loggedBy: string;
  loggedByName: string;
  teamId: string;
}

(async () => {
  const playersSnap = PLAYER_ONLY
    ? [await db.collection('players').doc(PLAYER_ONLY).get()]
    : (await db.collection('players').get()).docs;
  console.log(`Walking ${playersSnap.length} player doc(s). tag=${tag}`);

  // Preload teams so we can honor each team's restDayOfWeek without
  // an extra get() per player.
  const teamRestDay = new Map<string, number | null>();
  const teamsSnap = await db.collection('teams').get();
  for (const t of teamsSnap.docs) {
    const cfg: any = (t.data() as any).streakConfig;
    if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'restDayOfWeek')) {
      teamRestDay.set(t.id, cfg.restDayOfWeek === null ? null : Number(cfg.restDayOfWeek));
    } else {
      teamRestDay.set(t.id, 0); // default Sunday
    }
  }

  let touchedPlayers = 0;
  let seededDays = 0;
  let recomputedStreaks = 0;

  for (const pDoc of playersSnap) {
    if (!pDoc || !pDoc.exists) continue;
    const p: any = pDoc.data();
    const playerId = pDoc.id;
    const teamId: string = p.teamId || (Array.isArray(p.teamIds) ? p.teamIds[0] : '');
    const restDayOfWeek = teamId && teamRestDay.has(teamId) ? teamRestDay.get(teamId)! : 0;
    const cachedStreak = Number(p.currentStreakDays) || 0;

    // Pull EVERY plan for this player regardless of status. Archived,
    // completed, and status-less plans all contribute their practice
    // log entries. This is the one moment we re-include them —
    // afterwards the check-in subcollection stands alone.
    const plansSnap = await db.collection('development_plans')
      .where('playerId', '==', playerId)
      .get();
    if (plansSnap.empty) continue;

    // Bucket every log entry by Denver day. First writer wins on
    // metadata (loggedBy/plan/goal snapshot); later same-day taps
    // update `date` to the latest occurrence. Second-run of the
    // script writes the same shape via set() so it's a no-op patch.
    const seedsByDay = new Map<string, CheckinSeed>();
    for (const planDoc of plansSnap.docs) {
      const plan: any = planDoc.data();
      const planId = planDoc.id;
      const planTeamId: string = plan.teamId || teamId;
      const goals: any[] = Array.isArray(plan.goals) ? plan.goals : [];
      for (const g of goals) {
        const log: any[] = Array.isArray(g.practiceLog) ? g.practiceLog : [];
        for (const entry of log) {
          const d = coerceLogDate(entry?.date);
          if (!d) continue;
          const dayKey = denverDayKey(d);
          const localKey = localBucketKey(d);
          const existing = seedsByDay.get(dayKey);
          // Keep the earliest tap of the day as the seed record so
          // metadata reflects the first tap. Subsequent taps still
          // land on the same doc-id, so no dup.
          if (existing && existing.date.getTime() <= d.getTime()) continue;
          seedsByDay.set(dayKey, {
            date: d,
            dayKey,
            localKey,
            planId,
            goalId: String(g?.id || ''),
            goalTitle: String(g?.title || ''),
            loggedBy: String(entry?.loggedBy || ''),
            loggedByName: String(entry?.loggedByName || 'Family'),
            teamId: planTeamId,
          });
        }
      }
    }

    if (seedsByDay.size === 0) continue;

    // Compose the localKey set for the streak recompute.
    const localKeys = new Set<string>();
    for (const s of seedsByDay.values()) localKeys.add(s.localKey);
    const nextStreak = computeStreakFromKeys(localKeys, restDayOfWeek);
    const nextLongest = computeLongestFromKeys(localKeys, restDayOfWeek);

    const delta = nextStreak - cachedStreak;
    const deltaTag = delta > 0 ? `+${delta}` : String(delta);
    console.log(`[${tag}] ${playerId} (${p.name || 'unnamed'}) days=${seedsByDay.size} streak=${cachedStreak}->${nextStreak} (${deltaTag}) longest=${nextLongest}`);

    if (!APPLY) {
      touchedPlayers++;
      seededDays += seedsByDay.size;
      recomputedStreaks++;
      continue;
    }

    // Write check-in docs. set() with merge preserves any manual
    // adjustments a coach makes via a future undo endpoint.
    const batch = db.batch();
    let batchOps = 0;
    for (const seed of seedsByDay.values()) {
      const ref = db.collection('players').doc(playerId)
        .collection('dev_checkins').doc(seed.dayKey);
      batch.set(ref, {
        date: seed.date,
        dayKey: seed.dayKey,
        loggedBy: seed.loggedBy,
        loggedByRole: 'backfill',
        loggedByName: seed.loggedByName,
        planId: seed.planId,
        goalId: seed.goalId,
        goalTitle: seed.goalTitle,
        teamId: seed.teamId,
        note: '',
        backfilledFrom: 'practiceLog',
        backfilledAt: new Date(),
      }, { merge: true });
      batchOps++;
      if (batchOps >= 400) {
        await batch.commit();
        batchOps = 0;
      }
    }
    if (batchOps > 0) await batch.commit();

    // Recompute cache. Peak is monotonic — never step down.
    const currentLongest = Math.max(Number(p.longestStreakDays) || 0, nextLongest, nextStreak);
    await db.collection('players').doc(playerId).update({
      currentStreakDays: nextStreak,
      currentStreakUpdatedAt: new Date(),
      longestStreakDays: currentLongest,
    });

    touchedPlayers++;
    seededDays += seedsByDay.size;
    recomputedStreaks++;
  }

  console.log(`\nDone. players=${touchedPlayers} seededDays=${seededDays} recomputed=${recomputedStreaks}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
