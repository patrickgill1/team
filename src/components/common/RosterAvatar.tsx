import React, { useState } from 'react';

// Initials-instant avatar with photo fade-over on load. Eliminates
// the 'profile pics pop in late' cascade in roster lists by ALWAYS
// rendering the colored initials circle as the base layer; the
// photo <img> overlays on top with opacity 0 and fades in only after
// it finishes loading. If the photo never resolves (no url, 404,
// fails to decode), the initials stay visible — no broken state.
//
// Pattern source: feedback memory 'atomic-render-over-skeletons.md'.
// Patrick 2026-06-21: 'the profile pics in events pop in later'.
//
// Pass `photoUrl=undefined` when there's no photo source at all to
// skip the img element entirely.

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

// Same palette as event-detail's rsvpAvatarColor + chat avatar
// palette, lifted up so every avatar in the app picks from the same
// pot and the look stays consistent.
const PALETTE = [
  'from-rose-400 to-rose-600',
  'from-amber-400 to-orange-600',
  'from-emerald-400 to-emerald-600',
  'from-brand-primary-soft to-brand-primary',
  'from-violet-400 to-violet-600',
  'from-fuchsia-400 to-pink-600',
  'from-brand-primary-soft to-surface-tint',
  'from-sky-400 to-sky-600',
];

export function avatarGradientFor(name: string): string {
  return PALETTE[hashName(name) % PALETTE.length];
}

interface Props {
  name: string;
  photoUrl?: string;
  size?: number; // pixels; default 28 (w-7 h-7)
  className?: string;
}

const RosterAvatar: React.FC<Props> = ({ name, photoUrl, size = 28, className = '' }) => {
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const initial = (name || '?').charAt(0).toUpperCase();
  const gradient = avatarGradientFor(name);
  const fontSize = Math.max(10, Math.round(size * 0.42));
  const showPhoto = !!photoUrl && !photoFailed;

  return (
    <span
      className={`relative inline-flex items-center justify-center rounded-full shrink-0 overflow-hidden bg-gradient-to-br ${gradient} ${className}`}
      style={{ width: size, height: size }}
      aria-label={name}
    >
      <span
        className="font-bold text-white"
        style={{ fontSize, lineHeight: 1 }}
      >
        {initial}
      </span>
      {showPhoto && (
        <img
          src={photoUrl}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          onLoad={() => setPhotoLoaded(true)}
          onError={() => setPhotoFailed(true)}
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ease-out"
          style={{ opacity: photoLoaded ? 1 : 0 }}
        />
      )}
    </span>
  );
};

export default RosterAvatar;
