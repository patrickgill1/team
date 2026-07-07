import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, query, where, orderBy, limit, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import type { CalendarEvent } from '../../types';

// FamilyFeed — cross-team home surface for users on 2+ teams. Sits
// BELOW MyPlayerCard on the Dashboard so the kid stays the emotional
// core; this is a helper for families whose kid plays for one team
// AND who help run / spectate another.
//
// Deliberately excludes the currently-selected team — that team's
// next event already sits at the top of Home in NextEventPoster.
// Showing it again here just makes the dashboard read as a list of
// duplicates.
//
// Per-team hide: users can tap the small × on any team card to
// suppress it from this surface. Stored on user.dashboardHiddenTeamIds
// so it persists across devices. Hidden teams stay accessible via
// the top-nav switcher and everywhere else.

interface Props {
  /** Suppress the whole component (e.g. host wants a different
   *  layout). Callers usually leave undefined. */
  hidden?: boolean;
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Stable-per-team color palette. Index cycles for 3+ teams. Used as
// a left-edge accent so cards read as "team-branded" without
// dominating the surface with tinted panels.
const TEAM_ACCENTS: Array<{ border: string; chip: string }> = [
  { border: 'border-l-brand-primary',     chip: 'bg-brand-primary/15 text-brand-primary-soft' },
  { border: 'border-l-emerald-400',       chip: 'bg-emerald-500/15 text-emerald-300' },
  { border: 'border-l-amber-400',         chip: 'bg-amber-500/15 text-amber-300' },
  { border: 'border-l-violet-400',        chip: 'bg-violet-500/15 text-violet-300' },
  { border: 'border-l-sky-400',           chip: 'bg-sky-500/15 text-sky-300' },
  { border: 'border-l-rose-400',          chip: 'bg-rose-500/15 text-rose-300' },
];

interface TeamRow {
  teamId: string;
  teamName: string;
  ageGroup?: string;
  nextEvent: CalendarEvent | null;
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
  const { userData, currentUser } = useAuth();
  const { teams, selectedTeamId, setSelectedTeamId } = useTeam();
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);

  const hiddenIds: string[] = useMemo(
    () => Array.isArray((userData as any)?.dashboardHiddenTeamIds) ? (userData as any).dashboardHiddenTeamIds : [],
    [(userData as any)?.dashboardHiddenTeamIds],
  );

  // Membership: teams user belongs to, active, excluding the one
  // shown by NextEventPoster (the selected team) — that's where the
  // duplication was coming from.
  const membershipTeams = useMemo(() => {
    const teamIds: string[] = Array.isArray(userData?.teamIds) && userData.teamIds.length > 0
      ? userData.teamIds
      : (userData?.teamId ? [userData.teamId] : []);
    return teams.filter((t) => teamIds.includes(t.id) && (t as any).isActive !== false && t.id !== selectedTeamId);
  }, [teams, userData?.teamIds, userData?.teamId, selectedTeamId]);

  const visibleTeams = useMemo(
    () => membershipTeams.filter((t) => !hiddenIds.includes(t.id)),
    [membershipTeams, hiddenIds],
  );
  const hiddenTeams = useMemo(
    () => membershipTeams.filter((t) => hiddenIds.includes(t.id)),
    [membershipTeams, hiddenIds],
  );

  const shouldRender = !hidden && (visibleTeams.length > 0 || hiddenTeams.length > 0);

  // Fetch just the next event for each visible team. Deliberately
  // no "this week rollup" pass — it read as a wall of lists and
  // duplicated content from the individual team rows.
  useEffect(() => {
    if (!shouldRender) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const now = new Date();
      try {
        const results = await Promise.all(
          visibleTeams.map(async (team, i) => {
            const eventsSnap = await getDocs(query(
              collection(db, 'events'),
              where('teamId', '==', team.id),
              where('date', '>=', now),
              orderBy('date', 'asc'),
              limit(3),
            )).catch(() => null);
            const evs: CalendarEvent[] = eventsSnap
              ? eventsSnap.docs.map((d) => {
                  const data: any = d.data() || {};
                  const date = data.date?.toDate ? data.date.toDate() : new Date(data.date);
                  return { id: d.id, ...data, date } as CalendarEvent;
                }).filter((e: any) => !e.isCancelled)
              : [];
            return {
              teamId: team.id,
              teamName: team.name,
              ageGroup: (team as any).ageGroup,
              nextEvent: evs[0] || null,
              colorIdx: i % TEAM_ACCENTS.length,
            } as TeamRow;
          }),
        );
        if (!cancelled) setRows(results);
      } catch (err) {
        console.warn('[FamilyFeed] load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shouldRender, visibleTeams.map((t) => t.id).join(',')]);

  const setHidden = async (teamId: string, hide: boolean) => {
    if (!currentUser?.uid) return;
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), {
        dashboardHiddenTeamIds: hide ? arrayUnion(teamId) : arrayRemove(teamId),
      });
    } catch (err) {
      console.warn('[FamilyFeed] hide/show failed', err);
    }
  };

  if (!shouldRender) return null;

  const totalCount = membershipTeams.length;
  const hiddenCount = hiddenTeams.length;

  return (
    <section className="mt-3 mb-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-black uppercase tracking-widest text-ink-primary/55">
          Your other teams
        </h2>
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            className="text-[11px] font-bold text-brand-primary-soft hover:text-brand-primary"
          >
            {showHidden ? 'Hide' : 'Show'} {hiddenCount} hidden
          </button>
        )}
      </div>

      <div className="space-y-2">
        {rows.map((r) => (
          <TeamCard
            key={r.teamId}
            row={r}
            onFocus={(id) => setSelectedTeamId(id)}
            onHide={() => setHidden(r.teamId, true)}
          />
        ))}
      </div>

      {showHidden && hiddenTeams.length > 0 && (
        <div className="mt-3 rounded-2xl bg-surface-elevated/60 ring-1 ring-line-default/10 p-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/45 mb-2">Hidden from Home</p>
          <ul className="space-y-1">
            {hiddenTeams.map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-1">
                <span className="text-xs font-bold text-ink-primary/75 truncate flex-1">{t.name}</span>
                <button
                  type="button"
                  onClick={() => setHidden(t.id, false)}
                  className="text-[10px] font-black uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary px-2 py-1 rounded"
                >
                  Show on Home
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && rows.length === 0 && visibleTeams.length > 0 && (
        <p className="text-xs text-ink-primary/45 text-center py-3">Loading…</p>
      )}

      {visibleTeams.length === 0 && hiddenCount > 0 && (
        <p className="text-xs text-ink-primary/55 leading-snug px-1">
          All {totalCount} other teams are hidden from Home. Tap the toggle above to bring them back.
        </p>
      )}
    </section>
  );
};

const TeamCard: React.FC<{
  row: TeamRow;
  onFocus: (teamId: string) => void;
  onHide: () => void;
}> = ({ row, onFocus, onHide }) => {
  const tint = TEAM_ACCENTS[row.colorIdx];
  const nextEventDate = row.nextEvent ? new Date(row.nextEvent.date) : null;
  return (
    <div className={`relative rounded-xl bg-surface-elevated ring-1 ring-line-default/10 border-l-4 ${tint.border} pl-3 pr-2 py-2.5 flex items-center gap-2`}>
      <Link
        to="/dashboard"
        onClick={() => onFocus(row.teamId)}
        className="flex-1 min-w-0 flex items-center gap-2.5"
      >
        <div className="min-w-0 flex-1">
          <p className="text-xs font-black text-ink-primary truncate leading-tight">
            {row.teamName}
            {row.ageGroup && <span className="text-ink-primary/45 font-normal"> · {row.ageGroup}</span>}
          </p>
          {row.nextEvent && nextEventDate ? (
            <p className="text-[11px] text-ink-primary/60 truncate mt-0.5">
              {row.nextEvent.title || (row.nextEvent.type === 'game' ? 'Game' : 'Practice')} · {fmtEventTime(nextEventDate)}
            </p>
          ) : (
            <p className="text-[11px] text-ink-primary/40 mt-0.5">Nothing scheduled</p>
          )}
        </div>
        <span className="text-ink-primary/30">→</span>
      </Link>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onHide(); }}
        className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-ink-primary/35 hover:text-ink-primary/70 hover:bg-line-default/[0.06] transition-colors"
        aria-label={`Hide ${row.teamName} from Home`}
        title="Hide from Home"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
};

export default FamilyFeed;
