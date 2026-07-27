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

// 2026-07-15: swapped the 8-color rainbow palette (fuchsia, violet,
// pink, sky) for a 4-color solid palette drawn from on-brand tokens.
// Patrick's design rule: subtle + purposeful + same-family = keep;
// opposite ends of the color wheel = kill. The rainbow palette was
// the highest-surface-area rainbow in the app (touches Chat, ReadBy,
// People, Roster, MessageBubble). The replacement uses solid brand
// hues that flip cleanly per theme:
//   brand-primary  = product accent (cyan in the default theme)
//   amber-500      = award family, warm
//   emerald-600    = pitch family, fresh
//   slate-500      = muted default, neutral
// Solid colors instead of gradients; white initials on all four
// have enough contrast in both light and dark themes.
const PALETTE = [
  'bg-brand-primary',
  'bg-amber-500',
  'bg-emerald-600',
  'bg-slate-500',
];

export function avatarGradientFor(name: string): string {
  return PALETTE[hashName(name) % PALETTE.length];
}

interface Props {
  name: string;
  photoUrl?: string;
  size?: number; // pixels; default 28 (w-7 h-7). Sets width.
  /** Optional pixel height. Defaults to `size` (square). Pass a
   *  larger value than size to get a portrait-aspect card crop,
   *  which fits phone-shot faces better than a hard square/circle. */
  height?: number;
  className?: string;
  /** 'circle' (default) = rounded-full medallion; 'card' = rounded
   *  square/portrait tile. The card shape carves only corners from
   *  the source photo instead of chopping the top + sides like a
   *  circle does, so portrait selfies keep their face intact. */
  shape?: 'circle' | 'card';
  /** CSS object-position for the underlying <img>. Defaults tuned per
   *  shape: 50% 20% for cards (face-sweet-spot for portrait crops),
   *  50% 25% for circles (splits center vs top so both centered
   *  selfies and coach-shot portraits survive). Prior code hardcoded
   *  object-top which sacrificed centered selfies. */
  objectPosition?: string;
  /** How the photo fills the crop box. 'cover' (default) fills and
   *  crops; 'contain' fits the whole photo with letterbox on the
   *  short side. Use 'contain' when the surface must never clip the
   *  face (e.g. the PlayerAvatarRow filter row on Media page). */
  fit?: 'cover' | 'contain';
}

const RosterAvatar: React.FC<Props> = ({
  name,
  photoUrl,
  size = 28,
  height,
  className = '',
  shape = 'circle',
  objectPosition,
  fit = 'cover',
}) => {
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const initial = (name || '?').charAt(0).toUpperCase();
  const gradient = avatarGradientFor(name);
  const w = size;
  const h = height ?? size;
  // Use the smaller dimension for the initials letter so the "L" in
  // a tall portrait card doesn't blow up disproportionately.
  const fontSize = Math.max(10, Math.round(Math.min(w, h) * 0.42));
  const showPhoto = !!photoUrl && !photoFailed;
  const shapeClass = shape === 'card' ? 'rounded-xl' : 'rounded-full';
  // Card crops handle portrait phone shots by trimming corners only,
  // so pull the framing slightly higher (20%) to guarantee the face
  // sits above the vertical midline. Circles clip more aggressively
  // so 25% is a safer split for centered vs top-framed sources.
  const defaultObjPos = shape === 'card' ? '50% 20%' : '50% 25%';
  const objPos = objectPosition ?? defaultObjPos;

  return (
    <span
      className={`relative inline-flex items-center justify-center shrink-0 overflow-hidden ${shapeClass} ${gradient} ${className}`}
      style={{ width: w, height: h }}
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
          className={`absolute inset-0 w-full h-full transition-opacity duration-300 ease-out ${fit === 'contain' ? 'object-contain' : 'object-cover'}`}
          style={{ opacity: photoLoaded ? 1 : 0, objectPosition: objPos }}
        />
      )}
    </span>
  );
};

export default RosterAvatar;
