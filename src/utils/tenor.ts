/**
 * Unified GIF search helper. Supports either Tenor (Google) or GIPHY,
 * whichever has an API key configured. Both providers are family-safe
 * when used with their strictest content filter — Tenor's
 * `contentfilter=high` matches what iMessage / WhatsApp use; GIPHY's
 * `rating=g` is their general-audience filter.
 *
 * Env vars (set in Vercel + .env):
 *   REACT_APP_TENOR_API_KEY  — Tenor key (https://console.cloud.google.com/)
 *   REACT_APP_GIPHY_API_KEY  — GIPHY key (https://developers.giphy.com/)
 *
 * Tenor wins if both are set (better moderation). File name stays as
 * `tenor.ts` so existing imports keep working.
 */

export interface TenorGif {
  id: string;
  description: string;
  /** Full-size animated gif (used as the chat attachment URL). */
  url: string;
  /** Small animated preview for the picker grid. */
  previewUrl: string;
  /** Render width / height for the preview, lets the grid lay out without flicker. */
  width: number;
  height: number;
}

const TENOR_KEY = process.env.REACT_APP_TENOR_API_KEY || '';
const GIPHY_KEY = process.env.REACT_APP_GIPHY_API_KEY || '';
const CLIENT_KEY = 'firefc-team-app';

export const tenorEnabled = (): boolean => TENOR_KEY.length > 0 || GIPHY_KEY.length > 0;

// ============================================================================
// Tenor (Google) — preferred when available, strictest content moderation
// ============================================================================

interface TenorApiResult {
  id: string;
  content_description?: string;
  media_formats: Record<string, { url: string; dims: [number, number]; size: number; duration: number }>;
}

function normalizeTenor(items: TenorApiResult[]): TenorGif[] {
  const out: TenorGif[] = [];
  for (const r of items || []) {
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

async function searchViaTenor(query: string, limit: number): Promise<TenorGif[]> {
  const params = new URLSearchParams({
    key: TENOR_KEY,
    client_key: CLIENT_KEY,
    contentfilter: 'high',
    media_filter: 'tinygif,nanogif,mediumgif,gif',
    limit: String(limit),
  });
  const path = query.trim() ? 'search' : 'featured';
  if (query.trim()) params.set('q', query.trim());
  const res = await fetch(`https://tenor.googleapis.com/v2/${path}?${params.toString()}`);
  if (!res.ok) {
    console.warn('[tenor] request failed', res.status);
    return [];
  }
  const data = await res.json();
  return normalizeTenor(data.results || []);
}

// ============================================================================
// GIPHY — fallback when Tenor isn't available. Simpler signup (no GCP).
// ============================================================================

interface GiphyApiResult {
  id: string;
  title?: string;
  images: {
    fixed_height?: { url: string; width: string; height: string };
    fixed_width_small?: { url: string; width: string; height: string };
    original?: { url: string; width: string; height: string };
  };
}

function normalizeGiphy(items: GiphyApiResult[]): TenorGif[] {
  const out: TenorGif[] = [];
  for (const r of items || []) {
    const full = r.images.fixed_height || r.images.original;
    const preview = r.images.fixed_width_small || r.images.fixed_height || full;
    if (!full || !preview) continue;
    out.push({
      id: r.id,
      description: r.title || '',
      url: full.url,
      previewUrl: preview.url,
      width: parseInt(preview.width, 10) || 200,
      height: parseInt(preview.height, 10) || 200,
    });
  }
  return out;
}

async function searchViaGiphy(query: string, limit: number): Promise<TenorGif[]> {
  const params = new URLSearchParams({
    api_key: GIPHY_KEY,
    rating: 'g',
    limit: String(limit),
  });
  const path = query.trim() ? 'search' : 'trending';
  if (query.trim()) params.set('q', query.trim());
  const res = await fetch(`https://api.giphy.com/v1/gifs/${path}?${params.toString()}`);
  if (!res.ok) {
    console.warn('[giphy] request failed', res.status);
    return [];
  }
  const data = await res.json();
  return normalizeGiphy(data.data || []);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Search GIFs. Empty query returns featured/trending. Provider picked
 * based on which API key is configured; Tenor preferred when both exist.
 */
export async function searchTenor(query: string, limit = 24): Promise<TenorGif[]> {
  if (TENOR_KEY) return searchViaTenor(query, limit);
  if (GIPHY_KEY) return searchViaGiphy(query, limit);
  return [];
}
