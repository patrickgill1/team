// Shared poster resolver — every highlights surface (Reel, Netflix rows,
// hero card) walks the same fallback chain so a clip looks identical
// wherever it appears. Cloudflare Stream first (with the coach's picked
// posterTimeSeconds when set), then the R2 thumbnail, then undefined
// (host renders a solid tile).

import type { PlayerMedia as PlayerMediaType } from '../types';
import { streamThumbnailUrl } from './streamUpload';

export function posterFor(clip: PlayerMediaType): string | undefined {
  if (clip.streamUid) {
    // Default to 5s when the coach hasn't picked a specific frame.
    // Reason: most highlight videos have a branded intro card (from
    // the coach's highlight-editor template — "GOAL / SCORER: X"
    // title screen) that lasts 3-6s. Pulling frame 0 makes every
    // thumbnail identical and the grid reads as a wall of the same
    // branding. 5s lands on actual gameplay for the typical template.
    // Coach can override via the lightbox picker. Bumped from 3s to
    // 5s 2026-09-13 after Patrick reported the grid still looked the
    // same at 3s — his editor's intro is longer.
    const time = clip.posterTimeSeconds != null
      ? `${clip.posterTimeSeconds}s`
      : '5s';
    return streamThumbnailUrl(clip.streamUid, {
      height: 1080,
      time,
    });
  }
  return clip.thumbnailUrl;
}
