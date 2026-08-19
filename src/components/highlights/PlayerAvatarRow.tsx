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

// v6.3 (2026-08-19): swapped photo fit back to `cover`. The prior
// `contain` compromise letterboxed portrait-orientation photos with
// visible dead space inside the circle, which reads as "avatars not
// taking the full circle." `cover` centers + crops which matches
// every other avatar in the app (Player card, People page, Circle).
// Ring/padding/badge geometry from v6.2 unchanged.
const AVATAR_W = 64;
const AVATAR_H = 64;

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
      className="flex gap-3 overflow-x-auto overflow-y-hidden -mx-1 px-1 pt-3 pb-2 mb-4"
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
        className={`relative inline-flex rounded-full transition p-1 bg-surface-elevated ${ringClass}`}
        style={{ width: AVATAR_W, height: AVATAR_H }}
      >
        {label === 'All' ? (
          <span
            className="inline-flex items-center justify-center rounded-full bg-brand-primary text-brand-primary-fg font-black"
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
            shape="circle"
            fit="cover"
          />
        )}
        {count > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[11px] font-black flex items-center justify-center ring-2 ring-surface-base"
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
