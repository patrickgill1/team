// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useViewMode } from '../../contexts/ViewModeContext';
import { isCoach } from '../../utils/helpers';

/**
 * Coach team-health roll-up — one-glance summary of how the team's
 * dev plans are tracking this week. Patrick 2026-06-21 dialogue
 * idea #3: 'Player check-in roll-up. Single card showing which kids
 * have/haven't logged practice this week.'
 *
 * Reads `player.currentStreakDays` (the denormalized field the rest
 * of the app trusts for streaks) so we don't recompute from plans
 * here. Per memory the streak helper skips Sundays for religious
 * families; the denormalized count already honors that.
 *
 * V1 scope: card shows the on-streak ratio + lists up to 4 kids who
 * haven't logged this week (the ones a coach might want to nudge).
 * Tapping the card opens /development for the deeper view. No nudge
 * action in v1 — that would push to parents of non-loggers and we
 * want a measured UX pass before automating that.
 *
 * Visible to coaches only. Hidden when:
 *   - user is not a coach
 *   - team has no active players
 *   - 100% of players are on streak (nothing to surface)
 */

interface PlayerLite {
  id: string;
  name: string;
  currentStreakDays: number;
  hasLoggedThisWeek: boolean;
}

const CoachTeamHealthCard: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const [players, setPlayers] = useState<PlayerLite[]>([]);
  const [loaded, setLoaded] = useState(false);

  const { viewMode } = useViewMode();
  const isUserCoach = isCoach((userData as any)?.role) && viewMode === 'coach';

  useEffect(() => {
    if (!isUserCoach || !selectedTeamId) { setLoaded(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const playersQ = query(
          collection(db, 'players'),
          where('isActive', '==', true)
        );
        const snap = await getDocs(playersQ);
        if (cancelled) return;

        const teamPlayers: PlayerLite[] = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => {
            if (Array.isArray(p.teamIds) && p.teamIds.includes(selectedTeamId)) return true;
            if (p.teamId === selectedTeamId) return true;
            return false;
          })
          .map((p: any) => ({
            id: p.id,
            name: p.name || 'Player',
            currentStreakDays: p.currentStreakDays || 0,
            hasLoggedThisWeek: (p.currentStreakDays || 0) > 0,
          }));

        setPlayers(teamPlayers);
      } catch (err) {
        console.warn('[coach-team-health] load failed', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isUserCoach, selectedTeamId]);

  const stats = useMemo(() => {
    const total = players.length;
    const onStreak = players.filter((p) => p.hasLoggedThisWeek).length;
    const slackers = players
      .filter((p) => !p.hasLoggedThisWeek)
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 4);
    return { total, onStreak, slackers };
  }, [players]);

  if (!isUserCoach) return null;
  if (!loaded) return null;
  if (stats.total === 0) return null;
  // Everyone's on streak — nothing to surface, skip the card.
  if (stats.slackers.length === 0) return null;

  // Color the ratio by health: amber when most-on, crimson when
  // most-off, neutral when split.
  const ratio = stats.onStreak / stats.total;
  const ratioTint = ratio >= 0.66 ? 'text-emerald-300' : ratio >= 0.33 ? 'text-amber-300' : 'text-crimson-300';

  return (
    <Link
      to="/development"
      className="block rounded-2xl bg-charcoal-900 ring-1 ring-white/10 hover:ring-crimson-500/30 transition group animate-fade-in"
    >
      <div className="px-4 py-3 sm:px-5 sm:py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-extrabold tracking-widest uppercase text-bone/55">Team health · this week</p>
            <p className="text-[15px] font-black text-bone mt-0.5">
              <span className={`tabular-nums ${ratioTint}`}>{stats.onStreak}</span>
              <span className="text-bone/70 font-bold"> of {stats.total}</span>
              <span className="text-bone/55 font-normal text-sm"> on streak</span>
            </p>
          </div>
          <svg className="w-4 h-4 text-bone/40 group-hover:text-crimson-300 transition-colors shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6" /></svg>
        </div>

        {stats.slackers.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {stats.slackers.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center gap-1 rounded-full bg-bone/5 ring-1 ring-white/10 px-2 py-0.5 text-[11px] font-semibold text-bone/75"
              >
                <span className="w-1 h-1 rounded-full bg-bone/30" aria-hidden />
                {p.name.split(' ')[0]}
              </span>
            ))}
            {stats.total - stats.onStreak > stats.slackers.length && (
              <span className="inline-flex items-center text-[11px] font-bold text-bone/45 px-1">
                +{stats.total - stats.onStreak - stats.slackers.length} more
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
};

export default CoachTeamHealthCard;
