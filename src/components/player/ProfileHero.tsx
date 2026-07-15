import React from 'react';
import { getPlayerPositionsLabel } from '../../utils/helpers';
import { coerceDob, formatDobShort, computeDobAge } from '../../utils/dobDate';
import type { Player } from '../../types';

// PlayerProfile hero. Uses the same semantic surface/ink treatment as
// the rest of the app so the profile does not become a separate dark
// microsite on web.
//
// 2026-07-15 (Direction B): the whole action-row cluster that used to
// live between the hero and the tab bar collapses INTO this hero's
// top-nav row: Whisper (coach → parent private note) and Share sit
// alongside Back / Kudos / Edit. Stop-share becomes an overflow item
// inside PlayerCircleCard. Nickname renders under the name in quotes.

interface Props {
  player: Player;
  teamName?: string;
  canEdit: boolean;
  isCurrentPotm?: boolean;
  onEdit?: () => void;
  onBack?: () => void;
  /** Show the Kudos button in the top nav (2026-07-14). Only pass
   *  when the viewer is in player.parentIds (a Circle member). */
  showKudos?: boolean;
  onKudos?: () => void;
  /** Coach → parent private note. Only surfaced to coaches of youth
   *  teams (adult-team parents don't need coach whispers). Prior to
   *  2026-07-15 this lived in the deleted action row. */
  showWhisper?: boolean;
  onWhisper?: () => void;
}

const ProfileHero: React.FC<Props> = ({
  player,
  teamName,
  canEdit,
  isCurrentPotm,
  onEdit,
  onBack,
  showKudos,
  onKudos,
  showWhisper,
  onWhisper,
}) => {
  const dob = coerceDob(player.dateOfBirth);
  const age = computeDobAge(player.dateOfBirth);
  const dobLabel = formatDobShort(player.dateOfBirth);
  const positionLabel = getPlayerPositionsLabel(player) || (player as any).position;
  const nickname = (player.nickname || '').trim();

  return (
    <section className="relative bg-surface-elevated overflow-hidden border-b border-line-default/10">
      {/* Top nav row */}
      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-3 sm:pt-4 flex items-center justify-between">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="w-10 h-10 rounded-full bg-surface-input hover:bg-surface-raised ring-1 ring-line-default/15 flex items-center justify-center text-ink-primary"
            aria-label="Back"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
        ) : <span />}
        <div className="flex items-center gap-2">
          {/* Whisper — coach's private note to parents. Icon-only to
              keep the top nav compact; the tooltip carries the label
              for anyone hovering. */}
          {showWhisper && onWhisper && (
            <button
              type="button"
              onClick={onWhisper}
              className="w-10 h-10 rounded-full bg-surface-input hover:bg-surface-raised ring-1 ring-line-default/15 flex items-center justify-center text-ink-primary"
              aria-label="Send a private note to this player's parents"
              title="Whisper — private note to parents"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            </button>
          )}
          {/* Kudos — Circle-member action. Sits alongside Edit at the
              top-right so Circle members can drop a note without
              scrolling. See project_player_circle_mission memory. */}
          {showKudos && onKudos && (
            <button
              type="button"
              onClick={onKudos}
              className="inline-flex items-center gap-1.5 h-10 px-3.5 rounded-full bg-brand-primary text-white ring-1 ring-brand-primary/40 shadow-sm text-[11px] font-black uppercase tracking-[0.14em] hover:brightness-110 transition whitespace-nowrap"
              aria-label="Give Kudos"
              title="Give Kudos — a short note about something you noticed"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" /></svg>
              Give Kudos
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="w-10 h-10 rounded-full bg-surface-input hover:bg-surface-raised ring-1 ring-line-default/15 flex items-center justify-center text-ink-primary"
              aria-label="Edit profile"
              title="Edit profile"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
            </button>
          )}
        </div>
      </div>

      {/* Main hero band */}
      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-2 pb-6 flex items-start gap-5">
        {/* Photo with cyan ring + jersey number badge */}
        <div className="relative shrink-0">
          {/* 2026-07-14: photo ring aligned with Dashboard Season Card
              treatment (solid crimson, 3px). Prior ring-4 + soft/70
              read as chunky washed pink; the Season Card set the
              cleaner reference and this page now matches it. */}
          {player.profilePhotoUrl ? (
            <img
              src={player.profilePhotoUrl}
              alt={player.name}
              className={`w-28 h-28 sm:w-36 sm:h-36 rounded-full object-cover shadow-lg ring-[3px] ${
                isCurrentPotm ? 'ring-amber-300' : 'ring-brand-primary'
              }`}
            />
          ) : (
            <div className={`w-28 h-28 sm:w-36 sm:h-36 rounded-full bg-line-default/10 flex items-center justify-center backdrop-blur shadow-lg ring-[3px] ${
              isCurrentPotm ? 'ring-amber-300' : 'ring-brand-primary'
            }`}>
              <span className="text-4xl sm:text-5xl font-black text-ink-primary">
                {player.jerseyNumber != null ? `#${player.jerseyNumber}` : player.name.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          {player.profilePhotoUrl && player.jerseyNumber != null && (
            <span className="absolute -bottom-2 -right-2 bg-brand-primary text-white rounded-full min-w-[36px] h-9 px-2.5 flex items-center justify-center text-sm font-black shadow-xl ring-2 ring-surface-elevated">
              #{player.jerseyNumber}
            </span>
          )}
        </div>

        {/* Name + identity rows */}
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl sm:text-5xl font-black tracking-tight leading-none text-ink-primary truncate uppercase">
            {player.name}
          </h1>
          {nickname && (
            <p
              className="mt-1 text-sm sm:text-base font-semibold italic text-ink-primary/60 truncate"
              title={`Nickname: ${nickname}`}
            >
              &ldquo;{nickname}&rdquo;
            </p>
          )}
          {(positionLabel || teamName) && (
            <p className="mt-2 text-[11px] sm:text-xs font-extrabold uppercase tracking-widest">
              {positionLabel && <span className="text-brand-primary-soft">{positionLabel}</span>}
              {positionLabel && teamName && <span className="text-ink-primary/35 mx-2">·</span>}
              {teamName && <span className="text-ink-primary/75">{teamName}</span>}
            </p>
          )}
          {/* Bio strip — DOB / age. Compact, mobile-friendly. */}
          {(dob || player.preferredFoot) && (
            <div className="mt-3 flex items-center gap-2 flex-wrap text-ink-primary/75">
              {dob && (
                <Pill icon={<CalendarIcon />} label={`${dobLabel}${age != null ? ` (${age})` : ''}`} />
              )}
              {player.preferredFoot && (
                <Pill icon={<FootIcon />} label={`${player.preferredFoot} foot`} />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tagline strip */}
      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pb-5 text-center">
        <p className="text-[10px] sm:text-[11px] font-extrabold uppercase tracking-[0.3em] text-brand-primary-soft/80">
          Every Player Deserves a Shot
        </p>
      </div>
    </section>
  );
};

const Pill: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-line-default/10 ring-1 ring-line-default/15 backdrop-blur text-[11px] font-bold">
    <span className="text-brand-primary-soft">{icon}</span>
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

export default ProfileHero;
