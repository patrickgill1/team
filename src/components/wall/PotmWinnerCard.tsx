import React from 'react';
import { Link } from 'react-router-dom';
import type { WallPost } from '../../types';

// Crown celebration hero for Player-of-the-Match winners. Rendered by
// the Wall page when a wall post carries a structured potmResult
// payload (autoPostPotmToWall). Amber-gradient background with a
// stadium-light bloom, huge crown, player photo, name, vote count.
// Doubles as a career milestone the parent can screenshot.

interface Props {
  potm: NonNullable<WallPost['potmResult']>;
  timestamp: Date;
}

const fmtDate = (raw: any): string => {
  if (!raw) return '';
  const d = raw?.toDate ? raw.toDate() : (raw instanceof Date ? raw : new Date(raw));
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

const PotmWinnerCard: React.FC<Props> = ({ potm, timestamp }) => {
  const dateStr = fmtDate(potm.gameDate) || timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const title = potm.isCoWin ? 'Co-Player of the Match' : 'Player of the Match';

  return (
    <article className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-500/25 via-amber-600/10 to-charcoal-900 ring-1 ring-amber-400/30 shadow-xl shadow-black/40">
      <div className="absolute -top-16 -right-14 w-48 h-48 rounded-full bg-amber-400/25 blur-3xl pointer-events-none" aria-hidden />
      <div className="absolute -bottom-24 -left-20 w-56 h-56 rounded-full bg-amber-500/10 blur-3xl pointer-events-none" aria-hidden />

      <header className="relative px-5 pt-4 pb-1 flex items-center gap-2">
        <span className="text-[10px] font-black tracking-[0.25em] uppercase px-2 py-0.5 rounded bg-amber-400/20 text-amber-100 ring-1 ring-amber-300/40">
          Crown
        </span>
        <span className="text-[10px] font-black tracking-widest uppercase text-white/50">
          {title}
        </span>
        <span className="ml-auto text-[10px] font-bold text-white/45">{dateStr}</span>
      </header>

      <div className="relative px-5 py-4 flex items-center gap-4">
        {/* Player photo — big circle. Amber ring so it reads as a
            trophy portrait rather than a roster avatar. */}
        <div className="relative flex-shrink-0">
          {/* Crown badge floating above the photo */}
          <span aria-hidden className="absolute -top-2 -right-2 z-10 inline-flex items-center justify-center w-8 h-8 rounded-full bg-amber-400 text-amber-950 shadow-lg ring-2 ring-amber-100">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
            </svg>
          </span>
          {potm.playerPhotoUrl ? (
            <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full overflow-hidden ring-4 ring-amber-300/50 shadow-2xl">
              <img src={potm.playerPhotoUrl} alt="" className="w-full h-full object-cover" />
            </div>
          ) : (
            <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-amber-500/20 ring-4 ring-amber-300/40 flex items-center justify-center">
              <span className="text-3xl font-black text-amber-100">
                {potm.playerName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-black tracking-widest uppercase text-amber-200/70">
            Player of the Match
          </p>
          <h3 className="text-xl sm:text-2xl font-black text-white leading-tight break-words">
            {potm.playerName}
          </h3>
          <p className="text-xs text-white/70 mt-1 truncate">{potm.gameTitle}</p>
          {potm.voteCount > 0 && (
            <p className="text-[11px] font-bold text-amber-200 mt-1.5">
              {potm.voteCount} vote{potm.voteCount === 1 ? '' : 's'}
            </p>
          )}
        </div>
      </div>

      <footer className="relative px-5 py-2.5 border-t border-white/5 flex items-center justify-between text-[10px] font-black tracking-widest uppercase text-white/45">
        <span>Team crown</span>
        {potm.playerId && (
          <Link
            to={`/player/${potm.playerId}`}
            className="text-amber-200 hover:text-amber-100"
          >
            See player →
          </Link>
        )}
      </footer>
    </article>
  );
};

export default PotmWinnerCard;
