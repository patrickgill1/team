// Shared poster resolver — every highlights surface (Reel, Netflix rows,
// hero card) walks the same fallback chain so a clip looks identical
// wherever it appears. Cloudflare Stream first (with the coach's picked
// posterTimeSeconds when set), then the R2 thumbnail, then undefined
// (host renders a solid tile).

import type { PlayerMedia as PlayerMediaType } from '../types';
import { streamThumbnailUrl } from './streamUpload';

export function posterFor(clip: PlayerMediaType): string | undefined {
  if (clip.streamUid) {
    // Default to 3s when the coach hasn't picked a specific frame.
    // Reason: most highlight videos have a 1-3s branded intro card
    // (from the coach's highlight-editor template — "GOAL / SCORER: X"
    // title screen). Pulling frame 0 makes every thumbnail identical
    // and the grid reads as a wall of the same branding instead of a
    // board of unique moments. 3s lands on actual gameplay for the
    // typical template. Coach can override via the lightbox picker.
    // Patrick 2026-09-13.
    const time = clip.posterTimeSeconds != null
      ? `${clip.posterTimeSeconds}s`
      : '3s';
    return streamThumbnailUrl(clip.streamUid, {
      height: 1080,
      time,
    });
  }
  return clip.thumbnailUrl;
}
