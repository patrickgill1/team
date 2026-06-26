// @ts-nocheck
import { useEffect } from 'react';

/**
 * Read the active club's brandColor and apply it as CSS custom
 * properties on document.documentElement, so any surface using
 * `bg-brand-primary` / `text-brand-primary` / etc. (Tailwind alias
 * for var(--brand-primary)) picks up the club's color automatically.
 *
 * Falls back to the GoalKickr crimson defaults declared in
 * src/index.css `:root` if the club's color is missing or unparseable.
 *
 * Multi-club SaaS theming hook: each club's clubs/{id}.brandColor
 * (hex string like "#1F4E8E") overrides --brand-primary at runtime.
 * This makes new clubs' primary CTAs match their own brand without
 * any code change.
 *
 * Usage (mount once near the top of the tree, after the active
 * club id is known):
 *
 *   useApplyClubBrand(selectedTeam?.clubId, club?.brandColor);
 */

const DEFAULT_PRIMARY = '200 32 44';        // crimson-600
const DEFAULT_PRIMARY_HOV = '229 72 93';    // crimson-500
const DEFAULT_PRIMARY_DIM = '116 25 32';    // crimson-900

function parseHexToRgbTriplet(hex: string | null | undefined): string | null {
  if (!hex || typeof hex !== 'string') return null;
  const cleaned = hex.trim().replace(/^#/, '');
  const re3 = /^([0-9a-f])([0-9a-f])([0-9a-f])$/i;
  const re6 = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
  let r: number, g: number, b: number;
  const m6 = cleaned.match(re6);
  if (m6) {
    r = parseInt(m6[1], 16);
    g = parseInt(m6[2], 16);
    b = parseInt(m6[3], 16);
  } else {
    const m3 = cleaned.match(re3);
    if (!m3) return null;
    r = parseInt(m3[1] + m3[1], 16);
    g = parseInt(m3[2] + m3[2], 16);
    b = parseInt(m3[3] + m3[3], 16);
  }
  return `${r} ${g} ${b}`;
}

/** Derive a darker dim variant by multiplying each channel by 0.55. */
function dim(triplet: string): string {
  const [r, g, b] = triplet.split(' ').map(Number);
  return `${Math.round(r * 0.55)} ${Math.round(g * 0.55)} ${Math.round(b * 0.55)}`;
}

/** Derive a brighter hover variant by lifting each channel ~12%. */
function brighten(triplet: string): string {
  const [r, g, b] = triplet.split(' ').map(Number);
  const lift = (v: number) => Math.min(255, Math.round(v + (255 - v) * 0.18));
  return `${lift(r)} ${lift(g)} ${lift(b)}`;
}

export function useApplyClubBrand(brandColor?: string | null): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const primary = parseHexToRgbTriplet(brandColor);
    if (primary) {
      root.style.setProperty('--brand-primary', primary);
      root.style.setProperty('--brand-primary-hov', brighten(primary));
      root.style.setProperty('--brand-primary-dim', dim(primary));
    } else {
      // Restore defaults — important when switching from a custom-brand
      // club back to one without a brandColor set.
      root.style.setProperty('--brand-primary', DEFAULT_PRIMARY);
      root.style.setProperty('--brand-primary-hov', DEFAULT_PRIMARY_HOV);
      root.style.setProperty('--brand-primary-dim', DEFAULT_PRIMARY_DIM);
    }
  }, [brandColor]);
}
