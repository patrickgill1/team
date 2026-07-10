// Kit colors — hex-first storage with legacy name resolution.
//
// Team Settings now uses a native <input type="color"> so coaches
// pick an exact color instead of typing "Black" and hoping the
// downstream card renders something sensible. Storage shape:
// team.homeKitColor / team.awayKitColor holds a hex string
// (e.g. "#0f172a"). Legacy text values ("Red", "Navy") still work
// on READ via the name → hex map below so historical teams don't
// suddenly show blank swatches.
//
// `normalizeKit()` returns a hex or undefined. Callers render a
// swatch when it's defined, plain circle otherwise.

/** Named-color fallback for legacy free-text kit values. Kept in
 *  sync with the shortlist of colors most youth teams actually
 *  wear. Accents like "Navy/Yellow stripe" match the first token. */
const NAMED_KIT_COLORS: Record<string, string> = {
  red: '#ef4444', crimson: '#dc2626', maroon: '#7f1d1d',
  orange: '#f97316',
  yellow: '#facc15', gold: '#eab308',
  green: '#22c55e', emerald: '#10b981',
  blue: '#3b82f6', navy: '#1e3a8a', sky: '#0ea5e9', royal: '#1d4ed8',
  teal: '#14b8a6', cyan: '#06b6d4',
  purple: '#8b5cf6', violet: '#7c3aed',
  pink: '#ec4899',
  black: '#0f172a', charcoal: '#1e293b',
  white: '#f8fafc', bone: '#f5f5f4', cream: '#fefce8',
  grey: '#94a3b8', gray: '#94a3b8',
  silver: '#cbd5e1',
};

/** Normalize a stored kit color value (hex OR legacy name) to hex.
 *  Returns undefined when the value is empty or unrecognized. */
export function normalizeKit(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  // Already hex (3 or 6 char, with or without leading #)
  const hexMatch = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) return `#${hexMatch[1].toLowerCase()}`;
  // Legacy name — take the first color word ("Navy/Yellow stripe" → "navy")
  const key = s.toLowerCase().split(/[\/\s]+/)[0];
  return NAMED_KIT_COLORS[key];
}

/** Human-readable name for a hex value, if it matches one of our
 *  named colors. Falls back to the hex string. Used for accessible
 *  labels on kit swatches. */
export function kitColorLabel(raw?: string | null): string {
  if (!raw) return '';
  const hex = normalizeKit(raw);
  if (!hex) return raw.trim();
  const name = Object.entries(NAMED_KIT_COLORS).find(([, v]) => v === hex)?.[0];
  return name ? name[0].toUpperCase() + name.slice(1) : hex.toUpperCase();
}

/** WCAG-friendly text color (black or white) that reads on top of
 *  the given kit hex. Used when we render text INSIDE the swatch
 *  (e.g. "H" or the abbreviated day). */
export function kitTextColor(hex?: string | null): string {
  const clean = normalizeKit(hex);
  if (!clean) return '#ffffff';
  const r = parseInt(clean.slice(1, 3), 16);
  const g = parseInt(clean.slice(3, 5), 16);
  const b = parseInt(clean.slice(5, 7), 16);
  // Relative luminance per WCAG.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? '#0f172a' : '#ffffff';
}
