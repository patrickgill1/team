// Shared poster resolver — every highlights surface (Reel, Netflix rows,
// hero card) walks the same fallback chain so a clip looks identical
// wherever it appears. Cloudflare Stream first (with the coach's picked
// posterTimeSeconds when set), then the R2 thumbnail, then undefined
// (host renders a solid tile).

import type { PlayerMedia as PlayerMediaType } from '../types';
import { streamThumbnailUrl } from './streamUpload';

export function posterFor(clip: PlayerMediaType): string | undefined {
  if (clip.streamUid) {
    return streamThumbnailUrl(clip.streamUid, {
      height: 1080,
      time: clip.posterTimeSeconds != null ? `${clip.posterTimeSeconds}s` : undefined,
    });
  }
  return clip.thumbnailUrl;
}
