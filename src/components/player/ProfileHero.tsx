import React from 'react';
import { getPlayerPositionsLabel } from '../../utils/helpers';
import type { Player } from '../../types';

// PlayerProfile hero, redesigned to match the dark-mode mockup vibe.
// Big photo with cyan ring, name in display font, position/team/jersey
// glance row, DOB/age bio row, Fire FC mark + tagline on the right.
// Edit pencil sits top-right (parent-only). Sits ABOVE the rest of the
// profile cards which keep the white/light theme so this band reads
// as a distinct hero, not the whole page going dark.

interface Props {
  player: Player;
  teamName?: string;
  canEdit: boolean;
  isCurrentPotm?: boolean;
  onEdit?: () => void;
  onBack?: () => void;
}

const ProfileHero: React.FC<Props> = ({ player, teamName, canEdit, isCurrentPotm, onEdit, onBack }) => {
  const dob = player.dateOfBirth
    ? (player.dateOfBirth instanceof Date ? player.dateOfBirth : new Date(player.dateOfBirth as any))
    : null;
  const age = dob ? computeAge(dob) : null;
  const positionLabel = getPlayerPositionsLabel(player) || (player as any).position;

  return (
    <section className="relative bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-black overflow-hidden">
      {/* Atmospheric glow + faint pitch silhouette */}
      <div className="absolute inset-0 pointer-events-none opacity-30">
        <div className="absolute -top-32 -right-20 w-[480px] h-[480px] rounded-full bg-crimson-500/15 blur-3xl" />
        <div className="absolute -bottom-32 -left-20 w-[480px] h-[480px] rounded-full bg-violet-500/15 blur-3xl" />
      </div>

      {/* Top nav row */}
      <div className="relative px-4 sm:px-6 pt-3 sm:pt-4 flex items-center justify-between">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 ring-1 ring-white/15 backdrop-blur flex items-center justify-center text-white"
            aria-label="Back"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
        ) : <span />}
        {canEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 ring-1 ring-white/15 backdrop-blur flex items-center justify-center text-white"
            aria-label="Edit profile"
            title="Edit profile"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
          </button>
        )}
      </div>

      {/* Main hero band */}
      <div className="relative px-4 sm:px-6 pt-2 pb-6 flex items-start gap-5">
        {/* Photo with cyan ring + jersey number badge */}
        <div className="relative shrink-0">
          {player.profilePhotoUrl ? (
            <img
              src={player.profilePhotoUrl}
              alt={player.name}
              className={`w-28 h-28 sm:w-36 sm:h-36 rounded-full object-cover ring-4 shadow-2xl ${
                isCurrentPotm ? 'ring-amber-300 shadow-amber-400/40' : 'ring-crimson-400/70 shadow-crimson-400/30'
              }`}
            />
          ) : (
            <div className={`w-28 h-28 sm:w-36 sm:h-36 rounded-full bg-white/10 ring-4 shadow-2xl flex items-center justify-center backdrop-blur ${
              isCurrentPotm ? 'ring-amber-300 shadow-amber-400/40' : 'ring-crimson-400/70'
            }`}>
              <span className="text-4xl sm:text-5xl font-black text-white">
                {player.jerseyNumber != null ? `#${player.jerseyNumber}` : player.name.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          {player.profilePhotoUrl && player.jerseyNumber != null && (
            <span className="absolute -bottom-2 -right-2 bg-crimson-500 text-white rounded-full min-w-[36px] h-9 px-2.5 flex items-center justify-center text-sm font-black shadow-xl ring-2 ring-slate-950">
              #{player.jerseyNumber}
            </span>
          )}
        </div>

        {/* Name + identity rows */}
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl sm:text-5xl font-black tracking-tight leading-none text-white truncate uppercase">
            {player.name}
          </h1>
          {(positionLabel || teamName) && (
            <p className="mt-2 text-[11px] sm:text-xs font-extrabold uppercase tracking-widest">
              {positionLabel && <span className="text-crimson-400">{positionLabel}</span>}
              {positionLabel && teamName && <span className="text-white/40 mx-2">·</span>}
              {teamName && <span className="text-white/80">{teamName}</span>}
            </p>
          )}
          {/* Bio strip — DOB / age. Compact, mobile-friendly. */}
          {(dob || player.preferredFoot) && (
            <div className="mt-3 flex items-center gap-2 flex-wrap text-white/80">
              {dob && (
                <Pill icon={<CalendarIcon />} label={`${dob.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}${age != null ? ` (${age})` : ''}`} />
              )}
              {player.preferredFoot && (
                <Pill icon={<FootIcon />} label={`${player.preferredFoot} foot`} />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tagline strip */}
      <div className="relative px-4 sm:px-6 pb-5 text-center">
        <p className="text-[10px] sm:text-[11px] font-extrabold uppercase tracking-[0.3em] text-crimson-400/70">
          Embrace the Soccer Spirit
        </p>
      </div>
    </section>
  );
};

const Pill: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 ring-1 ring-white/15 backdrop-blur text-[11px] font-bold">
    <span className="text-crimson-400">{icon}</span>
    <span>{label}</span>
  </span>
);

const CalendarIcon: React.FC = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);
const FootIcon: React.FC = () => (
  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
    <path d="M12 2c2 0 3 2 3 4s-1 4-3 4-3-2-3-4 1-4 3-4zm-3 9c1 0 2 1 2 2s-1 2-2 2-2-1-2-2 1-2 2-2zm6 0c1 0 2 1 2 2s-1 2-2 2-2-1-2-2 1-2 2-2zM8 16h8v6H8z" />
  </svg>
);

function computeAge(dob: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

export default ProfileHero;
