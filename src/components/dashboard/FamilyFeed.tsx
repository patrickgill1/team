import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import type { CalendarEvent } from '../../types';

// FamilyFeed — cross-team home surface for users who belong to more
// than one team. Renders inline on the Dashboard above the standard
// per-team hero.
//
// Solo-team users don't see this at all (component returns null in
// that case). Everyone with 2+ teams gets:
//   1. One card per team showing "next event" summary + team badge
//   2. A chronological "this week" rollup across every team
//
// Firestore lookups are parallel across teams — N is small in
// practice (2-5) so we don't need the array-contains-any batching.

interface Props {
  /** Suppress the whole component (e.g. dashboard already showing
   *  another team-specific view). Callers usually leave undefined. */
  hidden?: boolean;
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Assigned team color used for the badge + timeline dot. Keeps the
// palette consistent across the two visual surfaces. Cycles for
// coaches with 3+ teams; index-stable so the same team always gets
// the same color across renders.
const TEAM_TINTS: Array<{ chip: string; dot: string; ring: string }> = [
  { chip: 'bg-brand-primary/15 text-brand-primary-soft', dot: 'bg-brand-primary', ring: 'ring-brand-primary/30' },
  { chip: 'bg-emerald-500/15 text-emerald-300', dot: 'bg-emerald-400', ring: 'ring-emerald-500/30' },
  { chip: 'bg-amber-500/15 text-amber-300', dot: 'bg-amber-400', ring: 'ring-amber-500/30' },
  { chip: 'bg-violet-500/15 text-violet-300', dot: 'bg-violet-400', ring: 'ring-violet-500/30' },
  { chip: 'bg-sky-500/15 text-sky-300', dot: 'bg-sky-400', ring: 'ring-sky-500/30' },
  { chip: 'bg-rose-500/15 text-rose-300', dot: 'bg-rose-400', ring: 'ring-rose-500/30' },
];

interface TeamEventsSummary {
  teamId: string;
  teamName: string;
  ageGroup?: string;
  nextEvent: CalendarEvent | null;
  upcomingThisWeek: CalendarEvent[];
  colorIdx: number;
}

function fmtEventTime(d: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysAhead = Math.round((eventDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (daysAhead === 0) return `Today · ${timeStr}`;
  if (daysAhead === 1) return `Tomorrow · ${timeStr}`;
  if (daysAhead >= 2 && daysAhead < 7) return `${DOW_SHORT[d.getDay()]} · ${timeStr}`;
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()} · ${timeStr}`;
}

const FamilyFeed: React.FC<Props> = ({ hidden }) => {
  const { userData } = useAuth();
  const { teams, setSelectedTeamId } = useTeam();
  const [summaries, setSummaries] = useState<TeamEventsSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const userTeams = useMemo(() => {
    const teamIds: string[] = Array.isArray(userData?.teamIds) && userData.teamIds.length > 0
      ? userData.teamIds
      : (userData?.teamId ? [userData.teamId] : []);
    // Skip archived teams — they'd clutter the multi-team surface
    // with rosters/schedules the user isn't actively using. Team
    // Management can restore them if needed.
    return teams.filter((t) => teamIds.includes(t.id) && (t as any).isActive !== false);
  }, [teams, userData?.teamIds, userData?.teamId]);

  const shouldRender = !hidden && userTeams.length > 1;

  useEffect(() => {
    if (!shouldRender) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const now = new Date();
      const endOfWeek = new Date(now);
      endOfWeek.setDate(now.getDate() + 7);
      try {
        const rows = await Promise.all(
          userTeams.map(async (team, i) => {
            const eventsSnap = await getDocs(query(
              collection(db, 'events'),
              where('teamId', '==', team.id),
              where('date', '>=', now),
              orderBy('date', 'asc'),
              limit(20),
            )).catch(() => null);
            const evs: CalendarEvent[] = eventsSnap
              ? eventsSnap.docs.map((d) => {
                  const data: any = d.data() || {};
                  const date = data.date?.toDate ? data.date.toDate() : new Date(data.date);
                  return { id: d.id, ...data, date } as CalendarEvent;
                }).filter((e: any) => !e.isCancelled)
              : [];
            const upcomingThisWeek = evs.filter((e) => {
              const d = new Date(e.date);
              return d >= now && d <= endOfWeek;
            });
            return {
              teamId: team.id,
              teamName: team.name,
              ageGroup: (team as any).ageGroup,
              nextEvent: evs[0] || null,
              upcomingThisWeek,
              colorIdx: i % TEAM_TINTS.length,
            } as TeamEventsSummary;
          }),
        );
        if (!cancelled) setSummaries(rows);
      } catch (err) {
        console.warn('[FamilyFeed] load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shouldRender, userTeams.map((t) => t.id).join(',')]);

  if (!shouldRender) return null;

  const weekEvents = useMemo(() => {
    const all: Array<{ ev: CalendarEvent; summary: TeamEventsSummary }> = [];
    for (const s of summaries) {
      for (const ev of s.upcomingThisWeek) all.push({ ev, summary: s });
    }
    all.sort((a, b) => new Date(a.ev.date).getTime() - new Date(b.ev.date).getTime());
    return all;
  }, [summaries]);

  const handleFocusTeam = (teamId: string) => {
    setSelectedTeamId(teamId);
    // Dashboard listens for selectedTeamId changes and re-fetches; no
    // manual navigation needed. If a future refactor requires an
    // explicit navigate, adding it here is a one-liner.
  };

  return (
    <section className="mt-3 mb-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-lg font-black text-ink-primary">Your family week</h2>
        <span className="text-[11px] text-ink-primary/45 font-bold tabular-nums">{userTeams.length} teams</span>
      </div>

      <div className="space-y-2">
        {summaries.map((s) => (
          <TeamCard
            key={s.teamId}
            summary={s}
            onFocus={handleFocusTeam}
          />
        ))}
      </div>

      {weekEvents.length > 0 && (
        <div className="mt-4 rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 p-3">
          <p className="text-[10px] font-black tracking-widest uppercase text-ink-primary/55 mb-2 px-1">
            This week
          </p>
          <ul className="space-y-1">
            {weekEvents.slice(0, 8).map(({ ev, summary }) => (
              <li key={`${summary.teamId}:${ev.id}`}>
                <Link
                  to={`/events/${ev.id}`}
                  onClick={() => setSelectedTeamId(summary.teamId)}
                  className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-line-default/[0.04] transition-colors"
                >
                  <span className={`w-2 h-2 rounded-full ${TEAM_TINTS[summary.colorIdx].dot} flex-shrink-0`} />
                  <span className="text-xs font-bold text-ink-primary truncate flex-1">
                    {ev.title || (ev.type === 'game' ? 'Game' : ev.type === 'practice' ? 'Practice' : 'Event')}
                  </span>
                  <span className={`text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded ${TEAM_TINTS[summary.colorIdx].chip} flex-shrink-0`}>
                    {summary.teamName.length > 14 ? summary.teamName.slice(0, 14) + '…' : summary.teamName}
                  </span>
                  <span className="text-[11px] text-ink-primary/55 tabular-nums flex-shrink-0">
                    {fmtEventTime(new Date(ev.date))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {weekEvents.length > 8 && (
            <Link
              to="/calendar"
              className="mt-2 block text-center text-[11px] font-bold text-brand-primary-soft hover:text-brand-primary py-1"
            >
              + {weekEvents.length - 8} more this week
            </Link>
          )}
        </div>
      )}

      {loading && summaries.length === 0 && (
        <p className="text-xs text-ink-primary/45 text-center py-4">Loading…</p>
      )}
    </section>
  );
};

const TeamCard: React.FC<{
  summary: TeamEventsSummary;
  onFocus: (teamId: string) => void;
}> = ({ summary, onFocus }) => {
  const tint = TEAM_TINTS[summary.colorIdx];
  const nextEventDate = summary.nextEvent ? new Date(summary.nextEvent.date) : null;
  return (
    <Link
      to="/dashboard"
      onClick={() => onFocus(summary.teamId)}
      className={`block rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 hover:${tint.ring} transition p-3.5`}
    >
      <div className="flex items-start gap-3">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest ${tint.chip} flex-shrink-0 mt-0.5`}>
          {summary.teamName}
        </span>
        {summary.ageGroup && (
          <span className="text-[11px] text-ink-primary/45 font-bold flex-shrink-0 mt-0.5">
            {summary.ageGroup}
          </span>
        )}
      </div>
      {summary.nextEvent && nextEventDate ? (
        <div className="mt-2">
          <p className="text-sm font-black text-ink-primary leading-tight">
            {summary.nextEvent.title || (summary.nextEvent.type === 'game' ? 'Game' : summary.nextEvent.type === 'practice' ? 'Practice' : 'Event')}
          </p>
          <p className="text-xs text-ink-primary/70 mt-0.5">
            {fmtEventTime(nextEventDate)}
            {(summary.nextEvent as any).location ? ` · ${(summary.nextEvent as any).location}` : ''}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-ink-primary/55">
          Nothing scheduled.
        </p>
      )}
    </Link>
  );
};

export default FamilyFeed;
