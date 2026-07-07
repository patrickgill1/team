// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, getDocs, query, where, orderBy, limit, documentId } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import type { CalendarEvent } from '../types';

// FamilyHome — the "cross-team, cross-kid" replacement for the
// per-team Dashboard we've had. Behind a feature flag
// (localStorage.familyHomeEnabled = "1") so it can ship live for
// Patrick to eyeball without cutting anyone over.
//
// Structure (per the design conversation 2026-07-07):
//   1. Greeting + status pill
//   2. Kids strip — horizontal scroll of kid cards (one per player
//      linked to the user across ALL their teams). Photo + name +
//      that kid's next event + quick RSVP + a "new from coach" pip
//      when there's unread wall or media.
//   3. Coach cards — one tile per team the user coaches. Tap → into
//      that team's CoachCockpit.
//   4. This week — chronological strip of upcoming events across
//      all teams, color-dotted by team. Compact one-liner rows.
//
// Team-scoped surfaces (chat, roster, dev plans, media, wall) stay
// team-scoped; they're accessed by drilling into a kid card or coach
// card. The team switcher becomes an override, not the primary
// navigation.

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Same stable-per-index color palette used in FamilyFeed so a given
// team looks the same across both surfaces (which will overlap in
// the flag-on preview period).
const TEAM_ACCENTS: Array<{ dot: string; chip: string }> = [
  { dot: 'bg-brand-primary',  chip: 'bg-brand-primary/15 text-brand-primary-soft' },
  { dot: 'bg-emerald-400',    chip: 'bg-emerald-500/15 text-emerald-300' },
  { dot: 'bg-amber-400',      chip: 'bg-amber-500/15 text-amber-300' },
  { dot: 'bg-violet-400',     chip: 'bg-violet-500/15 text-violet-300' },
  { dot: 'bg-sky-400',        chip: 'bg-sky-500/15 text-sky-300' },
  { dot: 'bg-rose-400',       chip: 'bg-rose-500/15 text-rose-300' },
];

interface LinkedKid {
  id: string;
  name: string;
  photoURL?: string;
  jerseyNumber?: number;
  positions?: string[];
  teamId: string;
  teamName: string;
  teamColorIdx: number;
  nextEvent: CalendarEvent | null;
}

interface CoachTeamTile {
  teamId: string;
  teamName: string;
  ageGroup?: string;
  colorIdx: number;
  role: 'head' | 'assistant' | 'manager';
}

interface WeekEvent {
  event: CalendarEvent;
  teamId: string;
  teamName: string;
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

const FamilyHome: React.FC = () => {
  const navigate = useNavigate();
  const { userData, currentUser } = useAuth();
  const { teams, setSelectedTeamId } = useTeam();
  const [kids, setKids] = useState<LinkedKid[]>([]);
  const [weekEvents, setWeekEvents] = useState<WeekEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const firstName = (userData?.name || currentUser?.displayName || '').split(' ')[0] || '';
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return 'Late night';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 21) return 'Good evening';
    return 'Good evening';
  }, []);

  const userTeamIds: string[] = useMemo(() => (
    Array.isArray(userData?.teamIds) && userData.teamIds.length > 0
      ? userData.teamIds
      : (userData?.teamId ? [userData.teamId] : [])
  ), [userData?.teamIds, userData?.teamId]);

  // Coach tiles — teams where the user is a coach (any level). Uses
  // team doc's coachIds / assistantCoachIds / headCoachId. Doesn't
  // depend on user.role globally so a club_admin who also coaches
  // is captured too.
  const coachTiles: CoachTeamTile[] = useMemo(() => {
    if (!userData?.uid) return [];
    const uid = userData.uid;
    return teams
      .filter((t) => userTeamIds.includes(t.id) && (t as any).isActive !== false)
      .filter((t) =>
        (Array.isArray((t as any).coachIds) && (t as any).coachIds.includes(uid)) ||
        (t as any).headCoachId === uid ||
        (Array.isArray((t as any).assistantCoachIds) && (t as any).assistantCoachIds.includes(uid))
      )
      .map((t, i) => ({
        teamId: t.id,
        teamName: t.name,
        ageGroup: (t as any).ageGroup,
        colorIdx: i % TEAM_ACCENTS.length,
        role: (t as any).headCoachId === uid ? 'head'
              : (Array.isArray((t as any).assistantCoachIds) && (t as any).assistantCoachIds.includes(uid)) ? 'assistant'
              : 'manager',
      }));
  }, [teams, userTeamIds, userData?.uid]);

  // Load kids + week events in parallel. Fresh users with no teams
  // yet skip both — they still see the greeting and can pick a team.
  useEffect(() => {
    if (!userData?.uid || userTeamIds.length === 0) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // 1. Every active player where uid is in parentIds. Chunk if
        //    the user is on lots of teams (rare, but safe).
        const playerSnap = await getDocs(query(
          collection(db, 'players'),
          where('parentIds', 'array-contains', userData.uid),
        )).catch(() => null);
        const rawPlayers = playerSnap
          ? playerSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => p.isActive !== false)
          : [];

        // Team lookup for kid.teamName + colorIdx. Use in-memory
        // teams from TeamContext when possible; fall back to a
        // targeted fetch for teams outside userTeamIds (shouldn't
        // happen but a shared player might have team drift).
        const teamById: Record<string, { name: string; colorIdx: number }> = {};
        teams.forEach((t, i) => { teamById[t.id] = { name: t.name, colorIdx: i % TEAM_ACCENTS.length }; });

        // 2. Next event per (player, primaryTeam). We pull all
        //    upcoming events for the union of teams the user is on
        //    or their kids play for, in one paginated query, then
        //    bucket by team.
        const now = new Date();
        const endOfWeek = new Date(now);
        endOfWeek.setDate(now.getDate() + 7);
        const relevantTeamIds = new Set<string>(userTeamIds);
        rawPlayers.forEach((p: any) => {
          const primary = Array.isArray(p.teamIds) && p.teamIds.length > 0 ? p.teamIds[0] : p.teamId;
          if (primary) relevantTeamIds.add(primary);
        });
        const teamChunks: string[][] = [];
        const teamIdArr = [...relevantTeamIds];
        for (let i = 0; i < teamIdArr.length; i += 10) teamChunks.push(teamIdArr.slice(i, i + 10));
        const eventsByTeam: Record<string, CalendarEvent[]> = {};
        for (const chunk of teamChunks) {
          if (chunk.length === 0) continue;
          const snap = await getDocs(query(
            collection(db, 'events'),
            where('teamId', 'in', chunk),
            where('date', '>=', now),
            orderBy('date', 'asc'),
            limit(30),
          )).catch(() => null);
          if (!snap) continue;
          snap.docs.forEach((d) => {
            const data: any = d.data() || {};
            if (data.isCancelled) return;
            const date = data.date?.toDate ? data.date.toDate() : new Date(data.date);
            const ev = { id: d.id, ...data, date } as CalendarEvent;
            (eventsByTeam[data.teamId] ||= []).push(ev);
          });
        }

        // 3. Build LinkedKid rows.
        const kidRows: LinkedKid[] = rawPlayers.map((p: any) => {
          const primaryTeam = Array.isArray(p.teamIds) && p.teamIds.length > 0 ? p.teamIds[0] : p.teamId;
          const teamInfo = teamById[primaryTeam] || { name: 'Team', colorIdx: 0 };
          const nextEvent = (eventsByTeam[primaryTeam] || [])[0] || null;
          return {
            id: p.id,
            name: p.name || 'Player',
            photoURL: p.profilePhotoUrl || p.photoUrl,
            jerseyNumber: p.jerseyNumber,
            positions: p.positions || (p.position ? [p.position] : undefined),
            teamId: primaryTeam,
            teamName: teamInfo.name,
            teamColorIdx: teamInfo.colorIdx,
            nextEvent,
          };
        });

        // 4. Build cross-team This Week rollup.
        const week: WeekEvent[] = [];
        for (const [tid, evs] of Object.entries(eventsByTeam)) {
          const teamInfo = teamById[tid] || { name: 'Team', colorIdx: 0 };
          for (const ev of evs) {
            if (new Date(ev.date) <= endOfWeek) {
              week.push({ event: ev, teamId: tid, teamName: teamInfo.name, colorIdx: teamInfo.colorIdx });
            }
          }
        }
        week.sort((a, b) => new Date(a.event.date).getTime() - new Date(b.event.date).getTime());

        if (!cancelled) {
          setKids(kidRows);
          setWeekEvents(week);
        }
      } catch (err) {
        console.warn('[FamilyHome] load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userData?.uid, userTeamIds.join(','), teams.map((t) => t.id).join(',')]);

  const focusTeamAndGo = (teamId: string, to: string) => {
    setSelectedTeamId(teamId);
    navigate(to);
  };

  return (
    <div className="min-h-screen bg-surface-base pb-24">
      <Header title="Home" subtitle="Preview" />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 space-y-5">
        {/* Greeting */}
        <div>
          <p className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft">
            {greeting}
          </p>
          <h1 className="text-2xl font-black text-ink-primary mt-0.5">
            {firstName ? `${firstName}` : 'Welcome'}
          </h1>
          <p className="text-[11px] text-ink-primary/45 mt-1">
            New Home preview. Send me feedback and I'll iterate; the classic Dashboard is still live at Home.
          </p>
        </div>

        {/* Kids strip */}
        {kids.length > 0 && (
          <section>
            <h2 className="text-sm font-black uppercase tracking-widest text-ink-primary/55 mb-2">
              {kids.length === 1 ? 'Your kid' : 'Your kids'}
            </h2>
            <KidsStrip kids={kids} onFocus={(teamId) => focusTeamAndGo(teamId, `/player/${kids.find((k) => k.teamId === teamId)?.id}`)} />
          </section>
        )}

        {/* Coach cards */}
        {coachTiles.length > 0 && (
          <section>
            <h2 className="text-sm font-black uppercase tracking-widest text-ink-primary/55 mb-2">
              Teams you coach
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {coachTiles.map((t) => (
                <button
                  key={t.teamId}
                  type="button"
                  onClick={() => focusTeamAndGo(t.teamId, '/coach')}
                  className="text-left rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 hover:ring-brand-primary/30 transition p-4"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-2 h-2 rounded-full ${TEAM_ACCENTS[t.colorIdx].dot}`} />
                    <span className={`text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded ${TEAM_ACCENTS[t.colorIdx].chip}`}>
                      {t.role === 'head' ? 'Head coach' : t.role === 'assistant' ? 'Assistant' : 'Manager'}
                    </span>
                  </div>
                  <p className="text-sm font-black text-ink-primary leading-tight">{t.teamName}</p>
                  {t.ageGroup && (
                    <p className="text-[11px] text-ink-primary/45 mt-0.5">{t.ageGroup}</p>
                  )}
                  <p className="text-[11px] text-ink-primary/55 mt-2">Open cockpit →</p>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* This week */}
        {weekEvents.length > 0 && (
          <section>
            <h2 className="text-sm font-black uppercase tracking-widest text-ink-primary/55 mb-2">
              This week
            </h2>
            <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 p-3">
              <ul className="space-y-1">
                {weekEvents.slice(0, 10).map((we, i) => (
                  <li key={`${we.teamId}:${we.event.id}:${i}`}>
                    <button
                      type="button"
                      onClick={() => focusTeamAndGo(we.teamId, `/events/${we.event.id}`)}
                      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-line-default/[0.04] transition-colors text-left"
                    >
                      <span className={`w-2 h-2 rounded-full ${TEAM_ACCENTS[we.colorIdx].dot} flex-shrink-0`} />
                      <span className="text-xs font-bold text-ink-primary truncate flex-1">
                        {we.event.title || (we.event.type === 'game' ? 'Game' : we.event.type === 'practice' ? 'Practice' : 'Event')}
                      </span>
                      <span className={`text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded ${TEAM_ACCENTS[we.colorIdx].chip} flex-shrink-0`}>
                        {we.teamName.length > 12 ? we.teamName.slice(0, 12) + '…' : we.teamName}
                      </span>
                      <span className="text-[11px] text-ink-primary/55 tabular-nums flex-shrink-0">
                        {fmtEventTime(new Date(we.event.date))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {weekEvents.length > 10 && (
                <Link to="/calendar" className="mt-2 block text-center text-[11px] font-bold text-brand-primary-soft hover:text-brand-primary py-1">
                  + {weekEvents.length - 10} more →
                </Link>
              )}
            </div>
          </section>
        )}

        {loading && kids.length === 0 && coachTiles.length === 0 && (
          <p className="text-xs text-ink-primary/45 text-center py-6">Loading…</p>
        )}

        {!loading && kids.length === 0 && coachTiles.length === 0 && weekEvents.length === 0 && (
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 p-6 text-center">
            <p className="text-sm font-bold text-ink-primary">Nothing to show yet.</p>
            <p className="text-xs text-ink-primary/55 mt-1">
              Once you're on a team, or a kid links to one, this page will fill in.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

const KidsStrip: React.FC<{ kids: LinkedKid[]; onFocus: (teamId: string) => void }> = ({ kids, onFocus }) => {
  if (kids.length === 1) {
    return <KidCard kid={kids[0]} onFocus={onFocus} full />;
  }
  return (
    <div
      className="flex overflow-x-auto snap-x snap-mandatory -mx-4 sm:-mx-6 px-4 sm:px-6 gap-3"
      style={{ scrollbarWidth: 'none' }}
    >
      {kids.map((k) => (
        <div key={k.id} className="snap-center flex-shrink-0 w-[85%] sm:w-[45%]">
          <KidCard kid={k} onFocus={onFocus} />
        </div>
      ))}
    </div>
  );
};

const KidCard: React.FC<{ kid: LinkedKid; onFocus: (teamId: string) => void; full?: boolean }> = ({ kid, onFocus, full }) => {
  const tint = TEAM_ACCENTS[kid.teamColorIdx];
  const nextDate = kid.nextEvent ? new Date(kid.nextEvent.date) : null;
  return (
    <button
      type="button"
      onClick={() => onFocus(kid.teamId)}
      className={`w-full text-left rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 hover:ring-brand-primary/30 transition p-4 ${full ? '' : 'min-h-[164px]'}`}
    >
      <div className="flex items-center gap-3">
        {kid.photoURL ? (
          <img src={kid.photoURL} alt="" className="w-14 h-14 rounded-full object-cover ring-2 ring-line-default/10 flex-shrink-0" />
        ) : (
          <div className="w-14 h-14 rounded-full bg-line-default/10 flex items-center justify-center text-lg font-black text-ink-primary flex-shrink-0">
            {(kid.name || '?').charAt(0)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-base font-black text-ink-primary truncate">{kid.name}</p>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className={`text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded ${tint.chip} flex-shrink-0`}>
              {kid.teamName.length > 14 ? kid.teamName.slice(0, 14) + '…' : kid.teamName}
            </span>
            {kid.jerseyNumber !== undefined && kid.jerseyNumber !== null && (
              <span className="text-[10px] font-bold text-ink-primary/55">#{kid.jerseyNumber}</span>
            )}
            {kid.positions && kid.positions[0] && (
              <span className="text-[10px] font-bold text-ink-primary/55">{kid.positions[0]}</span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 rounded-xl bg-surface-base/60 ring-1 ring-line-default/10 p-2.5">
        <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/45">Next up</p>
        {kid.nextEvent && nextDate ? (
          <>
            <p className="text-xs font-bold text-ink-primary mt-0.5 truncate">
              {kid.nextEvent.title || (kid.nextEvent.type === 'game' ? 'Game' : 'Practice')}
            </p>
            <p className="text-[11px] text-ink-primary/55">
              {fmtEventTime(nextDate)}
              {(kid.nextEvent as any).location ? ` · ${(kid.nextEvent as any).location}` : ''}
            </p>
          </>
        ) : (
          <p className="text-[11px] text-ink-primary/55 mt-0.5">Nothing scheduled</p>
        )}
      </div>
    </button>
  );
};

export default FamilyHome;
