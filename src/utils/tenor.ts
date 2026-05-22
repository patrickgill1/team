/**
 * Thin client for the Tenor v2 API.
 * Docs: https://developers.google.com/tenor/guides/quickstart
 *
 * We use `contentfilter=high` for family-friendly content (this is the
 * same filter level iMessage uses — Tenor is owned by Google and powers
 * the iOS GIF keyboard, so users see familiar moderation).
 *
 * The API key lives in REACT_APP_TENOR_API_KEY. Without it the picker
 * still renders, but shows a friendly "GIF search is offline" message
 * rather than spamming the console with auth errors.
 */

export interface TenorGif {
  id: string;
  description: string;
  /** Full-size animated gif. Use as the attachment url. */
  url: string;
  /** Small animated preview for the picker grid. */
  previewUrl: string;
  /** Render width / height for the preview, lets the grid lay out without flicker. */
  width: number;
  height: number;
}

const KEY = process.env.REACT_APP_TENOR_API_KEY || '';
const CLIENT_KEY = 'firefc-team-app';
const BASE = 'https://tenor.googleapis.com/v2';

export const tenorEnabled = (): boolean => KEY.length > 0;

interface TenorApiResult {
  id: string;
  content_description?: string;
  media_formats: Record<string, { url: string; dims: [number, number]; size: number; duration: number }>;
}

function normalize(items: TenorApiResult[]): TenorGif[] {
  const out: TenorGif[] = [];
  for (const r of items || []) {
    // Prefer mediumgif for sending (smaller than original gif, still animated).
    // Fall back to gif if it's missing.
    const full = r.media_formats.mediumgif || r.media_formats.gif;
    const preview = r.media_formats.tinygif || r.media_formats.nanogif || full;
    if (!full || !preview) continue;
    out.push({
      id: r.id,
      description: r.content_description || '',
      url: full.url,
      previewUrl: preview.url,
      width: preview.dims?.[0] || 200,
      height: preview.dims?.[1] || 200,
    });
  }
  return out;
}

/** Search Tenor. Empty/whitespace queries return featured (trending) gifs. */
export async function searchTenor(query: string, limit = 24): Promise<TenorGif[]> {
  if (!tenorEnabled()) return [];
  const params = new URLSearchParams({
    key: KEY,
    client_key: CLIENT_KEY,
    contentfilter: 'high',
    media_filter: 'tinygif,nanogif,mediumgif,gif',
    limit: String(limit),
  });
  const path = query.trim() ? 'search' : 'featured';
  if (query.trim()) params.set('q', query.trim());
  const res = await fetch(`${BASE}/${path}?${params.toString()}`);
  if (!res.ok) {
    console.warn('[tenor] request failed', res.status);
    return [];
  }
  const data = await res.json();
  return normalize(data.results || []);
}
