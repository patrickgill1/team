/**
 * Auto-post helpers — write a wall_posts doc when high-value team
 * events happen, so the wall surfaces them without a coach having to
 * remember to post manually.
 *
 * Detection rules:
 *   - Games  → always auto-post
 *   - Videos → always auto-post (with thumbnail / preview when available)
 *   - Photos / practices → skip (too noisy)
 *
 * All writes are fire-and-forget. If the post fails (network glitch,
 * permission, whatever), the underlying event/media creation still
 * succeeds — auto-posting is a nice-to-have on top.
 *
 * The Wall lives in its own `wall_posts` collection — it does NOT
 * piggyback on chat. Markdown source here renders cleanly on the
 * Wall and never leaks into a chat thread.
 */

import { addDoc, collection } from 'firebase/firestore';
import { db } from './firebase';
import type { CalendarEvent, DevelopmentPlan, Player, PlayerMedia } from '../types';

interface Actor {
  uid: string;
  name: string;
  role?: string;
}

async function postToWall(
  teamId: string,
  actor: Actor,
  content: string,
  opts: {
    attachments?: Array<{ url: string; type: string; name?: string }>;
    postedFrom?: 'wall' | 'game' | 'video' | 'potm' | 'devplan' | 'juggle';
  } = {}
): Promise<string | null> {
  try {
    const ref = await addDoc(collection(db, 'wall_posts'), {
      teamId,
      content,
      senderId: actor.uid,
      senderName: actor.name,
      senderRole: actor.role || 'coach',
      timestamp: new Date(),
      attachments: opts.attachments && opts.attachments.length > 0 ? opts.attachments : null,
      reactions: [],
      wallPinnedTop: null,
      postedFrom: opts.postedFrom || 'wall',
    });
    return ref.id;
  } catch (err) {
    console.warn('autoPostToWall: write failed', err);
    return null;
  }
}

/** Auto-post a newly scheduled game. Tight two-line format —
 *  opponent + date on one line, venue + arrive on the next. */
export async function autoPostGameToWall(event: CalendarEvent, actor: Actor): Promise<void> {
  if (event.type !== 'game' || !event.teamId || event.isCancelled) return;
  const date = event.date instanceof Date ? event.date : new Date(event.date);
  const dateStr = date.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  const opponent = event.opponent
    ? `${event.homeAway === 'home' ? 'vs' : '@'} **${event.opponent}**`
    : `**${event.title}**`;
  const venuePieces: string[] = [];
  if (event.location) venuePieces.push(event.location);
  if (event.fieldNumber) venuePieces.push(`Field ${event.fieldNumber}`);
  if (event.arriveOffsetMinutes && event.arriveOffsetMinutes > 0) {
    venuePieces.push(`Arrive ${event.arriveOffsetMinutes} min early`);
  }
  const lines = [
    '## Game scheduled',
    `${opponent} · ${dateStr}`,
  ];
  if (venuePieces.length > 0) lines.push(venuePieces.join(' · '));
  await postToWall(event.teamId, actor, lines.join('\n'), { postedFrom: 'game' });
}

/** Auto-post a newly uploaded video clip to the team wall. Photos
 *  are intentionally skipped here — too high frequency to make sense
 *  on the wall. */
export async function autoPostVideoToWall(media: PlayerMedia, actor: Actor): Promise<void> {
  if (media.type !== 'video' || !media.teamId) return;
  const lines: string[] = [];
  lines.push(`## New highlight`);
  if (media.playerName) lines.push(`**${media.playerName}**`);
  if (media.caption) lines.push(`> ${media.caption}`);
  const attachments = media.url
    ? [{ url: media.url, type: 'video', name: media.fileName || 'video' }]
    : undefined;
  await postToWall(media.teamId, actor, lines.join('\n'), { attachments, postedFrom: 'video' });
}

/** Auto-post a Player of the Match win. One line — the player and
 *  the game. Coach can flesh out details in a comment. */
export async function autoPostPotmToWall(
  player: { id?: string; name: string; teamId?: string | null },
  gameTitle: string,
  actor: Actor,
): Promise<void> {
  if (!player?.teamId || !player?.name) return;
  const lines = [
    '## Player of the Match',
    `**${player.name}** — ${gameTitle}`,
  ];
  await postToWall(player.teamId, actor, lines.join('\n'), { postedFrom: 'potm' });
}

/** Auto-post a development plan completion. */
export async function autoPostDevPlanCompleteToWall(
  player: Pick<Player, 'name' | 'teamId'>,
  plan: Pick<DevelopmentPlan, 'title'>,
  actor: Actor,
): Promise<void> {
  if (!player?.teamId || !player?.name) return;
  const lines = [
    '## Plan complete',
    `**${player.name}** finished *${plan.title}*`,
  ];
  await postToWall(player.teamId, actor, lines.join('\n'), { postedFrom: 'devplan' });
}

/** Auto-post a development-plan streak milestone. Fires from the
 *  recomputeAndPersistPlayerStreak path when the player crosses a
 *  threshold (5, 10, 25, 50, 100). One post per crossing — never
 *  again on the same threshold once their streak holds. Patrick:
 *  surfaces other kids' streaks so it gets "the kids and parents
 *  hungry when other children are doing them". */
export const STREAK_MILESTONES = [5, 10, 25, 50, 100] as const;

/** Returns the highest milestone that the streak crossed from
 *  prev → next, or null if no milestone was crossed. "Crossed" =
 *  prev < milestone <= next. */
export function streakMilestoneCrossed(prev: number, next: number): number | null {
  let crossed: number | null = null;
  for (const m of STREAK_MILESTONES) {
    if (prev < m && next >= m) crossed = m;
  }
  return crossed;
}

export async function autoPostStreakMilestoneToWall(
  player: { name: string; teamId?: string | null },
  milestone: number,
  actor: Actor,
): Promise<void> {
  if (!player?.teamId || !player?.name) return;
  // Word the heading by milestone — short, declarative, doesn't try
  // to sound like a marketing campaign. Renders cleanly with
  // RichContent on the wall.
  const heading = milestone >= 100
    ? '## Century streak'
    : milestone >= 50
      ? '## Half-century streak'
      : milestone >= 25
        ? '## On a roll'
        : '## On fire';
  const lines = [
    heading,
    `**${player.name}** just hit a **${milestone}-day** practice streak.`,
  ];
  await postToWall(player.teamId, actor, lines.join('\n'), { postedFrom: 'devplan' });
}

/** Auto-post a new juggle personal best. Only fires when the new
 *  count actually beats the previous best — callers should gate. */
export async function autoPostJugglePrToWall(
  player: Pick<Player, 'name' | 'teamId'>,
  newPr: number,
  oldPr: number,
  actor: Actor,
): Promise<void> {
  if (!player?.teamId || !player?.name) return;
  if (newPr <= oldPr) return;
  const lines = [
    '## New juggle PR',
    `**${player.name}** · ${newPr} juggles${oldPr > 0 ? ` (up from ${oldPr})` : ''}`,
  ];
  await postToWall(player.teamId, actor, lines.join('\n'), { postedFrom: 'juggle' });
}
