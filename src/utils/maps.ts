// @ts-nocheck
/**
 * Maps helpers — used for opening the system maps app (Apple/Google),
 * rendering an OSM-embed preview, and for the Mapbox-backed picker.
 *
 * Mapbox is opt-in via REACT_APP_MAPBOX_TOKEN. When the token is set,
 * the picker uses Mapbox tiles + geocoder (better venue coverage than
 * OSM — e.g. local soccer fields that aren't in OpenStreetMap). When
 * the token is missing, everything gracefully degrades to OSM /
 * Nominatim, so the app keeps working with zero setup.
 */

export const MAPBOX_TOKEN: string = (process.env.REACT_APP_MAPBOX_TOKEN || '').trim();
export const hasMapbox = (): boolean => MAPBOX_TOKEN.length > 0;

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
  lat: number;
  lon: number;
}

/**
 * Forward geocode (search). Mapbox when token present (way better
 * venue coverage), Nominatim fallback. `proximity` biases results
 * toward a point; both providers accept it.
 */
export async function geocodeForward(
  q: string,
  opts?: { proximity?: { lat: number; lon: number }; viewport?: { west: number; south: number; east: number; north: number } },
): Promise<GeocodeHit[]> {
  const query = q.trim();
  if (query.length < 2) return [];

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
