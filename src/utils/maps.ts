// @ts-nocheck
/**
 * Maps helpers — used for both opening the system maps app (Apple Maps
 * on iOS, Google Maps elsewhere) AND for rendering an embedded OSM
 * preview while picking a location.
 *
 * When we have coordinates, deep-links use them directly so the system
 * maps app lands on the right pin first try. Free-text fallback only
 * kicks in for legacy events that pre-date coordinate capture.
 */

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
