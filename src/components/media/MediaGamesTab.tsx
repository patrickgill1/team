// The new default view on the Media page. Games become the primary
// unit of media — one card per game, each card containing:
//   - Date + type badge (LEAGUE / TOURNAMENT / SCRIMMAGE)
//   - Score-line hero (team crest + score + opponent crest)
//   - Full-game inline preview (when a full_game recording exists)
//   - Category chip row (hides zero-count categories)
//   - Horizontal thumb strip of clips in the active category
//   - "View All N Clips" CTA to the game detail page
//
// Below the game list, a "More to Explore" strip surfaces the same
// coach-picked / most-liked / top-plays cuts that used to live inside
// the Highlights tab, now as one-tap entry points.
//
// Patrick 2026-09-13: "this really needs to be main focus of media,
// having it pull by game and then having the player highlights as well
// where it still pulls stats, but this is something my team uses a
// lot and can be a game changer for the app."

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Player, PlayerMedia as PlayerMediaType, Team, MomentType } from '../../types';
import { posterFor } from '../../utils/mediaPoster';
import OpponentCrest from './OpponentCrest';

interface Props {
  media: PlayerMediaType[];
  players: Player[];
  events: any[];
  fullGames: any[];
  selectedTeam: Team | null;
  onOpenLightbox: (clipId: string) => void;
  onOpenFullGame?: (fullGameId: string) => void;
}

type CategoryKey = 'all' | MomentType;

const CATEGORY_ORDER: Array<{ key: CategoryKey; label: string; short: string }> = [
  { key: 'all',     label: 'All Clips', short: 'All' },
  { key: 'goal',    label: 'Goals',     short: 'Goals' },
  { key: 'assist',  label: 'Assists',   short: 'Assists' },
  { key: 'save',    label: 'Saves',     short: 'Saves' },
  { key: 'defense', label: 'Defense',   short: 'Defense' },
  { key: 'shot',    label: 'Shots',     short: 'Shots' },
  { key: 'skill',   label: 'Skill',     short: 'Skill' },
];

function toDate(v: any): Date {
  if (!v) return new Date(NaN);
  if (v instanceof Date) return v;
  if (v?.toDate) return v.toDate();
  return new Date(v);
}

function shortDateLong(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function categoryIcon(kind: CategoryKey): React.ReactNode {
  const stroke = { strokeWidth: 2.25, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (kind === 'goal') {
    return <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...stroke}><circle cx="12" cy="12" r="9"/><path d="M12 3l2 6-4 3 4 3-2 6"/><path d="M3 12l6-2 3 4 3-4 6 2"/></svg>;
  }
  if (kind === 'assist') {
    return <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...stroke}><path d="M4 17 Q 12 4, 20 12"/><path d="M15 11 L 20 12 L 19 17"/></svg>;
  }
  if (kind === 'save') {
    return <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...stroke}><path d="M7 20V10a2 2 0 0 1 4 0v2"/><path d="M11 10V6a2 2 0 0 1 4 0v6"/><path d="M15 8a2 2 0 0 1 4 0v8a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-3"/></svg>;
  }
  if (kind === 'defense') {
    return <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...stroke}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg>;
  }
  if (kind === 'shot') {
    return <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...stroke}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>;
  }
  if (kind === 'skill') {
    return <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...stroke}><path d="M12 3l2.6 5.3 5.9.9-4.3 4.2 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.2 5.9-.9z"/></svg>;
  }
  // 'all' — 4-square grid
  return <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...stroke}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>;
}

interface GameCardProps {
  event: any;
  fullGame: any | null;
  clips: PlayerMediaType[];
  team: Team | null;
  onOpenLightbox: (clipId: string) => void;
  onOpenFullGame?: (fullGameId: string) => void;
}

const GameCard: React.FC<GameCardProps> = ({ event, fullGame, clips, team, onOpenLightbox, onOpenFullGame }) => {
  const [category, setCategory] = useState<CategoryKey>('all');
  const date = toDate(event.date);
  const opponent = String(event.opponent || 'Opponent').trim();
  const teamName = String(team?.name || '').trim() || 'Us';
  const typeLabel = String(event.gameType || event.type || 'game').toUpperCase();

  // Category counts — hides zero-count chips per the phones UX pass
  // (don't burn horizontal space on categories with no content).
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: clips.length };
    for (const clip of clips) {
      const k = clip.momentType || 'other';
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }, [clips]);

  const filtered = useMemo(() => {
    if (category === 'all') return clips;
    return clips.filter(c => c.momentType === category);
  }, [clips, category]);

  const visibleCategories = CATEGORY_ORDER.filter(c => c.key === 'all' || (counts[c.key] || 0) > 0);

  // Full-game poster — YouTube thumbnail if we have a videoId, else
  // let Cloudflare Stream render its own frame. Fallback: gradient.
  const fgPoster = fullGame
    ? (fullGame.youtubeId
        ? `https://i.ytimg.com/vi/${fullGame.youtubeId}/hqdefault.jpg`
        : (fullGame.thumbnailUrl || ''))
    : '';

  // Result parsing — "W 4-0" → { ours: 4, theirs: 0 }. Falls back to
  // score-unknown when the coach hasn't stamped a result.
  const score = useMemo(() => {
    if (!fullGame?.result) return null;
    const m = String(fullGame.result).match(/(\d+)\s*[-–]\s*(\d+)/);
    if (!m) return null;
    return { ours: Number(m[1]), theirs: Number(m[2]) };
  }, [fullGame]);

  const fullGameLength = fullGame?.videoDurationSeconds
    ? `${Math.floor(fullGame.videoDurationSeconds / 60)}:${String(Math.floor(fullGame.videoDurationSeconds % 60)).padStart(2, '0')}`
    : null;

  return (
    <article className="rounded-2xl bg-surface-elevated ring-1 ring-brand-primary/25 shadow-xl shadow-brand-primary/10 overflow-hidden">
      {/* Header row: date + type · title · share/kebab */}
      <header className="px-4 pt-3 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-black uppercase tracking-widest text-brand-primary-soft/90 mb-0.5">
              {shortDateLong(date)} <span className="text-ink-primary/45">·</span> {typeLabel}
            </div>
            <h3 className="text-base sm:text-lg font-black text-ink-primary leading-tight truncate">
              {event.title || `${teamName} vs ${opponent}`}
            </h3>
          </div>
          <Link
            to={`/events/${event.id}`}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-ink-primary/60 hover:text-ink-primary hover:bg-line-default/[0.08] transition"
            aria-label="Open game page"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </Link>
        </div>
      </header>

      {/* Score-line hero — team crest + score + opponent crest.
          When we don't have a score (no full_game or no result), we
          still render the crests + names but hide the numbers. */}
      <div className="mx-4 mb-3 rounded-xl bg-surface-raised ring-1 ring-line-default/15 px-3 py-3 flex items-center gap-3">
        {team?.logoUrl ? (
          <img loading="lazy" decoding="async" src={team.logoUrl} alt="" className="w-12 h-12 rounded-full object-cover ring-2 ring-white/15 shrink-0" />
        ) : (
          <OpponentCrest name={teamName} size={48} />
        )}
        <div className="flex-1 min-w-0 text-center">
          {score ? (
            <div className="text-2xl sm:text-3xl font-black tabular-nums leading-none text-ink-primary">
              <span>{score.ours}</span>
              <span className="text-ink-primary/35 mx-2">-</span>
              <span>{score.theirs}</span>
            </div>
          ) : (
            <div className="text-[11px] font-black uppercase tracking-widest text-ink-primary/45 leading-tight">vs</div>
          )}
          <div className="mt-1 flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-widest text-ink-primary/55 truncate">
            <span className="truncate">{teamName}</span>
            <span aria-hidden className="opacity-40">/</span>
            <span className="truncate">{opponent}</span>
          </div>
        </div>
        <OpponentCrest name={opponent} size={48} />
      </div>

      {/* Full-game preview tile — anchors the card visually and gives
          parents a one-tap "watch the whole game" affordance. Only
          rendered when a full_game recording is linked to this event. */}
      {fullGame && (
        <button
          type="button"
          onClick={() => onOpenFullGame?.(fullGame.id)}
          className="group relative block w-full aspect-video mb-3 overflow-hidden bg-black focus:outline-none focus:ring-2 focus:ring-brand-primary/60 theme-ok"
          aria-label={`Play full game vs ${opponent}`}
        >
          {fgPoster ? (
            <img
              src={fgPoster}
              alt=""
              aria-hidden
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-brand-primary-dim to-black theme-ok" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/25 theme-ok" />
          {/* Play glyph */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-brand-primary flex items-center justify-center shadow-2xl ring-4 ring-white/25 group-hover:scale-105 group-active:scale-95 transition theme-ok">
              <svg className="w-7 h-7 sm:w-8 sm:h-8 text-white ml-1" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                <polygon points="7 4 21 12 7 20 7 4" />
              </svg>
            </div>
          </div>
          {/* Bottom-left chip: "FULL GAME · N CLIPS" */}
          <span className="absolute left-3 bottom-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/70 backdrop-blur-sm text-white text-[10px] font-black uppercase tracking-widest ring-1 ring-white/15 theme-ok">
            Full Game
            {clips.length > 0 && (
              <>
                <span aria-hidden className="opacity-45">·</span>
                <span>{clips.length} Clip{clips.length === 1 ? '' : 's'}</span>
              </>
            )}
          </span>
          {/* Bottom-right chip: duration */}
          {fullGameLength && (
            <span className="absolute right-3 bottom-3 px-2 py-1 rounded-md bg-black/70 backdrop-blur-sm text-white text-[10px] font-black tabular-nums ring-1 ring-white/15 theme-ok">
              {fullGameLength}
            </span>
          )}
        </button>
      )}

      {/* Category chip row + horizontal clip strip. Only render when
          there's at least one clip — a card with just a full-game
          recording is fine to end there. */}
      {clips.length > 0 && (
        <div className="pb-3">
          {/* Chips: wrap on narrow screens per feedback_no_horizontal_pills. */}
          <div className="flex flex-wrap items-center gap-2 px-4 mb-2">
            {visibleCategories.map(c => {
              const active = category === c.key;
              const count = counts[c.key] || 0;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setCategory(c.key)}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-bold ring-1 transition ${
                    active
                      ? 'bg-brand-primary text-white ring-brand-primary shadow-sm'
                      : 'bg-transparent text-ink-primary/70 ring-line-default/25 hover:bg-line-default/[0.06]'
                  }`}
                >
                  <span className={active ? 'opacity-90' : 'opacity-55'}>{categoryIcon(c.key)}</span>
                  <span>{c.short}</span>
                  <span className={active ? 'opacity-80' : 'opacity-55'}>({count})</span>
                </button>
              );
            })}
          </div>

          {/* Horizontal thumb strip. Not pills — video posters, which
              is the standard Netflix/YouTube pattern for browse-video
              rows on mobile. Snap-scroll for thumb-friendly paging. */}
          <div className="flex gap-2 px-4 overflow-x-auto snap-x snap-mandatory pb-1 -mx-1 scrollbar-hide">
            {filtered.slice(0, 8).map(clip => {
              const poster = posterFor(clip);
              const duration = (clip as any).videoDurationSeconds;
              const durLabel = duration
                ? `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`
                : null;
              const kind = clip.momentType;
              const label = kind === 'goal' ? 'Goal'
                : kind === 'assist' ? 'Assist'
                : kind === 'save' ? 'Save'
                : kind === 'defense' ? 'Defense'
                : kind === 'shot' ? 'Shot'
                : kind === 'skill' ? 'Skill'
                : kind === 'big_play' ? 'Big play'
                : (clip as any).teamHighlight ? 'Team' : 'Clip';
              return (
                <div key={clip.id} className="snap-start shrink-0 w-[180px]">
                  <button
                    type="button"
                    onClick={() => onOpenLightbox(clip.id)}
                    className="group relative block w-full aspect-video rounded-lg overflow-hidden bg-black ring-1 ring-line-default/15 focus:outline-none focus:ring-2 focus:ring-brand-primary/60 theme-ok"
                    aria-label={`Play ${label} — ${clip.playerName || 'clip'}`}
                  >
                    {poster ? (
                      <img
                        src={poster}
                        alt=""
                        aria-hidden
                        loading="lazy"
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                    ) : (
                      <div className="absolute inset-0 bg-gradient-to-br from-surface-raised to-black theme-ok" />
                    )}
                    {durLabel && (
                      <span className="absolute right-1 bottom-1 px-1 py-0.5 rounded bg-black/75 text-white text-[9px] font-black tabular-nums ring-1 ring-white/15 theme-ok">
                        {durLabel}
                      </span>
                    )}
                  </button>
                  <div className="mt-1 px-0.5 flex items-center gap-1 text-ink-primary/85">
                    <span className="text-brand-primary-soft">{categoryIcon((kind || 'all') as CategoryKey)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-black leading-tight truncate">{label}</div>
                      <div className="text-[10px] text-ink-primary/60 leading-tight truncate">
                        {(clip as any).teamHighlight ? 'Team compilation' : (clip.playerName || '')}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* View all → game detail page (EventDetail's Highlights section). */}
          {filtered.length > 0 && (
            <div className="px-4 mt-3">
              <Link
                to={`/events/${event.id}`}
                className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-lg bg-surface-raised ring-1 ring-line-default/15 text-sm font-black text-ink-primary hover:bg-line-default/[0.08] transition"
              >
                <svg className="w-4 h-4 text-brand-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                </svg>
                View All {filtered.length} {filtered.length === 1 ? 'Clip' : 'Clips'}
              </Link>
            </div>
          )}
        </div>
      )}
    </article>
  );
};

// ────────────────────────────────────────────────────────────────────
// Main tab component
// ────────────────────────────────────────────────────────────────────

const MediaGamesTab: React.FC<Props> = ({
  media,
  players,
  events,
  fullGames,
  selectedTeam,
  onOpenLightbox,
  onOpenFullGame,
}) => {
  // Group clips by gameId. Only clips with a real gameId end up in a
  // section — unlinked clips don't have a game to belong to and would
  // just noise up an "Other" section. Coach can link retroactively
  // via the clip's edit menu.
  const clipsByGameId = useMemo(() => {
    const map = new Map<string, PlayerMediaType[]>();
    for (const clip of media) {
      const gid = String((clip as any).gameId || '');
      if (!gid) continue;
      const arr = map.get(gid) || [];
      arr.push(clip);
      map.set(gid, arr);
    }
    return map;
  }, [media]);

  // Match full_games to events (prefer explicit eventId, fall back to
  // opponent+date within 24h — same shape as HighlightsNetflixTab).
  const fullGameForEvent = useMemo(() => {
    const list = fullGames || [];
    const byEventId = new Map<string, any>();
    for (const fg of list) {
      const eid = String((fg as any).eventId || '');
      if (eid) byEventId.set(eid, fg);
    }
    return (ev: any): any | null => {
      const exact = byEventId.get(ev.id);
      if (exact) return exact;
      const opp = String(ev.opponent || '').trim().toLowerCase();
      const eventMs = toDate(ev.date).getTime();
      const DAY_MS = 24 * 60 * 60 * 1000;
      for (const fg of list) {
        if ((fg as any).eventId && (fg as any).eventId !== ev.id) continue;
        const fgOpp = String(fg.opponent || '').trim().toLowerCase();
        const fgDate: Date = fg.gameDate instanceof Date ? fg.gameDate : new Date(fg.gameDate);
        if (isNaN(fgDate.getTime())) continue;
        if (opp && fgOpp && opp === fgOpp && Math.abs(fgDate.getTime() - eventMs) < DAY_MS) return fg;
      }
      return null;
    };
  }, [fullGames]);

  // Build the game list: any event of type 'game' that either has a
  // linked full_game OR has clips linked to it. Silent-drop games
  // with zero media — they'd render as empty shells.
  const gameList = useMemo(() => {
    const games = (events || [])
      .filter(e => e && (e.type === 'game' || e.type === 'tournament'))
      .map(e => {
        const clips = (clipsByGameId.get(e.id) || []).slice()
          .sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
        const fg = fullGameForEvent(e);
        return { event: e, clips, fullGame: fg };
      })
      .filter(g => g.clips.length > 0 || !!g.fullGame);
    // Newest first — matches the "latest matches first" mental model.
    games.sort((a, b) => toDate(b.event.date).getTime() - toDate(a.event.date).getTime());
    return games;
  }, [events, clipsByGameId, fullGameForEvent]);

  if (gameList.length === 0) {
    return (
      <div className="text-center py-16 bg-surface-elevated rounded-2xl border border-line-default/10">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 text-brand-primary-soft flex items-center justify-center mb-4">
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="2"/><line x1="8" y1="4" x2="8" y2="20"/><line x1="16" y1="4" x2="16" y2="20"/>
          </svg>
        </div>
        <h3 className="text-lg font-black text-ink-primary">No games with media yet</h3>
        <p className="text-sm text-ink-primary/60 mt-1.5 max-w-xs mx-auto leading-snug">
          Upload a clip and link it to a game, or add a full-game recording. Games with attached media surface here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {gameList.map(g => (
        <GameCard
          key={g.event.id}
          event={g.event}
          fullGame={g.fullGame}
          clips={g.clips}
          team={selectedTeam}
          onOpenLightbox={onOpenLightbox}
          onOpenFullGame={onOpenFullGame}
        />
      ))}
    </div>
  );
};

export default MediaGamesTab;
