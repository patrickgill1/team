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

const GEO_CACHE_KEY = 'weatherGeoCache.v1';
const FORECAST_CACHE_PREFIX = 'weatherForecast.v1:';

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
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('geocode failed');
    const j = await r.json();
    const hit = j?.results?.[0];
    const result: GeoResult | null = hit ? { lat: hit.latitude, lon: hit.longitude, name: hit.name } : null;
    cache[key] = result;
    setGeoCache(cache);
    return result;
  } catch {
    cache[key] = null;
    setGeoCache(cache);
    return null;
  }
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

export async function getWeatherForEvent(location: string, date: Date): Promise<WeatherSummary | null> {
  if (!location || !date) return null;
  const eventDay = new Date(date);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((eventDay.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0 || diffDays > 15) return null; // forecast horizon

  const geo = await geocodeLocation(location);
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
