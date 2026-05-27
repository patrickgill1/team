// @ts-nocheck
import React, { useMemo } from 'react';
import { getShareOrigin } from '../../utils/origin';

interface TimelineEntry {
  id: string;
  kind: string;
  minute: number;
  playerId?: string;
  playerName?: string;
  jerseyNumber?: number;
}

interface Props {
  event: any;
  game: any;
  teamName: string;
  players: any[];
  /** Optional: paste the recap into a chat thread (post-game share to team). */
  onPostToChat?: (text: string) => void;
}

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/**
 * Auto-generated end-of-game recap card. Renders once the game is
 * finalized — meant for parents to screenshot/share, and as the
 * default content seeded into the chat "Post recap" CTA.
 */
const GameRecapCard: React.FC<Props> = ({ event, game, teamName, players, onPostToChat }) => {
  const ourScore = game?.ourScore ?? 0;
  const oppScore = game?.oppScore ?? 0;
  const opponent = event?.opponent || game?.opponent || 'Opponent';
  const homeAway = event?.homeAway || game?.homeAway;
  const won = ourScore > oppScore;
  const tied = ourScore === oppScore;
  const result: 'W' | 'L' | 'T' = won ? 'W' : tied ? 'T' : 'L';
  const tone = won
    ? 'from-emerald-600 via-emerald-700 to-emerald-900'
    : tied
      ? 'from-amber-600 via-amber-700 to-amber-900'
      : 'from-rose-700 via-rose-800 to-rose-950';

  const timeline: TimelineEntry[] = game?.timeline || [];

  // Group scorers with their assists. We don't have an explicit
  // "assisted by" link in the timeline, so we use the heuristic that
  // an assist within the previous 30 seconds of game-clock counts.
  const scorers = useMemo(() => {
    const goals = timeline.filter(t => t.kind === 'goal');
    const assists = timeline.filter(t => t.kind === 'assist');
    return goals
      .sort((a, b) => a.minute - b.minute)
      .map(g => {
        const assister = assists.find(a => Math.abs(a.minute - g.minute) <= 1);
        return {
          name: g.playerName || '?',
          jersey: g.jerseyNumber,
          minute: g.minute,
          assistBy: assister?.playerName,
        };
      });
  }, [timeline]);

  // Player who recorded the most goals — the natural MVP heuristic.
  const mvp = useMemo(() => {
    const goalCounts = new Map<string, { name: string; goals: number; assists: number; minutes: number; photoUrl?: string; jersey?: number }>();
    for (const p of players) {
      goalCounts.set(p.id, { name: p.name, goals: 0, assists: 0, minutes: 0, photoUrl: p.profilePhotoUrl, jersey: p.jerseyNumber });
    }
    for (const t of timeline) {
      if (!t.playerId) continue;
      const r = goalCounts.get(t.playerId);
      if (!r) continue;
      if (t.kind === 'goal') r.goals += 1;
      else if (t.kind === 'assist') r.assists += 1;
    }
    const minutes = game?.lineup?.minutes || {};
    for (const [pid, secs] of Object.entries(minutes)) {
      const r = goalCounts.get(pid);
      if (r) r.minutes = Math.round(((secs as number) || 0) / 60);
    }
    const ranked = Array.from(goalCounts.values())
      .filter(r => r.goals + r.assists > 0 || r.minutes > 0)
      .sort((a, b) => {
        const sa = a.goals * 3 + a.assists * 2;
        const sb = b.goals * 3 + b.assists * 2;
        if (sb !== sa) return sb - sa;
        return b.minutes - a.minutes;
      });
    return ranked[0] || null;
  }, [timeline, players, game]);

  // Top minutes players (up to 3) — for the "Iron men" badge.
  const ironMen = useMemo(() => {
    const minutes = game?.lineup?.minutes || {};
    const ranked = Object.entries(minutes)
      .map(([pid, secs]) => {
        const p = players.find(p => p.id === pid);
        return { id: pid, name: p?.name || 'Player', minutes: Math.round(((secs as number) || 0) / 60) };
      })
      .filter(r => r.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 3);
    return ranked;
  }, [game, players]);

  // Plain-text representation used for navigator.share and (optionally)
  // for posting straight to chat.
  const shareText = useMemo(() => {
    const opp = opponent || 'Opponent';
    const summary = `${teamName} ${ourScore} – ${oppScore} ${opp} (${result})`;
    const lines: string[] = [summary];
    if (scorers.length > 0) {
      lines.push('');
      lines.push('⚽ Goals:');
      for (const s of scorers) {
        const assist = s.assistBy ? ` (assist: ${s.assistBy})` : '';
        lines.push(`  ${ordinal(s.minute)}'  ${s.name}${assist}`);
      }
    }
    if (mvp && mvp.goals + mvp.assists > 0) {
      lines.push('');
      lines.push(`🏆 MVP: ${mvp.name} — ${mvp.goals} G, ${mvp.assists} A`);
    }
    return lines.join('\n');
  }, [teamName, ourScore, oppScore, opponent, result, scorers, mvp]);

  const shareUrl = event?.id ? `${getShareOrigin()}/event/${event.id}` : getShareOrigin();

  const handleShare = async () => {
    const data = { title: `${teamName} vs ${opponent}`, text: shareText, url: shareUrl };
    try {
      if (navigator.share) {
        await navigator.share(data);
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
        alert('Recap copied to clipboard.');
      }
    } catch (err) {
      // User cancelled — silent.
    }
  };

  return (
    <section className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${tone} text-white shadow-2xl ring-1 ring-white/10`}>
      <div className="absolute -top-16 -right-16 w-48 h-48 bg-white/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-20 -left-10 w-56 h-56 bg-white/5 rounded-full blur-3xl pointer-events-none" />
      <div className="relative p-5 sm:p-6">
        {/* Header row */}
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-white/15 ring-1 ring-white/20">
            Final
          </span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-white/80">
            {won ? 'Win' : tied ? 'Draw' : 'Loss'}
          </span>
          {homeAway && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-white/70">
              {homeAway === 'home' ? '🏠 Home' : '✈️ Away'}
            </span>
          )}
        </div>

        {/* Scoreline */}
        <div className="grid grid-cols-3 items-center text-center gap-2 mb-4">
          <div className="min-w-0">
            <p className="text-xs text-white/70 truncate">{teamName}</p>
            <p className="text-5xl font-black tabular-nums leading-none">{ourScore}</p>
          </div>
          <p className="text-white/40 font-bold text-sm tracking-widest">vs.</p>
          <div className="min-w-0">
            <p className="text-xs text-white/70 truncate">{opponent}</p>
            <p className="text-5xl font-black tabular-nums leading-none">{oppScore}</p>
          </div>
        </div>

        {/* Scorers */}
        {scorers.length > 0 && (
          <div className="mb-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-white/70 mb-1.5">⚽ Goals</p>
            <ul className="space-y-1">
              {scorers.map((s, i) => (
                <li key={i} className="text-sm flex items-center justify-between gap-2">
                  <span className="font-semibold truncate">
                    {s.jersey != null ? `#${s.jersey} ` : ''}{s.name}
                  </span>
                  <span className="text-xs text-white/75 flex-shrink-0">
                    {ordinal(s.minute)}'
                    {s.assistBy ? ` · 🎯 ${s.assistBy}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* MVP */}
        {mvp && mvp.goals + mvp.assists > 0 && (
          <div className="mb-4 flex items-center gap-3 p-3 rounded-2xl bg-white/10 ring-1 ring-white/15">
            <div className="relative flex-shrink-0">
              {mvp.photoUrl ? (
                <img src={mvp.photoUrl} alt={mvp.name} className="w-12 h-12 rounded-full object-cover ring-2 ring-amber-300" />
              ) : (
                <div className="w-12 h-12 rounded-full bg-amber-400/90 text-amber-900 font-black flex items-center justify-center ring-2 ring-amber-300">
                  {mvp.name.charAt(0)}
                </div>
              )}
              <span className="absolute -bottom-1 -right-1 text-base">🏆</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-wider text-amber-200">MVP</p>
              <p className="font-bold truncate">{mvp.name}</p>
              <p className="text-xs text-white/80">{mvp.goals} goal{mvp.goals === 1 ? '' : 's'} · {mvp.assists} assist{mvp.assists === 1 ? '' : 's'} · {mvp.minutes} min</p>
            </div>
          </div>
        )}

        {/* Iron men (top minutes) */}
        {ironMen.length > 0 && (
          <div className="mb-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-white/70 mb-1.5">⛓️ Most minutes</p>
            <ul className="space-y-0.5">
              {ironMen.map((p) => (
                <li key={p.id} className="text-sm flex items-center justify-between gap-2">
                  <span className="font-semibold truncate">{p.name}</span>
                  <span className="text-xs text-white/75 flex-shrink-0">{p.minutes} min</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleShare}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white text-fire-900 font-bold text-sm shadow active:scale-95"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
            </svg>
            Share recap
          </button>
          {onPostToChat && (
            <button
              onClick={() => onPostToChat(shareText)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/15 hover:bg-white/25 ring-1 ring-white/20 font-bold text-sm active:scale-95"
            >
              💬 Post to chat
            </button>
          )}
        </div>
      </div>
    </section>
  );
};

export default GameRecapCard;
