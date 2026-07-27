// Chrome-light card used inside every Netflix-style row on the
// Highlights tab. Deliberately minimal: just the poster, a hover-only
// play triangle, and a bottom label overlay with the tagged player's
// avatar + name + secondary meta. No like/view/share/kebab/tag chips
// - the reel is where those live.

import React from 'react';
import type { PlayerMedia as PlayerMediaType, Player } from '../../types';
import { posterFor } from '../../utils/mediaPoster';
import RosterAvatar from '../common/RosterAvatar';

interface Props {
  clip: PlayerMediaType;
  players?: Player[];
  onOpen: () => void;
  // When true, card stretches full-width instead of the fixed
  // Netflix-row width. Used by the "filters active" flat list view.
  fullWidth?: boolean;
  // Coach-only affordance. When provided, a small ghost "Feature this"
  // pill floats on the top-right corner of the card. Tapping it fires
  // this callback (which persists featuredByCoach: true) WITHOUT
  // triggering the underlying onOpen. Parent decides which clips get
  // this — the parent already knows who is a coach and which clips
  // are eligible; the card just renders what it's told.
  onFeature?: () => void;
}

/** Warm, human label for the coach-tagged momentType. Kept in a helper
 *  so hero + card + reel eventually share it. */
function momentLabel(kind?: string): string | null {
  if (kind === 'goal') return 'Goal';
  if (kind === 'assist') return 'Assist';
  if (kind === 'big_play') return 'Big play';
  return null;
}

/** Short "Sep 12" style date, safe against Firestore Timestamps that
 *  slipped through unconverted. */
function shortDate(v: any): string {
  const d: Date = v?.toDate ? v.toDate() : v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Resolve the "primary tagged player" for this clip. Priority:
 *  1. goalScorerId (this clip is celebrating a goal by that kid)
 *  2. playerId (the media's owning player)
 *  3. first entry in taggedPlayerIds
 *  Returns the resolved Player if found in the roster, otherwise null. */
export function primaryTaggedPlayer(
  clip: PlayerMediaType,
  players?: Player[],
): Player | null {
  if (!players || players.length === 0) return null;
  const ids: string[] = [];
  if (clip.goalScorerId) ids.push(clip.goalScorerId);
  if (clip.playerId) ids.push(clip.playerId);
  if (Array.isArray(clip.taggedPlayerIds)) {
    for (const id of clip.taggedPlayerIds) if (id) ids.push(id);
  }
  for (const id of ids) {
    const found = players.find(p => p.id === id);
    if (found) return found;
  }
  return null;
}

/** Resolve the "who is this clip really about?" name. For goal clips
 *  where the uploader is the parent and the goalScorerId points at a
 *  different kid, prefer the actual scorer - that's the person the
 *  card is celebrating. Falls back to the stored playerName. */
function displayName(clip: PlayerMediaType, players?: Player[]): string {
  const tagged = primaryTaggedPlayer(clip, players);
  if (tagged?.name) return tagged.name;
  return clip.playerName || 'Highlight';
}

const HighlightCardLite: React.FC<Props> = ({ clip, players, onOpen, fullWidth, onFeature }) => {
  const [featuring, setFeaturing] = React.useState(false);
  const handleFeature = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!onFeature || featuring) return;
    setFeaturing(true);
    try {
      onFeature();
    } finally {
      // The parent replaces the clip out from under us on success
      // (featuredByCoach flips to true and the ghost button is no
      // longer rendered), so leaving the busy flag on is safe. Reset
      // after a tick anyway in case the parent write throws and the
      // clip stays visible.
      setTimeout(() => setFeaturing(false), 800);
    }
  };

  const poster = posterFor(clip);
  const name = displayName(clip, players);
  const tagged = primaryTaggedPlayer(clip, players);
  const secondary = momentLabel(clip.momentType) || shortDate(clip.createdAt);

  const widthClasses = fullWidth
    ? 'w-full'
    : 'w-[260px] md:w-[320px] snap-start shrink-0';

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative ${widthClasses} aspect-video rounded-xl overflow-hidden bg-zinc-950 ring-1 ring-line-default/10 text-left transition-transform hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-brand-primary/60`}
      aria-label={`Play ${name}`}
    >
      {poster ? (
        <img
          src={poster}
          alt=""
          className="absolute inset-0 w-full h-full object-contain"
          loading="lazy"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-surface-raised to-surface-elevated" />
      )}

      {/* Play triangle. Hover-only on pointer:fine devices, always on
          coarse pointers (touch) via the group-hover fallback. Live-
          media has a pointer:coarse @media applied via a wrapping
          span to keep the file purely Tailwind. */}
      <span
        className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity [@media(pointer:coarse)]:opacity-100"
        aria-hidden
      >
        <span className="w-11 h-11 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center ring-1 ring-white/20">
          <svg
            className="w-5 h-5 text-white translate-x-[1px]"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </span>

      {/* Coach-only "Feature this" ghost pill. Top-right so it clears
          the poster's action and never overlaps the bottom label. The
          button stops propagation so tapping it doesn't also open the
          reel. Only renders when the parent passed onFeature, which
          means: viewer is a coach AND this clip is coach-uploaded AND
          it isn't already featured. */}
      {onFeature && (
        <span
          role="button"
          tabIndex={0}
          onClick={handleFeature}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleFeature(e as unknown as React.MouseEvent);
            }
          }}
          aria-label="Feature this clip in From Your Coach"
          className={`absolute top-1.5 right-1.5 z-10 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-black/55 text-cyan-200 ring-1 ring-cyan-400/40 backdrop-blur-sm hover:bg-black/75 hover:text-white transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-400/70 cursor-pointer ${featuring ? 'opacity-60 pointer-events-none' : ''}`}
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polygon points="12 2 15 8.5 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 9 8.5 12 2" />
          </svg>
          <span>{featuring ? 'Featuring' : 'Feature'}</span>
        </span>
      )}

      {/* Bottom-left label overlay. Avatar + name/secondary column. */}
      <div className="absolute inset-x-0 bottom-0 p-2.5 pt-8 bg-gradient-to-t from-black/80 via-black/50 to-transparent pointer-events-none">
        <div className="flex items-center gap-2 min-w-0">
          <RosterAvatar
            name={tagged?.name || name}
            photoUrl={tagged?.profilePhotoUrl || undefined}
            size={28}
            className="ring-1 ring-white/40"
          />
          <div className="min-w-0 flex-1">
            <div className="text-white text-sm font-bold truncate leading-tight">{name}</div>
            {secondary && (
              <div className="text-white/70 text-[11px] font-medium truncate leading-tight mt-0.5">
                {secondary}
              </div>
            )}
          </div>
        </div>
      </div>
    </button>
  );
};

export default HighlightCardLite;
