// Browse-by-player avatar row for the Highlights tab. Horizontal
// scroll of circular photos, red count badge top-right on each,
// name below. "All" pill first, selected by default.
//
// This is a CONTENT row (photos + counts) so horizontal scroll is
// fine per feedback_no_horizontal_pills — the rule bans chrome pills
// that scroll sideways, not scroll strips of media/people.

import React, { useMemo } from 'react';
import type { Player, PlayerMedia as PlayerMediaType } from '../../types';
import { mediaBelongsToPlayer } from '../../utils/mediaAttribution';
import RosterAvatar from '../common/RosterAvatar';

interface Props {
  players: Player[];
  media: PlayerMediaType[];
  selectedPlayerId: string | 'all';
  onSelect: (playerId: string | 'all') => void;
}

// v6 iteration: shape change + bigger canvas. Circles kept clipping
// faces because a portrait phone selfie has the face 20-35% down the
// frame and a circle carves both sides AND the top. Switching to a
// rounded-square card (with slight portrait aspect 96x112) plus
// object-position 50% 20% means the crop box shape matches the
// source shape, so faces survive. v3/v4/v5 kept tuning padding and
// object-position on a circle; this rounds out the actual root cause
// (crop-box aspect vs source aspect mismatch).
const AVATAR_W = 96;
const AVATAR_H = 112;

const PlayerAvatarRow: React.FC<Props> = ({ players, media, selectedPlayerId, onSelect }) => {
  // Pre-compute per-player counts once per (players, media) so scroll
  // stays cheap even on rosters with 30+ names.
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of players) {
      let n = 0;
      for (const m of media) {
        if (mediaBelongsToPlayer(m, p.id)) n++;
      }
      map[p.id] = n;
    }
    return map;
  }, [players, media]);

  // Players sorted by clip count desc so the busiest kids surface
  // first. Zero-count players still render (so parents whose kid
  // hasn't been captured yet see themselves in the row and know it's
  // the right team).
  const ordered = useMemo(() => {
    return [...players].sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
  }, [players, counts]);

  const totalClips = media.length;

  return (
    <div
      className="flex gap-3 overflow-x-auto overflow-y-hidden -mx-1 px-1 pb-2 mb-4"
      style={{ WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}
      aria-label="Filter clips by player"
    >
      {/* "All" pill first — anchors the row and doubles as the reset
          when a player is currently selected. */}
      <AvatarPill
        label="All"
        selected={selectedPlayerId === 'all'}
        count={totalClips}
        onClick={() => onSelect('all')}
      />
      {ordered.map(p => (
        <AvatarPill
          key={p.id}
          label={p.name || 'Player'}
          photoUrl={p.profilePhotoUrl || undefined}
          selected={selectedPlayerId === p.id}
          count={counts[p.id] || 0}
          onClick={() => onSelect(p.id)}
        />
      ))}
    </div>
  );
};

// ── Sub: single avatar + name + red count badge ─────────────────────

interface PillProps {
  label: string;
  photoUrl?: string;
  selected: boolean;
  count: number;
  onClick: () => void;
}

const AvatarPill: React.FC<PillProps> = ({ label, photoUrl, selected, count, onClick }) => {
  // Selection ring hugs the outer card. Kept the offset ring pattern
  // so the selection state reads as a picked-up trading card, not a
  // colored border touching the photo.
  const ringClass = selected
    ? 'ring-2 ring-brand-primary ring-offset-2 ring-offset-surface-base'
    : 'ring-1 ring-line-default/15';
  const innerW = AVATAR_W - 8;
  const innerH = AVATAR_H - 8;
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 flex flex-col items-center gap-1.5 focus:outline-none group"
      aria-pressed={selected}
      aria-label={`${label}, ${count} clip${count === 1 ? '' : 's'}`}
    >
      <span
        className={`relative inline-flex rounded-2xl transition p-1 bg-surface-elevated ${ringClass}`}
        style={{ width: AVATAR_W, height: AVATAR_H }}
      >
        {label === 'All' ? (
          <span
            className="inline-flex items-center justify-center rounded-xl bg-brand-primary text-brand-primary-fg font-black"
            style={{ width: innerW, height: innerH, fontSize: 22 }}
          >
            All
          </span>
        ) : (
          <RosterAvatar
            name={label}
            photoUrl={photoUrl}
            size={innerW}
            height={innerH}
            shape="card"
          />
        )}
        {count > 0 && (
          <span
            className="absolute -top-1.5 -right-1.5 min-w-[24px] h-6 px-1.5 rounded-full bg-red-600 text-white text-xs font-black flex items-center justify-center ring-2 ring-surface-base"
            aria-hidden
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </span>
      <span
        className={`text-xs truncate max-w-[96px] ${selected ? 'text-ink-primary font-bold' : 'text-ink-secondary'}`}
      >
        {label.split(' ')[0]}
      </span>
    </button>
  );
};

export default PlayerAvatarRow;
