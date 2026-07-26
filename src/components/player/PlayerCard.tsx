import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Player, Invite } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';
import { useTeam } from '../../contexts/TeamContext';
import { isCoachOfTeam, isStaffOfTeam } from '../../utils/helpers';
import { doc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { createPlayerInvite } from '../../utils/invites';
import { computeDobAge, formatDobShort } from '../../utils/dobDate';
import InviteShareModal from '../common/InviteShareModal';
import { reactivatePlayerForCurrentSeason } from '../../utils/seasons';
import { badgeImageSrc, badgeSrcSet, badgeLabel } from '../../utils/badgeMeta';

interface PlayerCardProps {
  player: Player;
  onEdit?: (player: Player) => void;
  onDelete?: (playerId: string) => void;
  showActions?: boolean;
  /** Currently-selected team. Stats and clips are already pre-scoped
   *  in the parent; this is just for analytics / future use. */
  selectedTeamId?: string;
  /** 0-100 attendance percent from the batched team-events fetch in
   *  PlayerList. Null when not yet computed or no past events. */
  attendancePct?: number | null;
  /** Hero layout for solo surfaces (kid dashboard). Streak renders
   *  as a bold avatar-corner bubble (more noticeable) instead of a
   *  body pill. Also hides the action row entirely so no dead
   *  "View profile" link on a page where navigation is locked. */
  heroLayout?: boolean;
}

// Badge shield chip for the Squad card header — icon-only, no label
// text, so a row of 3-4 reads as "trophy shelf" rather than pill soup.
// Uses the same PNG art as PlayerXpCard, sized down and given a subtle
// glow ring per rarity tier.
const BadgeShield: React.FC<{ slug: string }> = ({ slug }) => {
  const size = 32;
  const rare = slug === 'first_potm' || slug === 'streak_25' || slug === 'streak_50' || slug === 'perfect_attendance';
  const legendary = slug === 'streak_50' || slug === 'perfect_attendance';
  const ring = legendary
    ? 'shadow-[0_0_0_1px_rgba(251,191,36,0.55),0_2px_10px_rgba(251,191,36,0.35)]'
    : rare
      ? 'shadow-[0_0_0_1px_rgba(251,146,60,0.5),0_2px_8px_rgba(251,146,60,0.25)]'
      : 'shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_2px_6px_rgba(0,0,0,0.35)]';
  return (
    <span
      title={badgeLabel(slug)}
      className={`inline-flex items-center justify-center rounded-full bg-surface-base ${ring}`}
      style={{ width: size, height: size }}
    >
      <img
        src={badgeImageSrc(slug, size)}
        srcSet={badgeSrcSet(slug, size)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className="block"
        style={{ width: size, height: size, objectFit: 'contain' }}
      />
    </span>
  );
};

// Streak pill — the flame indicator lives in the card body now (under
// the identity line) instead of clipping onto the avatar. Warm orange
// gradient scales at 5/10/25 thresholds so the visual "temperature"
// stays consistent with the Dashboard hero.
const StreakPill: React.FC<{ days: number }> = ({ days }) => {
  const tone =
    days >= 25 ? 'bg-gradient-to-r from-amber-300 via-orange-500 to-orange-600' :
    days >= 10 ? 'bg-gradient-to-r from-orange-400 to-orange-600' :
    days >= 5 ? 'bg-orange-500' :
    'bg-orange-500/85';
  return (
    <span
      title={`${days}-day practice streak`}
      className={`inline-flex items-center gap-1.5 self-start px-2.5 py-1 rounded-full text-[11px] font-black tracking-wide text-white shadow-md ring-1 ring-white/10 ${tone}`}
    >
      <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path fillRule="evenodd" d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176 7.547 7.547 0 01-1.705-1.715.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 011.925-3.545 3.75 3.75 0 013.255 3.717z" clipRule="evenodd" />
      </svg>
      <span className="tabular-nums">{days}</span>
      <span className="opacity-90">day streak</span>
    </span>
  );
};

// Pick which badges to feature in the header shelf. Rarity first (POTM,
// long streaks, attendance) so a small player collection still leads
// with their best hardware. Coach-recognition rides along after so the
// shelf never looks empty for a kid the coach has been recognizing.
const BADGE_PRIORITY: string[] = [
  'perfect_attendance',
  'streak_50',
  'first_potm',
  'streak_25',
  'first_goal',
  'first_assist',
  'first_save',
  'first_clean_sheet',
  'streak_10',
  'streak_5',
  'coach_pick',
];

function selectTopBadges(badges: Record<string, any> | undefined | null, limit = 4): string[] {
  if (!badges) return [];
  const owned = Object.keys(badges).filter(slug => badges[slug]);
  if (owned.length === 0) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const slug of BADGE_PRIORITY) {
    if (owned.includes(slug) && !seen.has(slug)) {
      ordered.push(slug);
      seen.add(slug);
    }
  }
  // Any slug not in the priority list (future-added) — tack on end.
  for (const slug of owned) {
    if (!seen.has(slug)) {
      ordered.push(slug);
      seen.add(slug);
    }
  }
  return ordered.slice(0, limit);
}

const positionDot = (pos?: string): string => {
  switch (pos) {
    case 'Goalkeeper': return 'bg-amber-400';
    case 'Defender': return 'bg-sky-400';
    case 'Midfielder': return 'bg-emerald-400';
    case 'Forward':
    case 'Striker': return 'bg-rose-400';
    case 'Winger': return 'bg-orange-400';
    default: return 'bg-brand-primary-soft';
  }
};

const MiniStat: React.FC<{ label: string; value: number; accent: 'emerald' | 'cyan' | 'amber' | 'violet' }> = ({ label, value, accent }) => {
  const ring =
    accent === 'emerald' ? 'text-emerald-300' :
    accent === 'cyan' ? 'text-brand-primary-soft' :
    accent === 'amber' ? 'text-amber-300' :
    'text-violet-300';
  return (
    <div className="rounded-lg bg-line-default/5 border border-line-default/10 p-2 text-center overflow-hidden">
      <div className={`text-xl sm:text-2xl font-black ${ring}`}>{value}</div>
      {/* tracking-tight + leading-none so the label fits even on the narrowest
          card width; 'ASSISTS' was clipping to 'ASSIS' on the previous
          tracking-wider value. */}
      <div className="text-[9px] sm:text-[10px] uppercase tracking-tight leading-none text-ink-primary/60 font-bold mt-0.5 truncate">{label}</div>
    </div>
  );
};

const PlayerCard: React.FC<PlayerCardProps> = ({
  player,
  onEdit,
  onDelete,
  showActions = true,
  attendancePct = null,
  heroLayout = false,
}) => {
  const { userData } = useAuth();
  const { updateDocument } = useFirestore();
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [activeInvite, setActiveInvite] = useState<Invite | null>(null);

  const { teams } = useTeam();
  const playerTeam = teams.find(t => t.id === player.teamId) || null;
  const isUserCoach = isCoachOfTeam(userData, playerTeam);
  const isUserStaff = isStaffOfTeam(userData, playerTeam);
  const canEdit = isUserCoach && showActions;
  const isMyChild = userData ? player.parentIds?.includes(userData.uid) : false;
  const circleIsEmpty = !player.parentIds || player.parentIds.length === 0;
  // Show "Add to circle" only where the viewer has a stake:
  //   1. It's their kid (parent adding a co-parent / guardian)
  //   2. Player has no guardians yet AND viewer is staff (get the
  //      first parent onboarded)
  // Coaches viewing other people's kids with guardians already set
  // won't see it on the card — they can still reach it from the
  // player detail sheet.
  const canInviteToCircle = showActions && (isMyChild || (isUserStaff && circleIsEmpty));

  const handleInviteParent = async () => {
    if (!userData) return;
    setGeneratingInvite(true);
    try {
      const inv = await createPlayerInvite({
        teamId: player.teamId,
        playerId: player.id,
        createdBy: userData.uid,
      });
      setActiveInvite(inv);
    } catch (err) {
      console.error('Failed to create invite', err);
      alert('Could not generate invite link. Try again.');
    } finally {
      setGeneratingInvite(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;

    setIsDeleting(true);
    try {
      // Soft delete via worker (coach-of-team gated). Server writes
      // players.isActive=false + deletedAt; the players list filters
      // by isActive so the row disappears while stats/media stay
      // recoverable from the Archived view.
      const teamId = player.teamId || (Array.isArray(player.teamIds) ? player.teamIds[0] : '');
      if (!teamId) throw new Error('No team on player');
      const { workerFetch } = await import('../../utils/workerFetch');
      const res = await workerFetch('/players/set-active', {
        method: 'POST',
        body: JSON.stringify({ teamId, playerId: player.id, isActive: false }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || `delete-${res.status}`);
      onDelete(player.id);
      setShowDeleteConfirm(false);
    } catch (error) {
      console.error('Error archiving player:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  // Age comparison uses UTC calendar days to stay consistent with
  // the DOB storage convention (stored at UTC noon). Legacy UTC-
  // midnight rows also compute correctly. See src/utils/dobDate.ts.
  const age = computeDobAge(player.dateOfBirth);

  return (
    <>
      <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-surface-elevated to-surface-input p-4 sm:p-5 text-ink-primary shadow-md border border-brand-primary/10 h-full flex flex-col">
        {/* Faint cyan accent — keeps a hint of "card has personality"
            without the bubbly blur-blob look. */}
        <div className="absolute -top-12 -right-12 w-32 h-32 bg-brand-primary/10 rounded-full blur-2xl pointer-events-none" />

        <div className="relative flex-1 flex flex-col">
          {/* Header row — position pill on the LEFT, badge trophy shelf
              on the RIGHT. Wraps gracefully on narrow phone widths so
              the shelf drops to a new row instead of squeezing. Streak
              flame that used to clip the avatar's top-left corner now
              lives in the body slot below the identity line. */}
          {(() => {
            const badgeSlugs = selectTopBadges((player as any).badges, 4);
            const totalBadges = (player as any).badges ? Object.keys((player as any).badges).filter((s: string) => (player as any).badges[s]).length : 0;
            const overflow = Math.max(0, totalBadges - badgeSlugs.length);
            return (
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="inline-flex self-start items-center gap-2 px-3 py-1 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/70 text-[10px] font-bold uppercase tracking-wider backdrop-blur">
                    <span className={`w-2 h-2 rounded-full ${player.position ? positionDot(player.position) : 'bg-line-default/40'}`} />
                    {player.position || 'Unassigned'}
                  </div>
                  {/* Guest pill — subtle amber to signal "temporary
                      squad member" without shouting. Sits next to the
                      position chip so it reads as part of the identity
                      row, not a badge overlay. */}
                  {(player as any).isGuest && (
                    <span
                      title={
                        (player as any).expiresAt
                          ? `Guest player · access through ${formatDobShort((player as any).expiresAt)}`
                          : 'Guest player'
                      }
                      className="inline-flex self-start items-center gap-1 px-2 py-1 rounded-full bg-amber-500/15 ring-1 ring-amber-400/40 text-amber-700 dark:text-amber-200 text-[10px] font-black uppercase tracking-wider"
                    >
                      Guest
                    </span>
                  )}
                </div>
                {badgeSlugs.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {badgeSlugs.map(slug => <BadgeShield key={slug} slug={slug} />)}
                    {overflow > 0 && (
                      <span
                        title={`${overflow} more badge${overflow === 1 ? '' : 's'}`}
                        className="inline-flex items-center justify-center h-6 min-w-6 px-1.5 rounded-full text-[10px] font-black text-ink-primary/70 bg-line-default/15 ring-1 ring-line-default/20"
                      >
                        +{overflow}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Photo + Name row */}
          <div className="flex items-center gap-4 mb-5">
            <div className="relative flex-shrink-0">
              {(player as any).isCurrentPotm && (
                <span aria-hidden className="absolute -top-1.5 -right-1.5 z-10 inline-flex items-center justify-center w-7 h-7 rounded-full bg-amber-400 text-amber-950 shadow-lg ring-2 ring-white">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z"/></svg>
                </span>
              )}
              {/* Hero-layout streak bubble — noticeable orbit at the
                  avatar's top-left. Only when heroLayout is on (kid
                  dashboard). Roster tiles keep the body pill so the
                  Squad grid doesn't turn into different-shape orbs
                  again. */}
              {heroLayout && ((player as any).currentStreakDays ?? 0) > 0 && (
                <span
                  title={`${(player as any).currentStreakDays}-day practice streak`}
                  className={`absolute -top-1 -left-1 z-10 inline-flex h-9 min-w-9 items-center justify-center gap-0.5 px-1.5 rounded-full text-[12px] font-black tabular-nums ring-2 ring-offset-2 ring-offset-surface-elevated text-white shadow-lg ${
                    ((player as any).currentStreakDays ?? 0) >= 25
                      ? 'bg-gradient-to-br from-amber-300 to-orange-600'
                      : ((player as any).currentStreakDays ?? 0) >= 10
                        ? 'bg-gradient-to-br from-orange-400 to-orange-600'
                        : ((player as any).currentStreakDays ?? 0) >= 5
                          ? 'bg-orange-500'
                          : 'bg-orange-500/85'
                  }`}
                >
                  <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path fillRule="evenodd" d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.176 7.547 7.547 0 01-1.705-1.715.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 011.925-3.545 3.75 3.75 0 013.255 3.717z" clipRule="evenodd" />
                  </svg>
                  {(player as any).currentStreakDays}
                </span>
              )}
              {player.profilePhotoUrl ? (
                <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full overflow-hidden ring-2 shadow-lg ${
                  (player as any).isCurrentPotm ? 'ring-amber-300 shadow-amber-400/50' : 'ring-line-default/25'
                }`}>
                  <img
                    src={player.profilePhotoUrl}
                    alt={player.name}
                    className="w-full h-full object-cover"
                  />
                </div>
              ) : (
                <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-line-default/10 ring-2 shadow-lg flex items-center justify-center backdrop-blur ${
                  (player as any).isCurrentPotm ? 'ring-amber-300 shadow-amber-400/50' : 'ring-line-default/25'
                }`}>
                  <span className="text-2xl font-black text-ink-primary/65">
                    {player.name.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              {/* Jersey chip — bottom-right of the avatar, always
                  present when the number is set. Removed the prior
                  "only when there's a photo" guard so the number lives
                  in one canonical slot for every card (audit 2026-07-12
                  found Harrison's #15 rendered inside the initials
                  avatar AND as body text — same number in three places). */}
              {player.jerseyNumber != null && (
                <span className="absolute -bottom-1 -right-1 bg-surface-base text-ink-primary rounded-full min-w-[28px] h-7 px-1.5 flex items-center justify-center text-xs font-black shadow-lg ring-2 ring-surface-elevated">
                  #{player.jerseyNumber}
                </span>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <Link to={`/player/${player.id}`} className="hover:underline">
                {/* Let long names wrap to 2 lines instead of truncating to
                    'Ryd…' / 'Hect…'. Looked broken on iPad-width cards. */}
                <h3 className="text-xl sm:text-2xl font-black tracking-tight leading-tight break-words line-clamp-2">{player.name}</h3>
              </Link>
              {/* Single identity line — same order across every card:
                  Age → preferred foot → secondary position → height.
                  Jersey number lives in the avatar chip, not repeated
                  here. Renders nothing when every field is absent
                  (better than the prior "Player" stub for photo-having,
                  DOB-missing kids). */}
              {(() => {
                const parts: string[] = [];
                if (age != null) parts.push(`Age ${age}`);
                if ((player as any).preferredFoot) parts.push(`${(player as any).preferredFoot} foot`);
                if ((player as any).secondaryPosition && (player as any).secondaryPosition !== player.position) {
                  parts.push((player as any).secondaryPosition);
                }
                if ((player as any).heightCm) parts.push(`${(player as any).heightCm} cm`);
                if (parts.length === 0) return null;
                return (
                  <p className="text-ink-primary/60 text-sm font-medium mt-0.5">{parts.join(' · ')}</p>
                );
              })()}

              {/* Vitals line — favorite player, personal juggle best,
                  attendance %. Same dot-separated shape as the identity
                  line so it reads as continuation, not a new section.
                  Muted a step further so identity stays the anchor.
                  Renders nothing when nothing is set — small rosters
                  don't look sparse. */}
              {/* Guest window — "Guest through Aug 12" reads as a
                  soccer-native subtitle for tournament ringers, so a
                  coach glancing at the roster sees the expiry without
                  opening the profile. Only when isGuest AND expiresAt
                  is set; open-ended guests get no line here. */}
              {(player as any).isGuest && (player as any).expiresAt && (
                <p className="text-amber-700 dark:text-amber-200 text-[11px] font-bold mt-1 truncate">
                  Guest through {formatDobShort((player as any).expiresAt)}
                </p>
              )}

              {(() => {
                const isAdult = (playerTeam as any)?.audienceType === 'adult';
                const vitals: string[] = [];
                // favoritePlayer + juggles are kid-flavored; hide on
                // adult teams.
                if (!isAdult && (player as any).favoritePlayer) vitals.push(`♥ ${(player as any).favoritePlayer}`);
                const jb = (player as any).juggles?.best;
                if (!isAdult && typeof jb === 'number' && jb > 0) vitals.push(`${jb} juggle${jb === 1 ? '' : 's'}`);
                if (attendancePct != null) vitals.push(`${attendancePct}% attend`);
                if (vitals.length === 0) return null;
                return (
                  <p className="text-ink-primary/45 text-[11px] font-medium mt-1 truncate" title={vitals.join(' · ')}>
                    {vitals.join(' · ')}
                  </p>
                );
              })()}

              {/* Practice streak pill — sits in the identity column,
                  under the vitals line. Was clipping the avatar's top-
                  left corner previously; anchored here it doesn't
                  cover the profile photo and keeps the flame visible
                  at a scannable size instead of a corner chip. Only
                  renders when the player has a live streak. Skipped
                  in heroLayout — the avatar bubble is the primary
                  signal there. */}
              {!heroLayout && ((player as any).currentStreakDays ?? 0) > 0 && (
                <div className="mt-1.5">
                  <StreakPill days={(player as any).currentStreakDays} />
                </div>
              )}
            </div>
          </div>

          {/* Mini stat tiles */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            <MiniStat label="Goals" value={player.stats?.goals || 0} accent="emerald" />
            {/* "Assists" wrapped in 4-col grid so it truncated to "ASSI…";
                shortened to the standard short form "AST" (matches
                stat tables everywhere). */}
            <MiniStat label="AST" value={player.stats?.assists || 0} accent="cyan" />
            <MiniStat label="Saves" value={player.stats?.saves || 0} accent="amber" />
            <MiniStat label="Games" value={player.stats?.gamesPlayed || 0} accent="violet" />
          </div>

          {/* Inactive-player banner + reactivate */}
          {!player.isActive && isUserCoach && (
            <div className="rounded-xl bg-amber-400/10 ring-1 ring-amber-300/30 p-3 mb-3 flex items-center justify-between gap-3 backdrop-blur">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-amber-700">Past Player</p>
                <p className="text-xs text-ink-primary/65 mt-0.5">Profile + clips + history preserved.</p>
              </div>
              <button
                onClick={async () => {
                  try {
                    await reactivatePlayerForCurrentSeason(player.id, player.teamId, player.jerseyNumber, player.position);
                  } catch (err) {
                    console.error('Reactivate failed', err);
                    alert('Could not reactivate. Try again.');
                  }
                }}
                className="px-3 py-2 rounded-full bg-emerald-400/15 ring-1 ring-emerald-400/30 text-emerald-700 hover:bg-emerald-400/25 text-xs font-semibold backdrop-blur transition whitespace-nowrap"
              >
                ↺ Bring Back
              </button>
            </div>
          )}

          {/* Action buttons — mt-auto pushes to card bottom so cards
              in a row align at the footer regardless of whether the
              Add-to-circle / Start-circle chip renders. Edit + archive
              live here as small icon buttons on the RIGHT so they
              don't crowd the position pill at the top of the card.
              Hidden entirely in heroLayout — on kid dashboard the
              "View Profile" link went nowhere because kid mode
              short-circuits routing back to KidDashboard. */}
          {!heroLayout && (
          <div className="mt-auto pt-4 flex flex-wrap gap-2 items-center">
            <Link
              to={`/player/${player.id}`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white text-charcoal-800 font-bold text-sm shadow hover:scale-105 transition"
            >
              View Profile →
            </Link>
            {canInviteToCircle && (
              <button
                onClick={handleInviteParent}
                disabled={generatingInvite}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-brand-primary-soft/20 ring-1 ring-brand-primary-soft/40 text-ink-primary hover:bg-brand-primary-soft/30 text-xs font-semibold backdrop-blur transition disabled:opacity-50"
                title={circleIsEmpty ? 'No one is in this player’s circle yet. Invite the first guardian.' : 'Invite a co-parent, grandparent, or other guardian to this player’s circle.'}
              >
                {generatingInvite ? (
                  '…'
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v6m3-3h-6m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                    </svg>
                    {circleIsEmpty ? 'Start circle' : 'Add to circle'}
                  </>
                )}
              </button>
            )}
            {!isUserCoach && showActions && (
              <button
                onClick={() => onEdit && onEdit(player)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/75 font-semibold text-sm hover:bg-line-default/15 hover:text-ink-primary transition backdrop-blur"
              >
                Update Stats
              </button>
            )}
            {canEdit && (
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => onEdit && onEdit(player)}
                  className="p-2 bg-line-default/10 hover:bg-line-default/20 ring-1 ring-line-default/15 rounded-full text-ink-primary/70 hover:text-ink-primary backdrop-blur transition-colors"
                  title="Edit Player"
                  aria-label={`Edit ${player.name}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="p-2 bg-line-default/10 hover:bg-amber-500/20 ring-1 ring-line-default/15 rounded-full text-ink-primary/70 hover:text-ink-primary backdrop-blur transition-colors"
                  title="Archive player (preserves stats; can be restored)"
                  aria-label={`Archive ${player.name}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
                  </svg>
                </button>
              </div>
            )}
          </div>
          )}

          {/* Coach-only footer info */}
          {isUserCoach && (player.medicalInfo || (player.emergencyContacts && player.emergencyContacts.length > 0)) && (
            <div className="mt-4 pt-4 border-t border-line-default/10 space-y-3">
              {player.medicalInfo && (
                <div className="rounded-xl bg-rose-500/15 ring-1 ring-rose-300/30 p-3 backdrop-blur">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-rose-700 mb-1">Medical Info</p>
                  <p className="text-xs text-rose-800">{player.medicalInfo}</p>
                </div>
              )}

              {player.emergencyContacts && player.emergencyContacts.length > 0 && (
                <div className="rounded-xl bg-line-default/5 ring-1 ring-line-default/10 p-3 backdrop-blur">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-ink-primary/65 mb-1.5">Emergency Contacts</p>
                  <div className="space-y-1.5">
                    {player.emergencyContacts.map((contact, index) => (
                      <div key={index} className="text-xs text-ink-primary/80">
                        <span className="font-semibold">{contact.name}</span>
                        <span className="text-ink-primary/55"> ({contact.relationship})</span>
                        {contact.isPrimary && <span className="text-brand-primary-soft ml-1">• Primary</span>}
                        <a
                          href={`tel:${contact.phoneNumber}`}
                          className="block text-brand-primary-soft hover:text-ink-primary underline-offset-2 hover:underline"
                        >
                          {contact.phoneNumber}
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <InviteShareModal
        invite={activeInvite}
        open={!!activeInvite}
        onClose={() => setActiveInvite(null)}
        playerName={player.name}
      />

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="card-modern max-w-md w-full p-6">
            <div className="flex items-center mb-4">
              <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-rose-100">
                <svg className="h-6 w-6 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-charcoal-950 mb-2">Archive Player</h3>
              <p className="text-sm text-gray-500 mb-6">
                Archive <strong>{player.name}</strong>? They'll be removed from the active roster but their stats, photos, and history are preserved. You can restore them later from the Archived view.
              </p>
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={isDeleting}
                  className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold py-2 px-4 rounded-xl transition duration-200 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-semibold py-2 px-4 rounded-xl transition duration-200 disabled:opacity-50 flex items-center justify-center"
                >
                  {isDeleting ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  ) : (
                    'Archive'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default PlayerCard;
