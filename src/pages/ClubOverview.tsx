// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { isClubAdmin } from '../utils/helpers';
import Header from '../components/common/Header';

/**
 * Club-wide overview. Visible only to users with `isClubAdmin: true`.
 *
 * The point is to give a club director (or a head coach who also runs the
 * club) a separate "admin mode" — without contaminating the per-team
 * coach experience. Day-to-day, Patrick acts like any other coach on
 * Fire FC PG; when he wants the club view, he comes here.
 *
 * v1 scope: table of every team with quick stats + a tap-to-focus action
 * that sets the team as the active selection and routes you to its
 * normal dashboard. Cross-team operations (transfer player, broadcast)
 * are out of scope for v1.
 */
interface ClubTeamRow {
  id: string;
  name: string;
  ageGroup?: string;
  season?: string;
  league?: string;
  homeField?: string;
  headCoachId?: string;
  coachIds: string[];
  playerCount: number;
  upcomingEventCount: number;
  lastActivity?: Date;
}

const ClubOverview: React.FC = () => {
  const navigate = useNavigate();
  const { userData } = useAuth();
  const { setSelectedTeamId } = useTeam();
  const { getDocuments } = useFirestore();

  const [rows, setRows] = useState<ClubTeamRow[]>([]);
  const [coachNamesByUid, setCoachNamesByUid] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const allowed = isClubAdmin(userData);

  useEffect(() => {
    if (!allowed) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [teams, players, events, users] = await Promise.all([
          getDocuments('teams', []),
          getDocuments('players', []).catch(() => []),
          getDocuments('events', []).catch(() => []),
          getDocuments('users', []).catch(() => []),
        ]);
        if (cancelled) return;

        // Index roster + upcoming events per team. A player is on a team
        // if its teamIds includes it OR the legacy teamId matches.
        const playersByTeam = new Map<string, number>();
        for (const p of players as any[]) {
          if (!p || p.isActive === false) continue;
          const tIds: string[] = Array.isArray(p.teamIds) && p.teamIds.length > 0
            ? p.teamIds
            : (p.teamId ? [p.teamId] : []);
          for (const t of tIds) playersByTeam.set(t, (playersByTeam.get(t) || 0) + 1);
        }

        const now = new Date();
        const upcomingByTeam = new Map<string, number>();
        const lastActivityByTeam = new Map<string, Date>();
        for (const e of events as any[]) {
          const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
          if (d >= now) upcomingByTeam.set(e.teamId, (upcomingByTeam.get(e.teamId) || 0) + 1);
          const last = lastActivityByTeam.get(e.teamId);
          if (!last || d > last) lastActivityByTeam.set(e.teamId, d);
        }

        // Coach name lookup so we can label rows with the head coach.
        const names: Record<string, string> = {};
        for (const u of users as any[]) {
          if (u?.uid) names[u.uid] = u.name || u.email || u.uid;
          else if (u?.id) names[u.id] = u.name || u.email || u.id;
        }
        setCoachNamesByUid(names);

        const built: ClubTeamRow[] = (teams as any[])
          .filter((t) => t && t.id)
          .map((t) => ({
            id: t.id,
            name: t.name || 'Untitled team',
            ageGroup: t.ageGroup,
            season: t.season,
            league: t.league,
            homeField: t.homeField,
            headCoachId: t.headCoachId,
            coachIds: Array.isArray(t.coachIds) ? t.coachIds : [],
            playerCount: playersByTeam.get(t.id) || 0,
            upcomingEventCount: upcomingByTeam.get(t.id) || 0,
            lastActivity: lastActivityByTeam.get(t.id),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setRows(built);
      } catch (err) {
        console.error('[club] load failed', err);
      } finally {
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [allowed, getDocuments]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      (r.ageGroup || '').toLowerCase().includes(q) ||
      (r.league || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const totals = useMemo(() => ({
    teams: rows.length,
    players: rows.reduce((s, r) => s + r.playerCount, 0),
    upcoming: rows.reduce((s, r) => s + r.upcomingEventCount, 0),
  }), [rows]);

  const goToTeam = (id: string) => {
    setSelectedTeamId(id);
    navigate('/dashboard');
  };

  if (!allowed) {
    return (
      <div>
        <Header title="Club" subtitle="Restricted area" />
        <div className="max-w-3xl mx-auto p-6">
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-6 text-center">
            <div className="text-4xl mb-2">🔒</div>
            <p className="font-bold text-gray-900">Club admin only</p>
            <p className="text-sm text-gray-500 mt-1">
              This area is for users designated as club admins. Ask your club admin to
              flip <code className="bg-gray-100 px-1 rounded text-xs">isClubAdmin</code> on
              your user record to gain access.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Header
        title="Club overview"
        subtitle={`${totals.teams} team${totals.teams === 1 ? '' : 's'} · ${totals.players} player${totals.players === 1 ? '' : 's'} · ${totals.upcoming} upcoming event${totals.upcoming === 1 ? '' : 's'}`}
      />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 space-y-4">
        {/* Search + summary tiles */}
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search teams, age groups, leagues…"
            className="flex-1 bg-white border border-gray-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-cyan-300 text-[15px]"
            style={{ fontSize: '16px' }}
          />
          <div className="grid grid-cols-3 gap-2 sm:w-auto">
            <ClubSummaryStat label="Teams" value={totals.teams} />
            <ClubSummaryStat label="Players" value={totals.players} />
            <ClubSummaryStat label="Upcoming" value={totals.upcoming} />
          </div>
        </div>

        {/* Teams list */}
        <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-bold text-fire-950">All teams</h2>
            <span className="text-xs text-gray-500">
              {filtered.length === rows.length ? `${rows.length} total` : `${filtered.length} of ${rows.length}`}
            </span>
          </div>
          {loading ? (
            <div className="p-8 text-center text-sm text-gray-500">Loading teams…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-500">
              {rows.length === 0 ? 'No teams in the club yet.' : 'No teams match that search.'}
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {filtered.map((r) => {
                const headCoachName = r.headCoachId ? coachNamesByUid[r.headCoachId] : undefined;
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => goToTeam(r.id)}
                      className="w-full text-left flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 transition"
                    >
                      <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-700 text-white flex items-center justify-center font-black text-lg shadow-sm">
                        {r.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-fire-950 truncate">{r.name}</span>
                          {r.ageGroup && (
                            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                              {r.ageGroup}
                            </span>
                          )}
                          {r.league && (
                            <span className="text-[10px] text-gray-500">{r.league}</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 truncate mt-0.5">
                          {r.playerCount} player{r.playerCount === 1 ? '' : 's'}
                          {headCoachName ? ` · Head coach: ${headCoachName}` : ''}
                          {r.upcomingEventCount > 0 ? ` · ${r.upcomingEventCount} upcoming` : ''}
                        </p>
                      </div>
                      <svg className="w-5 h-5 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Club operations — links to the existing per-team management page
            for now. Cross-team transfer / broadcast lands here later. */}
        <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <h2 className="font-bold text-fire-950">Club operations</h2>
            <p className="text-xs text-gray-500">Cross-team admin actions</p>
          </div>
          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              onClick={() => navigate('/teams')}
              className="text-left p-4 rounded-xl ring-1 ring-gray-200 hover:bg-cyan-50/60 hover:ring-cyan-300 transition"
            >
              <p className="font-bold text-fire-950">Share or move a player</p>
              <p className="text-xs text-gray-500 mt-0.5">Roster a player on multiple teams or transfer them between teams.</p>
            </button>
            <button
              onClick={() => navigate('/teams')}
              className="text-left p-4 rounded-xl ring-1 ring-gray-200 hover:bg-emerald-50/60 hover:ring-emerald-300 transition"
            >
              <p className="font-bold text-fire-950">Invite a coach</p>
              <p className="text-xs text-gray-500 mt-0.5">Add a coach to any team via email link.</p>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const ClubSummaryStat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="bg-white rounded-xl ring-1 ring-gray-200 px-3 py-2 text-center">
    <div className="text-xl font-black text-fire-950 leading-tight">{value}</div>
    <div className="text-[10px] uppercase tracking-wider font-bold text-gray-500">{label}</div>
  </div>
);

export default ClubOverview;
