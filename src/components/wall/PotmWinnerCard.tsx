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

const InitialAvatar: React.FC<{ name: string }> = ({ name }) => (
  <div className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-full bg-gradient-to-br from-amber-400/50 to-amber-700/40 ring-4 ring-amber-300 shadow-2xl shadow-amber-900/60 flex items-center justify-center">
    <span className="text-4xl font-black text-amber-100">
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  </div>
);

const fmtDate = (raw: any): string => {
  if (!raw) return '';
  const d = raw?.toDate ? raw.toDate() : (raw instanceof Date ? raw : new Date(raw));
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

const PotmWinnerCard: React.FC<Props> = ({ potm, timestamp }) => {
  const [photoFailed, setPhotoFailed] = React.useState(false);
  const dateStr = fmtDate(potm.gameDate) || timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const title = potm.isCoWin ? 'Co-Player of the Match' : 'Player of the Match';
  const showPhoto = !!potm.playerPhotoUrl && !photoFailed;

  return (
    <article className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-400/40 via-amber-600/15 to-charcoal-950 ring-1 ring-amber-300/50 shadow-2xl shadow-amber-900/40">
      {/* Three-layer bloom: dominant top-right amber sun, secondary
          bottom-left warm gold, and a large center vignette that
          picks up the highlight around the portrait. */}
      <div className="absolute -top-20 -right-16 w-64 h-64 rounded-full bg-amber-300/45 blur-3xl pointer-events-none" aria-hidden />
      <div className="absolute -bottom-28 -left-24 w-72 h-72 rounded-full bg-amber-500/25 blur-3xl pointer-events-none" aria-hidden />
      <div className="absolute inset-0 bg-gradient-radial from-amber-300/10 via-transparent to-transparent pointer-events-none" aria-hidden />

      <header className="relative px-5 pt-4 pb-1 flex items-center gap-2">
        <span className="text-[10px] font-black tracking-[0.3em] uppercase px-2.5 py-1 rounded-full bg-gradient-to-r from-amber-300 to-amber-500 text-amber-950 shadow-md shadow-amber-900/40">
          Crown
        </span>
        <span className="text-[10px] font-black tracking-widest uppercase text-white/70">
          {title}
        </span>
        <span className="ml-auto text-[10px] font-bold text-white/60">{dateStr}</span>
      </header>

      <div className="relative px-5 py-6 flex items-center gap-5">
        {/* Player portrait with dramatic amber glow ring + floating
            crown. This is the money shot on Team Wall — kids screenshot
            this and text it to their grandparents. */}
        <div className="relative flex-shrink-0">
          {/* Outer bloom behind the ring */}
          <span aria-hidden className="absolute inset-0 -m-3 rounded-full bg-amber-300/25 blur-xl" />
          {/* Crown badge floating above the photo — bigger + glowier */}
          <span aria-hidden className="absolute -top-3 -right-3 z-10 inline-flex items-center justify-center w-11 h-11 rounded-full bg-gradient-to-br from-amber-200 via-amber-300 to-amber-500 text-amber-950 shadow-2xl shadow-amber-500/60 ring-2 ring-amber-100 rotate-12">
            <svg className="w-7 h-7 drop-shadow" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
            </svg>
          </span>
          {showPhoto ? (
            <div className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-full overflow-hidden ring-4 ring-amber-300 shadow-2xl shadow-amber-900/60">
              <img
                src={potm.playerPhotoUrl || ''}
                alt=""
                className="w-full h-full object-cover"
                onError={() => setPhotoFailed(true)}
              />
            </div>
          ) : (
            <InitialAvatar name={potm.playerName} />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-black tracking-[0.3em] uppercase text-amber-200 mb-0.5">
            Player of the Match
          </p>
          <h3 className="text-2xl sm:text-3xl font-black text-white leading-[1.1] break-words drop-shadow-lg">
            {potm.playerName}
          </h3>
          <p className="text-xs text-white/75 mt-1.5 truncate">{potm.gameTitle}</p>
          {potm.voteCount > 0 && (
            <p className="text-[11px] font-black tracking-wider text-amber-200 mt-2 uppercase">
              {potm.voteCount} vote{potm.voteCount === 1 ? '' : 's'}
            </p>
          )}
        </div>
      </div>

      <footer className="relative px-5 py-2.5 border-t border-amber-300/15 flex items-center justify-between text-[10px] font-black tracking-widest uppercase text-white/55">
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
