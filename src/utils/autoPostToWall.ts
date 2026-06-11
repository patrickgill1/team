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
import type { CalendarEvent, PlayerMedia } from '../types';

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
    postedFrom?: 'wall' | 'game' | 'video';
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

/** Auto-post a newly scheduled game to the team wall. Skips
 *  practices, generic events, and any game that's been cancelled
 *  at creation time (shouldn't happen, but guard anyway). */
export async function autoPostGameToWall(event: CalendarEvent, actor: Actor): Promise<void> {
  if (event.type !== 'game' || !event.teamId || event.isCancelled) return;
  const date = event.date instanceof Date ? event.date : new Date(event.date);
  const dateStr = date.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  const lines: string[] = [];
  lines.push(`## Game scheduled`);
  const opponentLine = event.opponent
    ? `${event.homeAway === 'home' ? 'vs' : '@'} **${event.opponent}**`
    : `**${event.title}**`;
  lines.push(opponentLine);
  lines.push('');
  lines.push(`- ${dateStr}`);
  if (event.location) {
    lines.push(`- ${event.location}${event.fieldNumber ? ` · Field ${event.fieldNumber}` : ''}`);
  }
  if (event.arriveOffsetMinutes && event.arriveOffsetMinutes > 0) {
    lines.push(`- Arrive ${event.arriveOffsetMinutes} min early`);
  }
  await postToWall(event.teamId, actor, lines.join('\n'), { postedFrom: 'game' });
}

/** Auto-post a newly uploaded video clip to the team wall. Photos
 *  are intentionally skipped here — too high frequency to make sense
 *  on the wall. Pull in any caption + the player tag so the post
 *  reads as a real moment, not just "new video." */
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
