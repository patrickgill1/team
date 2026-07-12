import React from 'react';
import { Link } from 'react-router-dom';

// WeeklySpotlightCard — a two-row amber "Awards" card that surfaces
// the team's most-recent POTM winner (row 1) and most-recent coach's
// -pick recipient (row 2). Renders on Team HQ between FamilyFeed
// and the "New for you" strip.
//
// Silent empty: if neither slot is set (nothing in the 14-day window),
// returns null. Never renders a "no spotlights yet" placeholder —
// silence beats faux content per the atomic-render standard.
//
// Coach's-pick note text is intentionally NOT rendered here for
// team-wide viewers, per Phase-1 recognition privacy (writeGuards.ts
// design comment: "warm, not urgent, no team-wide fanout"). The row
// shows a generic celebration line "Coach recognized {name}'s
// effort"; the actual coach note stays private in the honoree
// family's own Whispers tab.

export interface SpotlightPotm {
  playerId: string;
  playerName: string;
  playerPhotoUrl?: string | null;
  gameTitle?: string;
  /** True for co-winners so the row reads "Co-Player of the Match". */
  isCoWin?: boolean;
  closedAt: Date;
}

export interface SpotlightPick {
  playerId: string;
  playerName: string;
  playerPhotoUrl?: string | null;
  earnedAt: Date;
}

interface Props {
  potm: SpotlightPotm | null;
  pick: SpotlightPick | null;
}

const InitialAvatar: React.FC<{ name: string }> = ({ name }) => (
  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-amber-400/50 to-amber-700/40 ring-2 ring-amber-300/70 flex items-center justify-center shrink-0">
    <span className="text-lg font-black text-amber-100">
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  </div>
);

const PhotoOrInitial: React.FC<{ name: string; url?: string | null }> = ({ name, url }) => {
  const [failed, setFailed] = React.useState(false);
  const show = !!url && !failed;
  if (!show) return <InitialAvatar name={name} />;
  return (
    <div className="relative w-12 h-12 rounded-full overflow-hidden ring-2 ring-amber-300/70 shrink-0">
      <img
        src={url || ''}
        alt=""
        className="w-full h-full object-cover"
        onError={() => setFailed(true)}
        loading="lazy"
      />
    </div>
  );
};

const firstName = (full: string): string => (full || '').split(' ')[0] || full;

const WeeklySpotlightCard: React.FC<Props> = ({ potm, pick }) => {
  if (!potm && !pick) return null;

  const potmTitle = potm?.isCoWin ? 'Co-Player of the Match' : 'Player of the Match';

  return (
    <section
      aria-label="Awards"
      className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-500/12 via-surface-elevated to-surface-base ring-1 ring-amber-400/25 shadow-lg shadow-amber-900/10 animate-in fade-in duration-300"
    >
      {/* Soft amber bloom top-right so the card reads as "award"
          without competing with the photos in the rows. */}
      <div
        aria-hidden
        className="absolute -top-12 -right-10 w-40 h-40 rounded-full bg-amber-300/20 blur-3xl pointer-events-none"
      />

      <header className="relative px-4 pt-3 pb-2 flex items-center gap-2">
        <span className="text-[10px] font-black tracking-[0.3em] uppercase text-amber-300">
          Awards
        </span>
        <span className="ml-auto text-[10px] font-bold text-ink-primary/45 tracking-widest uppercase">
          This week
        </span>
      </header>

      <div className="relative px-2 pb-2">
        {potm && (
          <Link
            to={`/player/${potm.playerId}`}
            className="flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-amber-500/[0.06] active:bg-amber-500/[0.09] transition group"
          >
            <PhotoOrInitial name={potm.playerName} url={potm.playerPhotoUrl} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-black text-ink-primary truncate">
                {potm.playerName}
              </div>
              <div className="text-[11px] text-amber-300 font-bold uppercase tracking-wider truncate flex items-center gap-1.5">
                <span>{potmTitle}</span>
                {potm.gameTitle && (
                  <>
                    <span className="w-1 h-1 rounded-full bg-amber-400/60" aria-hidden />
                    <span className="text-ink-primary/60 normal-case tracking-normal font-semibold truncate">
                      {potm.gameTitle}
                    </span>
                  </>
                )}
              </div>
            </div>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="w-4 h-4 text-ink-primary/40 group-hover:text-ink-primary/70 transition shrink-0"
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
            </svg>
          </Link>
        )}

        {potm && pick && (
          <div className="mx-4 border-t border-amber-400/15" aria-hidden />
        )}

        {pick && (
          <Link
            to={`/player/${pick.playerId}`}
            className="flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-amber-500/[0.06] active:bg-amber-500/[0.09] transition group"
          >
            <PhotoOrInitial name={pick.playerName} url={pick.playerPhotoUrl} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-black text-ink-primary truncate">
                {pick.playerName}
              </div>
              <div className="text-[11px] text-amber-300 font-bold uppercase tracking-wider truncate flex items-center gap-1.5">
                <span>Coach's Pick</span>
                <span className="w-1 h-1 rounded-full bg-amber-400/60" aria-hidden />
                <span className="text-ink-primary/60 normal-case tracking-normal font-semibold truncate">
                  Coach recognized {firstName(pick.playerName)}'s effort
                </span>
              </div>
            </div>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="w-4 h-4 text-ink-primary/40 group-hover:text-ink-primary/70 transition shrink-0"
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
            </svg>
          </Link>
        )}
      </div>
    </section>
  );
};

export default WeeklySpotlightCard;
