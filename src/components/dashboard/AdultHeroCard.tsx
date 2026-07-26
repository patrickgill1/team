// AdultHeroCard — the adult-team Dashboard hero. Replaces the old
// AdultMyStatsCard (a flat 3-col stat grid that read like a settings
// row) with a proper hero card modeled on KidHeroCard's visual
// scaffolding: stadium-photo backdrop with dark scrim, avatar +
// crimson ring, editorial name treatment, jersey number rail,
// meta chips (position + foot), a tasteful past-clubs line, and a
// season stats strip using the shared MetricTile look.
//
// What it deliberately does NOT render (per Patrick 2026-07-25):
//   - XP progress bar, level chip, tier/skin frame, THEME modal
//   - Practice streak flame
//   - Juggle counter, favorite-player row, badge locker
// The adult vibe is "professional footballer profile card"
// (Transfermarkt / FIFA card energy) — a competitive resume, not
// gamification. Season MVP appears as a small amber star chip on the
// avatar IF the player has the POTM flag set; otherwise omitted
// silently (no empty state).
//
// Guards live at the parent (Dashboard.tsx): this card only renders
// when currentTeam.audienceType === 'adult' AND the viewing user has
// a linked selfPlayer on the current team's roster. When true but the
// viewer isn't on the roster (spectator / coach-only), Dashboard
// simply skips the block — silent, matching the atomic-render rule.
//
// Stats source: reuses the player doc already loaded on Dashboard,
// where `stats` is season-scoped via getTeamPlayerStatsMap. No new
// Firestore reads.

import React from 'react';
import { Link } from 'react-router-dom';
import type { Player } from '../../types';

interface Props {
  player: Player;
  teamName?: string;
}

// Case-insensitive position match so "goalkeeper" / "Goalkeeper" /
// "GK" all resolve. Position strings are user-editable text in a lot
// of legacy data, so we normalize once and match against a set.
function isKeeper(position: string | undefined | null): boolean {
  if (!position) return false;
  const p = String(position).trim().toLowerCase();
  return p === 'goalkeeper' || p === 'keeper' || p === 'gk';
}

function isDefender(position: string | undefined | null): boolean {
  if (!position) return false;
  const p = String(position).trim().toLowerCase();
  return (
    p === 'defender' ||
    p === 'defence' ||
    p === 'defense' ||
    p === 'centre-back' ||
    p === 'center-back' ||
    p === 'cb' ||
    p === 'fullback' ||
    p === 'full-back' ||
    p === 'lb' ||
    p === 'rb'
  );
}

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// ---------- Icons --------------------------------------------------

const BallIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <polygon points="12,8 15.5,10.5 14,14.5 10,14.5 8.5,10.5" />
  </svg>
);

const BootIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M3 15h11l4-3V7l-3 1-3-3H5v5" />
    <path d="M3 15v3h17l1-2H3" />
  </svg>
);

const ShieldIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
  </svg>
);

const GloveIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M7 21V10a2 2 0 1 1 4 0V4a2 2 0 1 1 4 0v7a2 2 0 1 1 4 0v6a4 4 0 0 1-4 4H7z" />
  </svg>
);

const StarIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 2l2.9 6.9L22 10l-5.5 4.8L18 22l-6-3.5L6 22l1.5-7.2L2 10l7.1-1.1L12 2z" />
  </svg>
);

// ---------- Component ---------------------------------------------

const AdultHeroCard: React.FC<Props> = ({ player, teamName }) => {
  const p = player as unknown as {
    id: string;
    name: string;
    jerseyNumber?: number;
    position?: string;
    positions?: string[];
    profilePhotoUrl?: string | null;
    preferredFoot?: 'Left' | 'Right' | 'Both';
    pastClubs?: string[];
    isCurrentPotm?: boolean;
    stats?: {
      gamesPlayed?: number;
      goals?: number;
      assists?: number;
      saves?: number;
      cleanSheets?: number;
    };
  };

  const primaryPosition =
    (Array.isArray(p.positions) && p.positions[0]) || p.position || '';
  const keeper = isKeeper(primaryPosition) || (p.positions || []).some(isKeeper);
  const defender =
    isDefender(primaryPosition) || (p.positions || []).some(isDefender);

  const stats = p.stats || {};
  const gamesPlayed = Number(stats.gamesPlayed) || 0;
  const goals = Number(stats.goals) || 0;
  const assists = Number(stats.assists) || 0;
  const saves = Number(stats.saves) || 0;
  const cleanSheets = Number(stats.cleanSheets) || 0;

  const initials = getInitials(p.name);

  // Meta chips row: POSITION, FOOT. Team name goes into the top chip
  // instead so we don't shout the team twice.
  const chips: Array<{ icon: React.ReactNode; label: string }> = [];
  if (primaryPosition) {
    chips.push({
      icon: <ShieldIcon className="w-3 h-3" />,
      label: String(primaryPosition).toUpperCase(),
    });
  }
  if (p.preferredFoot) {
    chips.push({
      icon: <BootIcon className="w-3 h-3" />,
      label: `${p.preferredFoot.toUpperCase()} FOOT`,
    });
  }

  // Past clubs: first 2, joined with " · ". Silent when empty.
  const pastClubsList = Array.isArray(p.pastClubs)
    ? p.pastClubs.filter((c) => typeof c === 'string' && c.trim().length > 0)
    : [];
  const pastClubsLine =
    pastClubsList.length > 0 ? pastClubsList.slice(0, 2).join(' · ') : '';

  // Stadium background: layered photo hero + dark scrim so the pitch
  // reads as texture and the content stays legible. Same recipe as
  // KidHeroCard, swapping in adult.jpg and swapping the crimson
  // bottom glow for a neutral one (editorial > gamified).
  const stadiumBg: React.CSSProperties = {
    backgroundImage: [
      'linear-gradient(180deg, rgba(15,15,20,0.78) 0%, rgba(15,15,20,0.55) 45%, rgba(15,15,20,0.88) 100%)',
      'url(/hero/adult.jpg)',
      'radial-gradient(ellipse 55% 40% at 18% -5%, rgba(255,255,255,0.09), transparent 60%)',
      'radial-gradient(ellipse 55% 40% at 82% -5%, rgba(255,255,255,0.09), transparent 60%)',
      'radial-gradient(ellipse 80% 45% at 50% 110%, rgba(255,255,255,0.06), transparent 65%)',
    ].join(', '),
    backgroundSize: 'auto, cover, auto, auto, auto',
    backgroundPosition: 'center, center bottom, top left, top right, bottom center',
    backgroundRepeat: 'no-repeat',
  };

  return (
    <Link
      to={`/player/${p.id}`}
      className="relative block overflow-hidden rounded-3xl bg-surface-elevated ring-1 ring-line-default/40 dark:ring-white/10 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.55)] active:scale-[0.995] transition"
    >
      {/* Stadium wash + inner neutral rim. Both absolute so they sit
          behind content without affecting layout. */}
      <div className="absolute inset-0 pointer-events-none" style={stadiumBg} aria-hidden />
      <div
        className="absolute inset-0 pointer-events-none rounded-3xl ring-1 ring-inset ring-white/10"
        aria-hidden
      />

      {/* TOP ROW — avatar | identity | jersey number rail */}
      <div className="relative grid grid-cols-[auto_1fr_auto] gap-3 sm:gap-4 items-start p-4 sm:p-5">
        {/* LEFT: circular avatar with crimson ring + optional MVP star */}
        <div className="relative shrink-0">
          <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full overflow-hidden bg-surface-input flex items-center justify-center ring-2 ring-brand-primary/60">
            {p.profilePhotoUrl ? (
              <img
                src={p.profilePhotoUrl}
                alt={p.name}
                className="w-full h-full object-cover"
                draggable={false}
              />
            ) : (
              <span className="text-2xl sm:text-3xl font-black text-brand-primary tracking-tight">
                {initials}
              </span>
            )}
          </div>

          {p.isCurrentPotm && (
            <div
              className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-amber-400 text-amber-950 flex items-center justify-center shadow-sm ring-2 ring-black/30"
              title="Season MVP"
              aria-label="Season MVP"
            >
              <StarIcon className="w-3.5 h-3.5" />
            </div>
          )}
        </div>

        {/* CENTER: top chip (team) + name + meta chips + past clubs.
            Light-on-dark by design because the card carries a photo
            background + dark scrim. */}
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/10 text-white/85 text-[10px] font-black uppercase tracking-widest ring-1 ring-white/20">
            <ShieldIcon className="w-3 h-3" />
            {teamName ? teamName.toUpperCase() : 'THIS SEASON'}
          </div>
          <h2 className="mt-1 text-xl sm:text-2xl font-black text-white leading-tight truncate drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]">
            {p.name}
          </h2>
          {chips.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <span
                  key={c.label}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/[0.08] text-white/85 text-[9.5px] font-black uppercase tracking-widest ring-1 ring-white/15"
                >
                  {c.icon}
                  {c.label}
                </span>
              ))}
            </div>
          )}
          {pastClubsLine && (
            <div className="mt-1.5 text-[10.5px] font-semibold text-white/65 truncate">
              <span className="uppercase tracking-widest text-white/45 mr-1">Prev</span>
              {pastClubsLine}
            </div>
          )}
        </div>

        {/* RIGHT: jersey number rail. Big tabular numeral over a
            small "NO." cap. Hidden entirely if no jerseyNumber. */}
        {typeof p.jerseyNumber === 'number' && (
          <div className="shrink-0 flex flex-col items-center">
            <div className="text-[10px] font-black uppercase tracking-widest text-white/70">
              No.
            </div>
            <div className="text-4xl sm:text-5xl font-black text-white leading-none tabular-nums drop-shadow-[0_2px_10px_rgba(255,255,255,0.25)]">
              {p.jerseyNumber}
            </div>
          </div>
        )}
      </div>

      {/* SEASON STATS STRIP. Field players get Games / Goals /
          Assists. Keepers add Saves. Keepers + defenders add Clean
          Sheets. MetricTile look mirrors KidHeroCard so the two
          cards feel like siblings on the same wall. */}
      <div className="relative px-4 sm:px-5 pb-4 sm:pb-5 pt-1">
        <div
          className={
            'grid gap-1.5 sm:gap-2 ' +
            (keeper
              ? 'grid-cols-5'
              : defender
              ? 'grid-cols-4'
              : 'grid-cols-3')
          }
        >
          <MetricTile
            icon={<BallIcon className="w-3.5 h-3.5 text-white/70" />}
            label="Games"
            value={String(gamesPlayed)}
            hint="season"
          />
          <MetricTile
            icon={<BallIcon className="w-3.5 h-3.5 text-emerald-400" />}
            label="Goals"
            value={String(goals)}
            hint="season"
          />
          <MetricTile
            icon={<BallIcon className="w-3.5 h-3.5 text-sky-400" />}
            label="Assists"
            value={String(assists)}
            hint="season"
          />
          {keeper && (
            <MetricTile
              icon={<GloveIcon className="w-3.5 h-3.5 text-amber-300" />}
              label="Saves"
              value={String(saves)}
              hint="season"
            />
          )}
          {(keeper || defender) && (
            <MetricTile
              icon={<ShieldIcon className="w-3.5 h-3.5 text-amber-500" />}
              label="Sheets"
              value={String(cleanSheets)}
              hint="season"
            />
          )}
        </div>
      </div>
    </Link>
  );
};

interface MetricTileProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}

const MetricTile: React.FC<MetricTileProps> = ({ icon, label, value, hint }) => (
  <div className="rounded-xl bg-white/[0.05] ring-1 ring-white/10 px-2.5 py-2 flex flex-col min-w-0 backdrop-blur-sm">
    <div className="flex items-center gap-1 text-[9.5px] font-black uppercase tracking-wider text-white/70 whitespace-nowrap">
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </div>
    <div className="mt-1 flex items-baseline gap-1 min-w-0">
      <span className="text-xl sm:text-2xl font-black text-white tabular-nums leading-none">
        {value}
      </span>
      <span className="text-[9.5px] font-semibold text-white/50 tabular-nums whitespace-nowrap">
        {hint}
      </span>
    </div>
  </div>
);

export default AdultHeroCard;
