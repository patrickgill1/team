// @ts-nocheck
/**
 * Maps helpers — search/reverse/tile config + maps deep-links.
 *
 * Geocoding provider chain:
 *   1. Google Places (via Cloudflare Worker proxy) — best venue
 *      coverage, especially for new/local sports complexes that
 *      Mapbox and OSM haven't indexed. Opt-in by setting
 *      GOOGLE_PLACES_API_KEY on the worker; clients auto-detect by
 *      sniffing /places/autocomplete's response.
 *   2. Mapbox (direct from client) — good general coverage, sharper
 *      tiles. Opt-in via REACT_APP_MAPBOX_TOKEN.
 *   3. OSM / Nominatim — free fallback, weak venue coverage.
 *
 * "Best" provider wins per-call: client tries Google first, if the
 * worker returns 503 (not configured) we cache that and skip Google
 * for the rest of the session.
 */

const NOTIFY_URL: string = (process.env.REACT_APP_NOTIFY_URL || '').trim();
const NOTIFY_SECRET: string = (process.env.REACT_APP_NOTIFY_SECRET || '').trim();

export const MAPBOX_TOKEN: string = (process.env.REACT_APP_MAPBOX_TOKEN || '').trim();
export const hasMapbox = (): boolean => MAPBOX_TOKEN.length > 0;
export const hasNotifyProxy = (): boolean => NOTIFY_URL.length > 0 && NOTIFY_SECRET.length > 0;

// Session-scoped cache so we don't hammer the worker if Google is
// unconfigured on this deploy. Reset by reload.
let googleAvailable: boolean | null = null;

// Mapbox-style session token for Google's autocomplete+details billing
// session (bundles to a single $0.017 charge instead of $2.83+$17 per
// 1000). Generated per picker session, cleared after a pick.
let googleSessionToken: string | null = null;
export function startGoogleSession(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    googleSessionToken = crypto.randomUUID();
  } else {
    googleSessionToken = `s_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }
  return googleSessionToken;
}
export function endGoogleSession(): void {
  googleSessionToken = null;
}

async function callProxy(path: string, body: any): Promise<any | null> {
  if (!hasNotifyProxy()) return null;
  try {
    const res = await fetch(`${NOTIFY_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${NOTIFY_SECRET}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 503) {
      // Worker says Google isn't configured. Don't retry this session.
      googleAvailable = false;
      return null;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn(`[maps] proxy ${path} failed`, res.status, txt.slice(0, 120));
      return null;
    }
    googleAvailable = true;
    return await res.json();
  } catch (err) {
    console.warn(`[maps] proxy ${path} threw`, err);
    return null;
  }
}

export async function googleAutocomplete(
  q: string,
  proximity?: { lat: number; lon: number },
): Promise<Array<{ placeId: string; label: string; address: string }> | null> {
  if (googleAvailable === false) return null;
  const body: any = { q };
  if (proximity) { body.lat = proximity.lat; body.lon = proximity.lon; }
  if (googleSessionToken) body.sessionToken = googleSessionToken;
  const data = await callProxy('/places/autocomplete', body);
  if (!data?.ok) return null;
  return data.predictions || [];
}

export async function googleDetails(placeId: string): Promise<{ name: string; address: string; lat: number; lon: number } | null> {
  if (googleAvailable === false) return null;
  const body: any = { placeId };
  if (googleSessionToken) body.sessionToken = googleSessionToken;
  const data = await callProxy('/places/details', body);
  if (!data?.ok || !data.place) return null;
  // Once details lands, the billable session is over.
  endGoogleSession();
  return data.place;
}

/** Has the worker confirmed Google is configured this session? Returns
 *  null until we've actually called the proxy; useful for tag UI. */
export const isGoogleAvailable = (): boolean | null => googleAvailable;

/** Tile-source config for the Leaflet map in the location picker. */
export function mapTileConfig() {
  if (hasMapbox()) {
    return {
      url: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
      attribution: '© Mapbox © OpenStreetMap',
      maxZoom: 20,
      tileSize: 512,
      zoomOffset: -1,
    };
  }
  return {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap',
    maxZoom: 19,
    tileSize: 256,
    zoomOffset: 0,
  };
}

export interface GeocodeHit {
  /** Short label like "Little Valley Soccer Fields". */
  label: string;
  /** Full address like "2200 S 3000 E, Washington, UT 84780". */
  address: string;
  /** lat/lon may be NaN when this hit came from Google's autocomplete
   *  (which doesn't return coords). In that case `placeId` is set and
   *  the caller must call geocodeResolve(placeId) to fetch coords. */
  lat: number;
  lon: number;
  placeId?: string;
}

/**
 * Resolve a hit that doesn't yet have coords (Google predictions). Uses
 * Google Place Details under the current session token. Returns a fully-
 * filled GeocodeHit. No-op for hits that already have lat/lon.
 */
export async function geocodeResolve(hit: GeocodeHit): Promise<GeocodeHit | null> {
  if (typeof hit.lat === 'number' && !Number.isNaN(hit.lat)) return hit;
  if (!hit.placeId) return null;
  const detail = await googleDetails(hit.placeId);
  if (!detail) return null;
  return {
    label: detail.name || hit.label,
    address: detail.address || hit.address,
    lat: detail.lat,
    lon: detail.lon,
  };
}

/**
 * Forward geocode (search). Tries Google (via worker proxy) → Mapbox →
 * Nominatim, falling forward at each step. Google has the best coverage
 * for new/local venues (soccer fields, gyms) that Mapbox and OSM miss.
 *
 * Google returns predictions WITHOUT coordinates — caller must call
 * geocodeResolve(placeId) when the user picks a row, which hits Google
 * Place Details under the same session token for sessioned billing.
 */
export async function geocodeForward(
  q: string,
  opts?: { proximity?: { lat: number; lon: number }; viewport?: { west: number; south: number; east: number; north: number } },
): Promise<GeocodeHit[]> {
  const query = q.trim();
  if (query.length < 2) return [];

  // Google path — bring up its own session token if not already.
  if (hasNotifyProxy() && googleAvailable !== false) {
    if (!googleSessionToken) startGoogleSession();
    const predictions = await googleAutocomplete(query, opts?.proximity);
    if (predictions && predictions.length > 0) {
      // Google predictions don't carry coords. We use placeId as a
      // sentinel in lat/lon (0/0) and the consumer must call
      // geocodeResolve() before saving. The label/address are real.
      return predictions.map(p => ({
        label: p.label,
        address: p.address,
        lat: NaN,
        lon: NaN,
        placeId: p.placeId,
      }));
    }
    // If Google returned empty (or unavailable), fall through to Mapbox/OSM.
  }

  if (hasMapbox()) {
    const params: string[] = [
      `access_token=${MAPBOX_TOKEN}`,
      'country=us,ca',
      'types=poi,address,place,locality,neighborhood',
      'limit=8',
      'autocomplete=true',
    ];
    if (opts?.proximity) {
      params.push(`proximity=${opts.proximity.lon},${opts.proximity.lat}`);
    }
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params.join('&')}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn('Mapbox geocode failed', res.status);
        return [];
      }
      const data: any = await res.json();
      return (data.features || []).map((f: any) => ({
        label: f.text || f.place_name,
        address: f.place_name || '',
        lon: f.center?.[0],
        lat: f.center?.[1],
      })).filter((h: GeocodeHit) => typeof h.lat === 'number');
    } catch (err) {
      console.warn('Mapbox geocode threw', err);
      return [];
    }
  }

  // Nominatim fallback. viewbox without bounded=1 means PREFER local,
  // but still surface far hits for searches with no local match.
  let viewboxParam = '';
  if (opts?.viewport) {
    viewboxParam = `&viewbox=${opts.viewport.west},${opts.viewport.north},${opts.viewport.east},${opts.viewport.south}`;
  } else if (opts?.proximity) {
    const span = 0.75;
    const c = opts.proximity;
    viewboxParam = `&viewbox=${c.lon - span},${c.lat + span},${c.lon + span},${c.lat - span}`;
  }
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=8&countrycodes=us,ca${viewboxParam}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) return [];
    const data: any[] = await res.json();
    return data.map((d) => {
      const a = d.address || {};
      const parts = [
        a.amenity || a.leisure || a.shop || a.tourism || a.building || a.house_name,
        [a.house_number, a.road].filter(Boolean).join(' '),
        a.city || a.town || a.village || a.hamlet || a.suburb,
        a.state_code || a.state,
      ].filter(Boolean);
      return {
        label: parts.length > 0 ? parts.join(', ') : d.display_name,
        address: d.display_name as string,
        lat: parseFloat(d.lat),
        lon: parseFloat(d.lon),
      };
    });
  } catch (err) {
    console.warn('Nominatim geocode threw', err);
    return [];
  }
}

/** Reverse geocode (coords → label + address). Same provider rules. */
export async function geocodeReverse(lat: number, lon: number): Promise<GeocodeHit | null> {
  if (hasMapbox()) {
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?access_token=${MAPBOX_TOKEN}&types=poi,address,place&limit=1`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data: any = await res.json();
      const f = data.features?.[0];
      if (!f) return null;
      return {
        label: f.text || f.place_name,
        address: f.place_name || '',
        lat,
        lon,
      };
    } catch (err) {
      console.warn('Mapbox reverse threw', err);
      return null;
    }
  }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) return null;
    const data: any = await res.json();
    const a = data.address || {};
    const venue = a.amenity || a.leisure || a.sports_centre || a.tourism || a.building;
    return {
      label: venue || (data.display_name || '').split(',')[0],
      address: data.display_name || '',
      lat,
      lon,
    };
  } catch (err) {
    console.warn('Nominatim reverse threw', err);
    return null;
  }
}

export interface LocationLink {
  name: string;
  address?: string;
  lat?: number;
  lon?: number;
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
}

/** Build the best-available system-maps URL for a location. */
export function mapsUrl(loc: LocationLink): string {
  const hasCoords = typeof loc.lat === 'number' && typeof loc.lon === 'number';
  const label = encodeURIComponent(loc.name || loc.address || '');
  if (isIos()) {
    if (hasCoords) {
      // ll= drops the pin at exact coords; q= sets the title shown in the
      // pin callout. Both supported by Apple Maps universal links.
      return `https://maps.apple.com/?ll=${loc.lat},${loc.lon}&q=${label}`;
    }
    return `https://maps.apple.com/?q=${label}`;
  }
  if (hasCoords) {
    // Coord-aware Google Maps URL. query takes "lat,lon" verbatim;
    // query_place_id is optional but anchors the result.
    return `https://www.google.com/maps/search/?api=1&query=${loc.lat}%2C${loc.lon}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${label}`;
}

/**
 * URL for the OSM iframe embed. Free, no API key. Builds a small bbox
 * around the point so the map shows the venue with some context.
 */
export function osmEmbedUrl(lat: number, lon: number, zoom: number = 16): string {
  // A small constant bbox around the marker — visually ~600m across at
  // zoom 16. The map widget recomputes its own zoom from the bbox.
  const span = 0.005; // ~550m latitude span
  const west = lon - span;
  const east = lon + span;
  const south = lat - span;
  const north = lat + span;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${west}%2C${south}%2C${east}%2C${north}&layer=mapnik&marker=${lat}%2C${lon}`;
}

/** Permalink that opens OSM in a new tab centered on the marker. */
export function osmLargeUrl(lat: number, lon: number, zoom: number = 16): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`;
}
