import React from 'react';
import { Link } from 'react-router-dom';
import type { WallPost } from '../../types';
import { normalizeKit } from '../../utils/kitColors';

// Sports-page hero for game-recap wall posts. Renders a big score bug
// with kit-color accents, the outcome as an outsized initial (W/L/D),
// scorers + assists lists, and a "See game" link into the calendar
// event when the recap carries an eventId.
//
// The Wall page reads WallPost.recap and, if present, renders this
// component INSTEAD of the standard markdown card. Posts without the
// recap payload fall through to the legacy markdown render, so old
// recaps aren't broken.

interface Props {
  recap: NonNullable<WallPost['recap']>;
  timestamp: Date;
}

const OUTCOME_TONE: Record<'W' | 'L' | 'D', { fg: string; bg: string; ring: string; label: string }> = {
  W: { fg: 'text-emerald-100', bg: 'bg-emerald-500/20', ring: 'ring-emerald-400/40', label: 'WIN' },
  L: { fg: 'text-rose-100', bg: 'bg-rose-500/20', ring: 'ring-rose-400/40', label: 'LOSS' },
  D: { fg: 'text-amber-100', bg: 'bg-amber-500/20', ring: 'ring-amber-400/40', label: 'DRAW' },
};

const fmtDate = (raw: any): string => {
  if (!raw) return '';
  const d = raw?.toDate ? raw.toDate() : (raw instanceof Date ? raw : new Date(raw));
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

const GameRecapCard: React.FC<Props> = ({ recap, timestamp }) => {
  const tone = OUTCOME_TONE[recap.outcome] || OUTCOME_TONE.D;
  const dateStr = fmtDate(recap.gameDate);
  const isHome = recap.homeAway !== 'away';
  const ourKit = isHome ? recap.homeKitColor : recap.awayKitColor;
  const oppKit = isHome ? recap.awayKitColor : recap.homeKitColor;

  return (
    <article className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-charcoal-900 via-charcoal-800 to-charcoal-900 ring-1 ring-line-default/15 shadow-xl shadow-black/40">
      {/* subtle stadium-light bloom top-right */}
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-brand-primary/20 blur-3xl pointer-events-none" aria-hidden />
      <div className="absolute -bottom-20 -left-20 w-48 h-48 rounded-full bg-brand-primary-soft/10 blur-3xl pointer-events-none" aria-hidden />

      <header className="relative px-5 pt-4 pb-2 flex items-center gap-2">
        <span className={`text-[10px] font-black tracking-[0.25em] uppercase px-2 py-0.5 rounded ring-1 ${tone.bg} ${tone.fg} ${tone.ring}`}>
          {tone.label}
        </span>
        <span className="text-[10px] font-black tracking-widest uppercase text-white/45">
          Full time
        </span>
        {dateStr && (
          <span className="ml-auto text-[10px] font-bold text-white/45">{dateStr}</span>
        )}
      </header>

      <div className="relative px-5 py-4 flex items-center gap-3">
        <TeamPill name={recap.ourName || 'Us'} kitColor={ourKit} align="left" isHome={isHome} />
        <div className="text-center px-2">
          <p className="text-4xl sm:text-5xl font-black text-white tabular-nums leading-none tracking-tight">
            <span className={recap.outcome === 'W' ? 'text-emerald-200' : recap.outcome === 'L' ? 'text-white/75' : 'text-white'}>
              {recap.ourScore}
            </span>
            <span className="text-white/30 mx-1.5">–</span>
            <span className={recap.outcome === 'L' ? 'text-rose-200' : recap.outcome === 'W' ? 'text-white/75' : 'text-white'}>
              {recap.opponentScore}
            </span>
          </p>
        </div>
        <TeamPill name={recap.opponent || 'Opp'} kitColor={oppKit} align="right" />
      </div>

      {(recap.scorers?.length || recap.assists?.length) && (
        <div className="relative px-5 pb-4 pt-1 border-t border-white/5 space-y-1.5">
          {recap.scorers && recap.scorers.length > 0 && (
            <p className="text-xs text-white/80">
              <span className="text-[10px] font-black tracking-widest uppercase text-white/40 mr-2">Goals</span>
              {recap.scorers.map(s => s.count > 1 ? `${s.name} ×${s.count}` : s.name).join(', ')}
            </p>
          )}
          {recap.assists && recap.assists.length > 0 && (
            <p className="text-xs text-white/70">
              <span className="text-[10px] font-black tracking-widest uppercase text-white/40 mr-2">Assists</span>
              {recap.assists.map(a => a.count > 1 ? `${a.name} ×${a.count}` : a.name).join(', ')}
            </p>
          )}
        </div>
      )}

      <footer className="relative px-5 py-2.5 border-t border-white/5 flex items-center justify-between text-[10px] font-black tracking-widest uppercase text-white/45">
        <span>{timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        {recap.eventId && (
          <Link
            to={`/game/${recap.eventId}`}
            className="text-brand-primary-soft hover:text-brand-primary"
          >
            See game →
          </Link>
        )}
      </footer>
    </article>
  );
};

// Small pill showing "team name" with a kit-color dot. When the coach
// hasn't set a kit color on their team doc, falls back to a neutral
// bone tint so the pill still renders cleanly.
const TeamPill: React.FC<{ name: string; kitColor?: string; align: 'left' | 'right'; isHome?: boolean }> = ({
  name,
  kitColor,
  align,
  isHome,
}) => {
  const colorHex = normalizeKit(kitColor);
  return (
    <div className={`flex-1 min-w-0 flex items-center gap-2 ${align === 'right' ? 'flex-row-reverse text-right' : ''}`}>
      <span
        className="w-3 h-3 rounded-full ring-1 ring-white/25 shrink-0"
        style={{ backgroundColor: colorHex || '#94a3b8' }}
        aria-hidden
      />
      <div className="min-w-0">
        <p className="text-[10px] font-black tracking-widest uppercase text-white/45 truncate">
          {isHome != null ? (isHome ? 'Home' : 'Away') : ''}
        </p>
        <p className="text-sm sm:text-base font-black text-white truncate leading-tight">{name}</p>
      </div>
    </div>
  );
};

export default GameRecapCard;
