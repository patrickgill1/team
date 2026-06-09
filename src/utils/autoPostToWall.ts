/**
 * Auto-post helpers — write a chat message to the team's primary
 * thread + pin it so the post shows up on /wall. Used by the event
 * creation flow (for games) and the media upload flow (for videos)
 * so high-value team events surface on the wall without a coach
 * remembering to do it manually.
 *
 * Detection rules:
 *   - Games  → always auto-post
 *   - Videos → always auto-post (with thumbnail when available)
 *   - Photos / practices → skip (too noisy)
 *
 * All writes are fire-and-forget. If the post fails (no team chat
 * thread yet, network glitch, whatever), the underlying event/media
 * creation still succeeds — auto-posting is a nice-to-have on top.
 */

import { addDoc, collection, doc, getDocs, query, updateDoc, where } from 'firebase/firestore';
import { db } from './firebase';
import type { CalendarEvent, ChatThread, PlayerMedia } from '../types';

interface Actor {
  uid: string;
  name: string;
  role?: string;
}

// Find the best chat thread to post into for a team. Skips DMs +
// private (coach-only) threads, prefers the most recently active.
async function findPrimaryTeamThread(teamId: string): Promise<{ id: string; pinnedMessageIds: string[] } | null> {
  try {
    const snap = await getDocs(query(
      collection(db, 'chat_threads'),
      where('teamId', '==', teamId),
    ));
    const candidates = snap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) } as ChatThread & { id: string }))
      .filter(t => !t.isDM && !t.isPrivate);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const aTs = (a.lastActivity as any)?.toDate?.()?.getTime?.() || new Date(a.lastActivity || 0).getTime();
      const bTs = (b.lastActivity as any)?.toDate?.()?.getTime?.() || new Date(b.lastActivity || 0).getTime();
      return bTs - aTs;
    });
    const target = candidates[0];
    return {
      id: target.id,
      pinnedMessageIds: Array.isArray(target.pinnedMessageIds) ? target.pinnedMessageIds : [],
    };
  } catch (err) {
    console.warn('autoPostToWall: thread lookup failed', err);
    return null;
  }
}

async function postAndPin(
  teamId: string,
  actor: Actor,
  content: string,
  opts: { attachments?: PlayerMedia['url'] extends string ? Array<{ url: string; type: string; name?: string }> : never } = {}
): Promise<string | null> {
  const target = await findPrimaryTeamThread(teamId);
  if (!target) return null;
  try {
    const msgRef = await addDoc(collection(db, 'chat_messages'), {
      threadId: target.id,
      teamId,
      content,
      senderId: actor.uid,
      senderName: actor.name,
      senderRole: actor.role || 'coach',
      timestamp: new Date(),
      createdAt: new Date(),
      attachments: opts.attachments && opts.attachments.length > 0 ? opts.attachments : undefined,
    });
    await updateDoc(doc(db, 'chat_threads', target.id), {
      pinnedMessageIds: [...target.pinnedMessageIds, msgRef.id],
      lastActivity: new Date(),
    });
    return msgRef.id;
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
  lines.push(`📅 **Game scheduled**`);
  const opponentLine = event.opponent
    ? `${event.homeAway === 'home' ? 'vs' : '@'} ${event.opponent}`
    : event.title;
  lines.push(opponentLine);
  lines.push(dateStr);
  if (event.location) {
    lines.push(event.location + (event.fieldNumber ? ` · Field ${event.fieldNumber}` : ''));
  }
  if (event.arriveOffsetMinutes && event.arriveOffsetMinutes > 0) {
    lines.push(`Arrive ${event.arriveOffsetMinutes} min early`);
  }
  await postAndPin(event.teamId, actor, lines.join('\n'));
}

/** Auto-post a newly uploaded video clip to the team wall. Photos
 *  are intentionally skipped here — too high frequency to make sense
 *  on the wall. Pull in any caption + the player tag so the post
 *  reads as a real moment, not just "new video." */
export async function autoPostVideoToWall(media: PlayerMedia, actor: Actor): Promise<void> {
  if (media.type !== 'video' || !media.teamId) return;
  const lines: string[] = [];
  lines.push(`🎥 **New highlight**`);
  if (media.playerName) lines.push(media.playerName);
  if (media.caption) lines.push(`"${media.caption}"`);
  // Embed the video as an attachment. The wall renderer falls back
  // to the image attachment grid; mobile chat clients linkify the
  // URL — both surfaces work without changes.
  const attachments = media.url
    ? [{ url: media.url, type: 'video', name: media.fileName || 'video' }]
    : undefined;
  await postAndPin(media.teamId, actor, lines.join('\n'), { attachments });
}
