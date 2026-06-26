// @ts-nocheck
import { useEffect } from 'react';

/**
 * Reads the active club's brandColor (single hex) and writes the
 * full shade family to document.documentElement as CSS custom
 * properties, so any surface using bg-brand-primary / -soft / -dim
 * / -deep re-tints automatically when the club admin saves a new
 * color in /club/branding.
 *
 * Five derived shades from one input:
 *   primary       — the base color (CTAs)
 *   primary-hov   — ~18% brighter (hover state on CTAs)
 *   primary-soft  — ~45% brighter (text accents, kicker labels)
 *   primary-dim   — ~45% darker  (shadow backgrounds, quiet fills)
 *   primary-deep  — ~75% darker  (gradient ends, faintest fills)
 *
 * Foreground (text on top of the primary fill) stays white unless
 * the brand color is light enough to need dark text. The color
 * picker rejects too-light colors anyway (contrast guard in
 * ClubBrandingCard), so foreground stays white.
 *
 * Multi-club SaaS hook: every club's clubs/{id}.brandColor maps
 * to the entire crimson-styled UI surface area without any
 * code branches.
 */

const DEFAULTS = {
  primary:      '200 32 44',
  hov:          '229 72 93',
  soft:         '241 114 130',
  dim:          '116 25 32',
  deep:         '64 10 16',
};

function parseHexToRgb(hex: string | null | undefined): { r: number; g: number; b: number } | null {
  if (!hex || typeof hex !== 'string') return null;
  const c = hex.trim().replace(/^#/, '');
  const re6 = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
  const re3 = /^([0-9a-f])([0-9a-f])([0-9a-f])$/i;
  const m6 = c.match(re6);
  if (m6) return { r: parseInt(m6[1], 16), g: parseInt(m6[2], 16), b: parseInt(m6[3], 16) };
  const m3 = c.match(re3);
  if (m3) return {
    r: parseInt(m3[1] + m3[1], 16),
    g: parseInt(m3[2] + m3[2], 16),
    b: parseInt(m3[3] + m3[3], 16),
  };
  return null;
}

const triplet = ({ r, g, b }: { r: number; g: number; b: number }) => `${r} ${g} ${b}`;

const brighten = (rgb: { r: number; g: number; b: number }, factor: number) => ({
  r: Math.min(255, Math.round(rgb.r + (255 - rgb.r) * factor)),
  g: Math.min(255, Math.round(rgb.g + (255 - rgb.g) * factor)),
  b: Math.min(255, Math.round(rgb.b + (255 - rgb.b) * factor)),
});

const darken = (rgb: { r: number; g: number; b: number }, factor: number) => ({
  r: Math.max(0, Math.round(rgb.r * (1 - factor))),
  g: Math.max(0, Math.round(rgb.g * (1 - factor))),
  b: Math.max(0, Math.round(rgb.b * (1 - factor))),
});

export function useApplyClubBrand(brandColor?: string | null): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const rgb = parseHexToRgb(brandColor);
    if (rgb) {
      root.style.setProperty('--brand-primary',      triplet(rgb));
      root.style.setProperty('--brand-primary-hov',  triplet(brighten(rgb, 0.18)));
      root.style.setProperty('--brand-primary-soft', triplet(brighten(rgb, 0.45)));
      root.style.setProperty('--brand-primary-dim',  triplet(darken(rgb, 0.45)));
      root.style.setProperty('--brand-primary-deep', triplet(darken(rgb, 0.75)));
    } else {
      root.style.setProperty('--brand-primary',      DEFAULTS.primary);
      root.style.setProperty('--brand-primary-hov',  DEFAULTS.hov);
      root.style.setProperty('--brand-primary-soft', DEFAULTS.soft);
      root.style.setProperty('--brand-primary-dim',  DEFAULTS.dim);
      root.style.setProperty('--brand-primary-deep', DEFAULTS.deep);
    }
  }, [brandColor]);
}

/** Returns true if the hex is light enough that the dark theme can't
 *  read white text on it. Use to reject the color BEFORE saving in
 *  the picker. Threshold ~0.6 relative luminance — anything brighter
 *  is roughly the "pastel yellow / pale blue" zone. */
export function brandColorIsTooLight(hex: string | null | undefined): boolean {
  const rgb = parseHexToRgb(hex);
  if (!rgb) return false;
  // sRGB relative luminance (W3C formula, simplified — accurate
  // enough for the picker contrast guard).
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  return L > 0.55;
}
