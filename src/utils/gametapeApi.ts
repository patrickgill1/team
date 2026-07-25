// Thin worker-fetch wrappers for the Gametape (player_clips)
// endpoints. All mutations are worker-only — Firestore rules deny
// direct client writes on player_clips. On success the caller can
// rely on the Firestore onSnapshot listener to reflect changes;
// these helpers deliberately do not mutate any local cache.
//
// Route paths match the worker's /gametape/* surface (see
// worker/src/gametape.ts). The legacy /player-clips/* paths never
// existed server-side and every mutation 404'd until this file
// was aligned.

import { workerFetch } from './workerFetch';

export type GametapeSource = 'upload' | 'youtube' | 'vimeo';

export interface CreateClipInput {
  teamId: string;
  source: GametapeSource;
  note: string;
  /** Empty array means whole team. */
  playerIds: string[];
  // Upload path
  streamUid?: string;
  durationSeconds?: number;
  fileSize?: number;
  fileName?: string;
  contentType?: string;
  posterTimeSeconds?: number;
  // Link path
  embedUrl?: string;
}

export interface CreateClipResult {
  ok: boolean;
  clipId?: string;
  autoArchived?: Array<{ clipId: string; playerId: string }>;
  pushSent?: number;
  error?: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await workerFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const err = parsed?.error || parsed?.reason || `request-failed-${res.status}`;
    const wrapped = new Error(err);
    (wrapped as any).status = res.status;
    (wrapped as any).body = parsed;
    throw wrapped;
  }
  return parsed as T;
}

export function createClip(input: CreateClipInput): Promise<CreateClipResult> {
  return postJson<CreateClipResult>('/gametape/create', input);
}

export function markClipWatched(input: { clipId: string; playerId: string }): Promise<{ ok: boolean; xpGranted?: number; alreadyWatched?: boolean }> {
  return postJson('/gametape/mark-watched', input);
}

export function archiveClipForPlayer(input: { clipId: string; playerId: string }): Promise<{ ok: boolean }> {
  return postJson('/gametape/archive', input);
}

export function deleteClip(input: { clipId: string }): Promise<{ ok: boolean }> {
  return postJson('/gametape/delete', input);
}
