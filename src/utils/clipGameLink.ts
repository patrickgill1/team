// Stat-dedup glue between video clips and live game timelines.
//
// Goal: writing a goal/assist credit on a clip should NOT also write the same
// goal/assist a second time when the coach already tapped it on Game Day.
//
// Strategy: a clip can carry an optional `gameId` linking it to a calendar
// event / live_games doc. When credits are saved on such a clip we either:
//   (a) ATTACH the clip's URL onto an existing matching live timeline entry
//       (same playerId + same kind, no clipMediaId yet) — no stat bump, the
//       finalize step will count that entry exactly once; or
//   (b) ADD a new timeline entry tagged `source: 'clip'` so finalize picks it up.
//
// For games already in `final` status, the caller still has to bump season
// stats for *newly added* credits because finalize won't run again.
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';

export interface AttachInput {
  gameId: string;
  mediaId: string;
  clipUrl: string;
  scorerId?: string;
  scorerName?: string;
  scorerJersey?: number;
  assistIds?: string[];
  assistsById?: Record<string, { name?: string; jersey?: number }>;
  recordedBy?: string;
  recordedByName?: string;
}

export interface AttachResult {
  status: 'live' | 'halftime' | 'scheduled' | 'final' | 'no-doc';
  // Credits that were attached to an existing live timeline entry — already counted.
  attachedScorer: boolean;
  attachedAssistIds: string[];
  // Credits that needed a brand-new timeline entry — caller must bump season
  // stats for these *only when status === 'final'*.
  addedScorer: boolean;
  addedAssistIds: string[];
}

const newId = () => `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

export async function attachClipCreditsToGame(input: AttachInput): Promise<AttachResult> {
  const result: AttachResult = {
    status: 'no-doc',
    attachedScorer: false,
    attachedAssistIds: [],
    addedScorer: false,
    addedAssistIds: [],
  };

  const ref = doc(db, 'live_games', input.gameId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return result;

  const data = snap.data() as any;
  result.status = data.status || 'scheduled';
  const timeline: any[] = Array.isArray(data.timeline) ? [...data.timeline] : [];

  const findOpenEntry = (playerId: string, kind: 'goal' | 'assist') =>
    timeline.findIndex(t => t && t.playerId === playerId && t.kind === kind && !t.clipMediaId);

  // Goal
  if (input.scorerId) {
    const idx = findOpenEntry(input.scorerId, 'goal');
    if (idx >= 0) {
      timeline[idx] = { ...timeline[idx], clipUrl: input.clipUrl, clipMediaId: input.mediaId };
      result.attachedScorer = true;
    } else {
      timeline.push({
        id: newId(),
        at: Date.now(),
        minute: 0,
        kind: 'goal',
        playerId: input.scorerId,
        playerName: input.scorerName,
        jerseyNumber: input.scorerJersey,
        source: 'clip',
        clipUrl: input.clipUrl,
        clipMediaId: input.mediaId,
        recordedBy: input.recordedBy,
        recordedByName: input.recordedByName,
      });
      result.addedScorer = true;
    }
  }

  // Assists
  for (const aid of input.assistIds || []) {
    if (!aid) continue;
    const idx = findOpenEntry(aid, 'assist');
    if (idx >= 0) {
      timeline[idx] = { ...timeline[idx], clipUrl: input.clipUrl, clipMediaId: input.mediaId };
      result.attachedAssistIds.push(aid);
    } else {
      const meta = input.assistsById?.[aid] || {};
      timeline.push({
        id: newId(),
        at: Date.now(),
        minute: 0,
        kind: 'assist',
        playerId: aid,
        playerName: meta.name,
        jerseyNumber: meta.jersey,
        source: 'clip',
        clipUrl: input.clipUrl,
        clipMediaId: input.mediaId,
        recordedBy: input.recordedBy,
        recordedByName: input.recordedByName,
      });
      result.addedAssistIds.push(aid);
    }
  }

  await updateDoc(ref, { timeline });
  return result;
}

// When credits are removed (un-tagged) from a clip, sweep our markers off the
// live timeline. Removes any `source: 'clip'` entries linked to this media,
// and detaches clipUrl/clipMediaId from any entries we previously attached.
// Returns the credits that had been "added" (so the caller can roll back the
// matching season-stat bump if the game was already final).
export async function detachClipCreditsFromGame(
  gameId: string,
  mediaId: string,
): Promise<{ status: AttachResult['status']; removedScorer: boolean; removedAssistIds: string[] }> {
  const out = { status: 'no-doc' as AttachResult['status'], removedScorer: false, removedAssistIds: [] as string[] };
  const ref = doc(db, 'live_games', gameId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return out;
  const data = snap.data() as any;
  out.status = data.status || 'scheduled';
  const timeline: any[] = Array.isArray(data.timeline) ? data.timeline : [];

  const next = timeline.flatMap(t => {
    if (!t || t.clipMediaId !== mediaId) return [t];
    if (t.source === 'clip') {
      if (t.kind === 'goal' && t.playerId) out.removedScorer = true;
      if (t.kind === 'assist' && t.playerId) out.removedAssistIds.push(t.playerId);
      return []; // drop the clip-only entry
    }
    // Detach clip metadata from a live entry
    const { clipUrl, clipMediaId, ...rest } = t;
    return [rest];
  });

  await updateDoc(ref, { timeline: next });
  return out;
}
