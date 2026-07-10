// Lightweight weather lookup using Open-Meteo (no API key).
// 1. Geocode a free-text location string -> { lat, lon } (cached in sessionStorage).
// 2. Fetch daily forecast and pick the closest day to the event date (only useful within ~16 days).

export interface WeatherSummary {
  tempMaxF: number;
  tempMinF: number;
  precipChance: number; // 0-100
  code: number;         // WMO weather code
  icon: string;         // emoji
  label: string;        // human readable
}

interface GeoResult { lat: number; lon: number; name: string; }

// St-George-fallback removed 2026-07-10: every non-St-George team was
// silently getting a St. George forecast whenever the location string
// didn't geocode. Now: no coords → no forecast, no forecast row. Better
// to show nothing than a wrong number that misleads the coach's
// rain-out decision.

const GEO_CACHE_KEY = 'weatherGeoCache.v3';
const FORECAST_CACHE_PREFIX = 'weatherForecast.v3:';

function getGeoCache(): Record<string, GeoResult | null> {
  try { return JSON.parse(sessionStorage.getItem(GEO_CACHE_KEY) || '{}'); } catch { return {}; }
}
function setGeoCache(c: Record<string, GeoResult | null>) {
  try { sessionStorage.setItem(GEO_CACHE_KEY, JSON.stringify(c)); } catch {}
}

export async function geocodeLocation(location: string): Promise<GeoResult | null> {
  const key = location.trim().toLowerCase();
  if (!key) return null;
  const cache = getGeoCache();
  if (key in cache) return cache[key];

  // Build a list of progressively looser query candidates so generic field/park
  // names like "Smith Field" still resolve when "Smith Field, Greenwich CT" would.
  const original = location.trim();
  const candidates: string[] = [];
  const push = (s?: string | null) => {
    const v = (s || '').trim().replace(/\s+/g, ' ');
    if (v && !candidates.includes(v)) candidates.push(v);
  };
  push(original);
  // After each comma (e.g. "Field 4, Greenwich Town Park, CT" -> tries each tail)
  const parts = original.split(',').map(p => p.trim()).filter(Boolean);
  for (let i = 1; i < parts.length; i++) push(parts.slice(i).join(', '));
  // Strip generic venue prefix ("Field 4 at Smith Park" -> "Smith Park")
  const atSplit = original.split(/\s+at\s+/i);
  if (atSplit.length > 1) push(atSplit.slice(1).join(' at '));
  // Strip leading "Field N", "Court N", "Pitch N"
  push(original.replace(/^(field|court|pitch|rink|gym|diamond)\s*\d+\s*[-,]?\s*/i, ''));
  // Last 3-4 words as a final hail-mary (often "Town State")
  const words = original.split(/\s+/);
  if (words.length > 3) push(words.slice(-3).join(' '));
  if (words.length > 4) push(words.slice(-4).join(' '));

  for (const q of candidates) {
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      const hit = j?.results?.[0];
      if (hit?.latitude != null && hit?.longitude != null) {
        const result: GeoResult = { lat: hit.latitude, lon: hit.longitude, name: hit.name };
        if (q !== original) {
          // eslint-disable-next-line no-console
          console.info(`[weather] geocoded "${original}" via fallback "${q}" -> ${hit.name}`);
        }
        cache[key] = result;
        setGeoCache(cache);
        return result;
      }
    } catch {
      // try next candidate
    }
  }
  // eslint-disable-next-line no-console
  console.warn(`[weather] could not geocode "${original}" — no forecast will render.`);
  cache[key] = null;
  setGeoCache(cache);
  return null;
}

// WMO weather code -> emoji + label
function describeCode(code: number): { icon: string; label: string } {
  if (code === 0) return { icon: '☀️', label: 'Clear' };
  if (code <= 2) return { icon: '🌤️', label: 'Mostly clear' };
  if (code === 3) return { icon: '☁️', label: 'Cloudy' };
  if (code >= 45 && code <= 48) return { icon: '🌫️', label: 'Fog' };
  if (code >= 51 && code <= 57) return { icon: '🌦️', label: 'Drizzle' };
  if (code >= 61 && code <= 67) return { icon: '🌧️', label: 'Rain' };
  if (code >= 71 && code <= 77) return { icon: '🌨️', label: 'Snow' };
  if (code >= 80 && code <= 82) return { icon: '🌧️', label: 'Showers' };
  if (code >= 85 && code <= 86) return { icon: '🌨️', label: 'Snow showers' };
  if (code >= 95) return { icon: '⛈️', label: 'Thunderstorm' };
  return { icon: '🌡️', label: 'Weather' };
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Fetch a forecast for an event.
 *
 * Coord-first: if the event has locationCoords stamped by the
 * onboarding wizard or EventForm's autocomplete, we use those
 * directly and skip geocoding entirely — cheapest + most accurate
 * path. If coords aren't available (legacy event or free-text-only
 * location), fall back to geocoding the location string.
 *
 * Returns null when we can't determine WHERE the event actually is.
 * Callers should render "no weather" (silent) rather than confidently
 * showing a wrong forecast.
 */
export async function getWeatherForEvent(
  location: string,
  date: Date,
  coords?: { lat?: number | null; lon?: number | null } | null,
): Promise<WeatherSummary | null> {
  if (!date) return null;
  const eventDay = new Date(date);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((eventDay.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0 || diffDays > 15) return null; // forecast horizon

  let geo: GeoResult | null = null;
  if (coords && typeof coords.lat === 'number' && typeof coords.lon === 'number') {
    geo = { lat: coords.lat, lon: coords.lon, name: location || 'Event location' };
  } else if (location) {
    geo = await geocodeLocation(location);
  }
  if (!geo) return null;

  const cacheKey = `${FORECAST_CACHE_PREFIX}${geo.lat.toFixed(2)},${geo.lon.toFixed(2)}`;
  let forecast: any = null;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      // expire after 6 hours
      if (Date.now() - parsed.fetchedAt < 6 * 3600_000) forecast = parsed.data;
    }
  } catch {}

  if (!forecast) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto&forecast_days=16`;
      const r = await fetch(url);
      if (!r.ok) return null;
      forecast = await r.json();
      try { sessionStorage.setItem(cacheKey, JSON.stringify({ data: forecast, fetchedAt: Date.now() })); } catch {}
    } catch {
      return null;
    }
  }

  const days: string[] = forecast?.daily?.time || [];
  const target = ymd(eventDay);
  const idx = days.indexOf(target);
  if (idx < 0) return null;

  const code = forecast.daily.weather_code?.[idx] ?? 0;
  const { icon, label } = describeCode(code);
  return {
    tempMaxF: Math.round(forecast.daily.temperature_2m_max?.[idx] ?? 0),
    tempMinF: Math.round(forecast.daily.temperature_2m_min?.[idx] ?? 0),
    precipChance: Math.round(forecast.daily.precipitation_probability_max?.[idx] ?? 0),
    code,
    icon,
    label,
  };
}
