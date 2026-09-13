// Auto-generated opponent crest. When we don't have a logo URL for the
// other team (which is basically always — clubs upload their own but
// not each opponent's), synthesize a color+initials badge from the
// opponent name so the score-line hero doesn't look empty.
//
// Deterministic: same opponent name always produces the same color.
// Uses a small preset palette that reads on both dark + light themes.

import React from 'react';

interface Props {
  name: string;
  size?: number;
  className?: string;
}

// Hand-picked palette — jersey-like colors that all have enough
// contrast against white/black text at ~40% opacity backgrounds.
const CREST_COLORS = [
  { bg: '#1e40af', text: '#fff' }, // blue
  { bg: '#166534', text: '#fff' }, // green
  { bg: '#7c2d12', text: '#fff' }, // rust
  { bg: '#5b21b6', text: '#fff' }, // purple
  { bg: '#0f766e', text: '#fff' }, // teal
  { bg: '#a16207', text: '#fff' }, // amber
  { bg: '#be123c', text: '#fff' }, // rose
  { bg: '#3730a3', text: '#fff' }, // indigo
];

function hashName(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  // First letter of first word + first letter of last word (skips
  // middle words like "of the" that don't help identify the club).
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const OpponentCrest: React.FC<Props> = ({ name, size = 48, className }) => {
  const trimmed = String(name || '').trim() || 'Opponent';
  const initials = initialsFrom(trimmed);
  const color = CREST_COLORS[hashName(trimmed.toLowerCase()) % CREST_COLORS.length];
  const fontSize = Math.max(10, Math.round(size * 0.36));

  return (
    <div
      className={`inline-flex items-center justify-center rounded-full shadow-md ring-2 ring-white/15 shrink-0 ${className || ''}`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${color.bg}, ${color.bg}dd)`,
        color: color.text,
        fontSize,
        fontWeight: 900,
        letterSpacing: '0.02em',
      }}
      aria-label={`${trimmed} crest`}
    >
      {initials}
    </div>
  );
};

export default OpponentCrest;
