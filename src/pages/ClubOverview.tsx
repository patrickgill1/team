// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { isClubAdmin, getPlayerPositionsLabel, formatDateTime } from '../utils/helpers';
import Header from '../components/common/Header';
import TransferPlayerModal from '../components/club/TransferPlayerModal';
import BroadcastModal from '../components/club/BroadcastModal';

/**
 * Club-wide admin area. Gated by user.isClubAdmin. Day-to-day, the
 * admin still acts like a regular coach on their own teams — this page
 * is the separate "admin mode" that spans every team in the database.
 *
 * Tabs (top-level state, not URL-routed for simplicity):
 *   • Overview  — teams summary
 *   • Players   — roster pool, transfer/share player across teams
 *   • Coaches   — every coach + which teams they're on
 *   • Calendar  — chronological event feed across the club
 *   • Stats     — aggregate + leaderboards
 *
 * Header has a "Broadcast" button that opens a modal to send a
 * cross-team announcement (email + optional push).
 */
type TabKey = 'overview' | 'players' | 'coaches' | 'calendar' | 'stats' | 'payments';

const ClubOverview: React.FC = () => {
  const navigate = useNavigate();
  const { userData } = useAuth();
  const { setSelectedTeamId } = useTeam();
  const { getDocuments } = useFirestore();

  const allowed = isClubAdmin(userData);

  const [teams, setTeams] = useState<any[]>([]);
  const [players, setPlayers] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<TabKey>('overview');
  const [search, setSearch] = useState('');
  const [transferPlayer, setTransferPlayer] = useState<any | null>(null);
  const [broadcastOpen, setBroadcastOpen] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const [t, p, e, u] = await Promise.all([
        getDocuments('teams', []),
        getDocuments('players', []).catch(() => []),
        getDocuments('events', []).catch(() => []),
        getDocuments('users', []).catch(() => []),
      ]);
      setTeams(t as any[]);
      setPlayers((p as any[]).filter((pl) => pl && pl.isActive !== false));
      setEvents((e as any[]).map((ev: any) => ({
        ...ev,
        date: ev.date?.toDate ? ev.date.toDate() : new Date(ev.date),
      })));
      setUsers(u as any[]);
    } catch (err) {
      console.error('[club] load failed', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!allowed) { setLoading(false); return; }
    reload();
  }, [allowed]);

  // Indexes used across tabs.
  const teamById = useMemo(() => {
    const m = new Map<string, any>();
    for (const t of teams) m.set(t.id, t);
    return m;
  }, [teams]);

  const userByUid = useMemo(() => {
    const m = new Map<string, any>();
    for (const u of users) {
      if (u?.uid) m.set(u.uid, u);
      else if (u?.id) m.set(u.id, u);
    }
    return m;
  }, [users]);

  const playerTeamIds = (p: any): string[] =>
    Array.isArray(p.teamIds) && p.teamIds.length > 0 ? p.teamIds : (p.teamId ? [p.teamId] : []);

  // Per-team stats used in overview + stats tabs.
  const teamStats = useMemo(() => {
    const out: Record<string, { players: number; upcoming: number; goals: number; assists: number; lastActivity?: Date }> = {};
    for (const t of teams) out[t.id] = { players: 0, upcoming: 0, goals: 0, assists: 0 };
    const now = new Date();
    for (const p of players) {
      const tIds = playerTeamIds(p);
      for (const id of tIds) {
        if (!out[id]) continue;
        out[id].players += 1;
        out[id].goals += p.stats?.goals || 0;
        out[id].assists += p.stats?.assists || 0;
      }
    }
    for (const ev of events) {
      if (!out[ev.teamId]) continue;
      const d = ev.date instanceof Date ? ev.date : new Date(ev.date);
      if (d >= now) out[ev.teamId].upcoming += 1;
      const cur = out[ev.teamId].lastActivity;
      if (!cur || d > cur) out[ev.teamId].lastActivity = d;
    }
    return out;
  }, [teams, players, events]);

  // Members (with team-resolved teamIds) for broadcast recipients.
  const members = useMemo(() => {
    return users
      .map((u: any) => {
        const uid = u.uid || u.id;
        if (!uid) return null;
        const teamIds: string[] = Array.isArray(u.teamIds) && u.teamIds.length > 0
          ? u.teamIds
          : (u.teamId ? [u.teamId] : []);
        return {
          uid,
          name: u.name || u.email || 'Member',
          email: (u.email || '').trim() || undefined,
          role: u.role,
          teamIds,
        };
      })
      .filter(Boolean) as any[];
  }, [users]);

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
              Ask your club admin to flip <code className="bg-gray-100 px-1 rounded text-xs">isClubAdmin</code> on
              your user record to gain access.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <Header
        title="Club"
        subtitle={`${teams.length} team${teams.length === 1 ? '' : 's'} · ${players.length} player${players.length === 1 ? '' : 's'} · ${users.length} member${users.length === 1 ? '' : 's'}`}
      />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {/* Primary actions — three big tiles into the management surfaces */}
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => navigate('/people')}
            className="bg-white border border-slate-200 rounded-xl px-3 py-3 text-left hover:border-cyan-400 transition group"
            title="Manage everyone in the club"
          >
            <svg className="w-5 h-5 text-cyan-600 mb-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <div className="text-[11px] font-extrabold tracking-widest uppercase text-slate-700">People</div>
            <div className="text-[10px] text-slate-500 mt-0.5">Roster, parents, staff</div>
          </button>
          <button
            onClick={() => navigate('/teams')}
            className="bg-white border border-slate-200 rounded-xl px-3 py-3 text-left hover:border-cyan-400 transition group"
            title="Create a new team, edit team details, or end the season"
          >
            <svg className="w-5 h-5 text-cyan-600 mb-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
            <div className="text-[11px] font-extrabold tracking-widest uppercase text-slate-700">Teams</div>
            <div className="text-[10px] text-slate-500 mt-0.5">Edit, archive, roles</div>
          </button>
          <button
            onClick={() => setBroadcastOpen(true)}
            className="bg-gradient-to-br from-amber-500 to-amber-700 text-white border border-amber-700 rounded-xl px-3 py-3 text-left hover:from-amber-400 hover:to-amber-600 transition group"
          >
            <svg className="w-5 h-5 mb-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            <div className="text-[11px] font-extrabold tracking-widest uppercase">Broadcast</div>
            <div className="text-[10px] opacity-90 mt-0.5">Club-wide message</div>
          </button>
        </div>

        {/* Secondary actions — Registrations + future CRM surfaces */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => navigate('/club/registrations')}
            className="bg-white border border-slate-200 rounded-xl px-3 py-3 text-left hover:border-cyan-400 transition group"
            title="Everyone who's registered for the season"
          >
            <svg className="w-5 h-5 text-cyan-600 mb-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
            <div className="text-[11px] font-extrabold tracking-widest uppercase text-slate-700">Registrations</div>
            <div className="text-[10px] text-slate-500 mt-0.5">Funnel + status</div>
          </button>
          <button
            onClick={() => navigate('/club/products')}
            className="bg-white border border-slate-200 rounded-xl px-3 py-3 text-left hover:border-cyan-400 transition group"
            title="Products + pricing tiers + coupon codes"
          >
            <svg className="w-5 h-5 text-violet-600 mb-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20 7L12 3 4 7v10l8 4 8-4V7z"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="4" y1="7" x2="20" y2="7"/></svg>
            <div className="text-[11px] font-extrabold tracking-widest uppercase text-slate-700">Products</div>
            <div className="text-[10px] text-slate-500 mt-0.5">Pricing + coupons</div>
          </button>
        </div>

        {/* Tabs — overview/calendar/stats. Players + Coaches tabs are
            removed since the new /people directory does both better. */}
        <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1">
          {([
            { k: 'overview', label: 'Overview' },
            { k: 'calendar', label: 'Calendar' },
            { k: 'stats', label: 'Stats' },
            { k: 'payments', label: 'Payments' },
          ] as { k: TabKey; label: string }[]).map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`px-3 py-1.5 rounded-md text-[11px] font-extrabold tracking-widest uppercase whitespace-nowrap border ${
                tab === t.k
                  ? 'bg-cyan-50 text-cyan-700 border-cyan-200'
                  : 'bg-white text-slate-500 border-slate-200 hover:text-slate-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-8 text-center text-sm text-gray-500">
            Loading club data…
          </div>
        ) : (
          <>
            {tab === 'overview' && (
              <OverviewTab
                teams={teams}
                teamStats={teamStats}
                coachNameByUid={(uid: string) => userByUid.get(uid)?.name || ''}
                search={search}
                setSearch={setSearch}
                onTeamClick={goToTeam}
              />
            )}
            {tab === 'players' && (
              <PlayersTab
                players={players}
                teams={teams}
                teamById={teamById}
                userByUid={userByUid}
                search={search}
                setSearch={setSearch}
                onTransfer={(p) => setTransferPlayer(p)}
              />
            )}
            {tab === 'coaches' && (
              <CoachesTab
                users={users}
                teams={teams}
                teamById={teamById}
                search={search}
                setSearch={setSearch}
                currentUid={userData?.uid || ''}
                reload={reload}
              />
            )}
            {tab === 'calendar' && (
              <CalendarTab events={events} teamById={teamById} />
            )}
            {tab === 'stats' && (
              <StatsTab players={players} teams={teams} teamStats={teamStats} />
            )}
            {tab === 'payments' && (
              <PaymentsTab />
            )}
          </>
        )}
      </div>

      <TransferPlayerModal
        isOpen={!!transferPlayer}
        onClose={() => setTransferPlayer(null)}
        player={transferPlayer}
        teams={teams.map((t) => ({ id: t.id, name: t.name || 'Team', ageGroup: t.ageGroup }))}
        onTransferred={reload}
      />

      <BroadcastModal
        isOpen={broadcastOpen}
        onClose={() => setBroadcastOpen(false)}
        teams={teams.map((t) => ({ id: t.id, name: t.name || 'Team' }))}
        members={members}
      />
    </div>
  );
};

// ===========================================================================
// Tabs
// ===========================================================================

const OverviewTab: React.FC<{
  teams: any[];
  teamStats: any;
  coachNameByUid: (uid: string) => string;
  search: string;
  setSearch: (s: string) => void;
  onTeamClick: (id: string) => void;
}> = ({ teams, teamStats, coachNameByUid, search, setSearch, onTeamClick }) => {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return teams
      .filter((t) => !q || (t.name || '').toLowerCase().includes(q) || (t.ageGroup || '').toLowerCase().includes(q))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [teams, search]);

  return (
    <div className="space-y-3">
      <SearchBar value={search} onChange={setSearch} placeholder="Search teams…" />
      <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bold text-fire-950">All teams</h2>
          <span className="text-xs text-gray-500">
            {filtered.length === teams.length ? `${teams.length} total` : `${filtered.length} of ${teams.length}`}
          </span>
        </div>
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No teams match.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filtered.map((t) => {
              const s = teamStats[t.id] || { players: 0, upcoming: 0 };
              const headCoach = t.headCoachId ? coachNameByUid(t.headCoachId) : '';
              return (
                <li key={t.id}>
                  <button
                    onClick={() => onTeamClick(t.id)}
                    className="w-full text-left flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 transition"
                  >
                    <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-700 text-white flex items-center justify-center font-black text-lg shadow-sm">
                      {(t.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-fire-950 truncate">{t.name || 'Untitled team'}</span>
                        {t.ageGroup && (
                          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                            {t.ageGroup}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 truncate mt-0.5">
                        {s.players} player{s.players === 1 ? '' : 's'}
                        {headCoach ? ` · Head coach: ${headCoach}` : ''}
                        {s.upcoming > 0 ? ` · ${s.upcoming} upcoming` : ''}
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
    </div>
  );
};

const PlayersTab: React.FC<{
  players: any[];
  teams: any[];
  teamById: Map<string, any>;
  userByUid: Map<string, any>;
  search: string;
  setSearch: (s: string) => void;
  onTransfer: (p: any) => void;
}> = ({ players, teams, teamById, userByUid, search, setSearch, onTransfer }) => {
  const [teamFilter, setTeamFilter] = useState<string>('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return players
      .filter((p) => {
        if (teamFilter) {
          const tIds: string[] = Array.isArray(p.teamIds) && p.teamIds.length > 0 ? p.teamIds : (p.teamId ? [p.teamId] : []);
          if (!tIds.includes(teamFilter)) return false;
        }
        if (!q) return true;
        if ((p.name || '').toLowerCase().includes(q)) return true;
        if ((Array.isArray(p.positions) ? p.positions : (p.position ? [p.position] : [])).join(' ').toLowerCase().includes(q)) return true;
        return false;
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [players, search, teamFilter]);

  return (
    <div className="space-y-3">
      <SearchBar value={search} onChange={setSearch} placeholder="Search players by name or position…" />
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1">
        <FilterChip active={!teamFilter} onClick={() => setTeamFilter('')}>All teams</FilterChip>
        {teams.map((t) => (
          <FilterChip key={t.id} active={teamFilter === t.id} onClick={() => setTeamFilter(t.id)}>{t.name}</FilterChip>
        ))}
      </div>

      <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bold text-fire-950">Roster pool</h2>
          <span className="text-xs text-gray-500">{filtered.length} player{filtered.length === 1 ? '' : 's'}</span>
        </div>
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No players match.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filtered.map((p) => {
              const tIds: string[] = Array.isArray(p.teamIds) && p.teamIds.length > 0 ? p.teamIds : (p.teamId ? [p.teamId] : []);
              const teamLabels = tIds.map((id) => teamById.get(id)?.name || '').filter(Boolean);
              const parentIds: string[] = Array.isArray(p.parentIds) ? p.parentIds : (p.parentId ? [p.parentId] : []);
              const parentNames = parentIds.map((u) => userByUid.get(u)?.name).filter(Boolean);
              return (
                <li key={p.id} className="px-5 py-3 flex items-center gap-3">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-700 text-white flex items-center justify-center font-bold shadow-sm">
                    {p.profilePhotoUrl ? (
                      <img src={p.profilePhotoUrl} alt={p.name} className="w-full h-full object-cover rounded-full" loading="lazy" />
                    ) : (
                      (p.name || '?').charAt(0).toUpperCase()
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-fire-950 truncate">
                        {p.jerseyNumber != null ? `#${p.jerseyNumber} ` : ''}{p.name || 'Player'}
                      </span>
                      {getPlayerPositionsLabel(p) && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                          {getPlayerPositionsLabel(p)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 truncate mt-0.5">
                      {teamLabels.length === 0 ? 'No team' : teamLabels.join(' · ')}
                      {parentNames.length > 0 ? ` · ${parentNames.join(', ')}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Link
                      to={`/player/${p.id}`}
                      className="px-3 py-1.5 text-xs font-semibold rounded-full ring-1 ring-gray-300 text-gray-700 hover:bg-gray-50"
                    >
                      View
                    </Link>
                    <button
                      onClick={() => onTransfer(p)}
                      className="px-3 py-1.5 text-xs font-semibold rounded-full bg-cyan-600 hover:bg-cyan-700 text-white"
                    >
                      Move
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

const CoachesTab: React.FC<{
  users: any[];
  teams: any[];
  teamById: Map<string, any>;
  search: string;
  setSearch: (s: string) => void;
  currentUid: string;
  reload: () => void;
}> = ({ users, teams, teamById, search, setSearch, currentUid, reload }) => {
  const { updateDocument } = useFirestore();
  const [busyUid, setBusyUid] = useState<string | null>(null);

  // We surface coaches + team_managers AND anyone with isClubAdmin so a
  // parent who got promoted to club admin still shows up here for
  // management (otherwise they'd be invisible).
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter((u) => u && (u.role === 'coach' || u.role === 'team_manager' || u.isClubAdmin))
      .filter((u) => !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [users, search]);

  const toggleAdmin = async (u: any) => {
    const uid = u.uid || u.id;
    if (!uid) return;
    const next = !u.isClubAdmin;
    if (!next && uid === currentUid) {
      if (!window.confirm("You're about to remove your OWN club-admin access. You'll lose access to this page until someone else re-adds you. Continue?")) return;
    } else if (next) {
      if (!window.confirm(`Make ${u.name || u.email} a club admin? They'll see every team and every member, and can promote others.`)) return;
    } else {
      if (!window.confirm(`Remove club-admin access from ${u.name || u.email}?`)) return;
    }
    setBusyUid(uid);
    try {
      await updateDocument('users', uid, { isClubAdmin: next });
      reload();
    } catch (err) {
      console.error('[club] promote/demote failed', err);
      alert('Could not update. Please try again.');
    } finally {
      setBusyUid(null);
    }
  };

  return (
    <div className="space-y-3">
      <SearchBar value={search} onChange={setSearch} placeholder="Search by name or email…" />
      <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bold text-fire-950">Coaches &amp; club admins</h2>
          <span className="text-xs text-gray-500">{visible.length} member{visible.length === 1 ? '' : 's'}</span>
        </div>
        {visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No coaches or admins yet.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {visible.map((u: any) => {
              const uid = u.uid || u.id;
              const tIds: string[] = Array.isArray(u.teamIds) && u.teamIds.length > 0 ? u.teamIds : (u.teamId ? [u.teamId] : []);
              const teamLabels = tIds.map((id) => teamById.get(id)?.name || '').filter(Boolean);
              const isHead = teams.some((t) => t.headCoachId === uid);
              const isClub = !!u.isClubAdmin;
              const isSelf = uid === currentUid;
              return (
                <li key={uid} className="px-5 py-3 flex items-center gap-3">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-800 text-white flex items-center justify-center font-bold shadow-sm">
                    {(u.name || u.email || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-fire-950 truncate">{u.name || u.email}</span>
                      {isClub && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-violet-700 bg-violet-50 ring-1 ring-violet-200 px-1.5 py-0.5 rounded">
                          Club admin
                        </span>
                      )}
                      {isHead && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 ring-1 ring-amber-200 px-1.5 py-0.5 rounded">
                          Head coach
                        </span>
                      )}
                      {u.role === 'team_manager' && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 ring-1 ring-emerald-200 px-1.5 py-0.5 rounded">
                          Team manager
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 truncate mt-0.5">
                      {u.email}{teamLabels.length > 0 ? ` · ${teamLabels.join(' · ')}` : ' · Not on any team'}
                    </p>
                  </div>
                  <button
                    onClick={() => toggleAdmin(u)}
                    disabled={busyUid === uid}
                    className={`flex-shrink-0 px-3 py-1.5 text-xs font-semibold rounded-full transition ${
                      isClub
                        ? 'bg-white text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50'
                        : 'bg-violet-600 hover:bg-violet-700 text-white'
                    } ${busyUid === uid ? 'opacity-50 cursor-wait' : ''}`}
                    title={isClub ? 'Remove club-admin access' : 'Promote to club admin'}
                  >
                    {busyUid === uid
                      ? '…'
                      : isClub
                        ? (isSelf ? 'Remove (self)' : 'Remove admin')
                        : 'Make admin'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-xs text-gray-500 px-1">
        Club admins can see every team, manage rosters across the club, and promote or remove other admins.
      </p>
    </div>
  );
};

const CalendarTab: React.FC<{
  events: any[];
  teamById: Map<string, any>;
}> = ({ events, teamById }) => {
  const [teamFilter, setTeamFilter] = useState<string>('');
  const teamOptions = useMemo(() => Array.from(teamById.values()), [teamById]);
  const upcoming = useMemo(() => {
    const now = new Date();
    return events
      .filter((e) => (teamFilter ? e.teamId === teamFilter : true))
      .filter((e) => (e.date instanceof Date ? e.date : new Date(e.date)) >= now)
      .sort((a, b) => (new Date(a.date)).getTime() - (new Date(b.date)).getTime())
      .slice(0, 50);
  }, [events, teamFilter]);

  const teamColor = (id: string): string => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    const palette = ['bg-rose-500', 'bg-amber-500', 'bg-emerald-500', 'bg-cyan-500', 'bg-violet-500', 'bg-blue-500', 'bg-teal-500', 'bg-fuchsia-500'];
    return palette[h % palette.length];
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1">
        <FilterChip active={!teamFilter} onClick={() => setTeamFilter('')}>All teams</FilterChip>
        {teamOptions.map((t: any) => (
          <FilterChip key={t.id} active={teamFilter === t.id} onClick={() => setTeamFilter(t.id)}>{t.name}</FilterChip>
        ))}
      </div>

      <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bold text-fire-950">Upcoming across the club</h2>
          <span className="text-xs text-gray-500">{upcoming.length} event{upcoming.length === 1 ? '' : 's'}</span>
        </div>
        {upcoming.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">No upcoming events.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {upcoming.map((ev: any) => {
              const t = teamById.get(ev.teamId);
              return (
                <li key={ev.id} className="px-5 py-3 flex items-center gap-3">
                  <div className={`flex-shrink-0 w-10 h-10 rounded-xl ${teamColor(ev.teamId || '')} text-white flex items-center justify-center font-bold shadow-sm`}>
                    {ev.type === 'game' ? '⚽' : ev.type === 'practice' ? '🏃' : '📅'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-fire-950 truncate">{ev.title || 'Event'}</span>
                      {t && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                          {t.name}
                        </span>
                      )}
                      <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                        {ev.type}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 truncate mt-0.5">
                      {formatDateTime(ev.date)}{ev.location ? ` · ${ev.location}` : ''}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

const StatsTab: React.FC<{
  players: any[];
  teams: any[];
  teamStats: any;
}> = ({ players, teams, teamStats }) => {
  const totals = useMemo(() => {
    let goals = 0, assists = 0, games = 0, saves = 0;
    for (const p of players) {
      goals += p.stats?.goals || 0;
      assists += p.stats?.assists || 0;
      games = Math.max(games, p.stats?.gamesPlayed || 0);
      saves += p.stats?.saves || 0;
    }
    return { goals, assists, games, saves };
  }, [players]);

  const teamLeaders = useMemo(() => {
    return [...teams].sort((a, b) => (teamStats[b.id]?.goals || 0) - (teamStats[a.id]?.goals || 0));
  }, [teams, teamStats]);

  const topScorers = useMemo(() =>
    [...players]
      .filter((p) => (p.stats?.goals || 0) > 0)
      .sort((a, b) => (b.stats?.goals || 0) - (a.stats?.goals || 0))
      .slice(0, 10), [players]);

  const topAssisters = useMemo(() =>
    [...players]
      .filter((p) => (p.stats?.assists || 0) > 0)
      .sort((a, b) => (b.stats?.assists || 0) - (a.stats?.assists || 0))
      .slice(0, 10), [players]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <BigStat icon="goal" label="Total goals" value={totals.goals} accent="emerald" />
        <BigStat icon="target" label="Total assists" value={totals.assists} accent="cyan" />
        <BigStat icon="shield" label="Total saves" value={totals.saves} accent="amber" />
        <BigStat icon="users" label="Total players" value={players.length} accent="violet" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <LeaderboardCard title="Top scorers (club-wide)" rows={topScorers.map((p) => ({
          name: p.name, sub: teamLabel(p, teams), value: p.stats?.goals || 0, photoUrl: p.profilePhotoUrl, id: p.id,
        }))} />
        <LeaderboardCard title="Top assist providers" rows={topAssisters.map((p) => ({
          name: p.name, sub: teamLabel(p, teams), value: p.stats?.assists || 0, photoUrl: p.profilePhotoUrl, id: p.id,
        }))} />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100">
          <h2 className="text-xs font-extrabold tracking-widest uppercase text-slate-600">Team leaderboard</h2>
          <p className="text-[11px] text-slate-400 mt-0.5">Ranked by goals scored</p>
        </div>
        <ul className="divide-y divide-gray-100">
          {teamLeaders.map((t, i) => {
            const s = teamStats[t.id] || { players: 0, goals: 0, assists: 0 };
            return (
              <li key={t.id} className="px-5 py-3 flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-gray-100 text-gray-700 font-bold flex items-center justify-center text-sm">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-gray-900 truncate">{t.name}</p>
                  <p className="text-xs text-gray-500">{s.players} player{s.players === 1 ? '' : 's'} · {s.assists} assists</p>
                </div>
                <div className="text-right">
                  <p className="font-black text-emerald-700 leading-tight">{s.goals}</p>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">goals</p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};

// ===========================================================================
// Small shared bits
// ===========================================================================

const SearchBar: React.FC<{ value: string; onChange: (v: string) => void; placeholder?: string }> = ({ value, onChange, placeholder }) => (
  <input
    type="text"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    className="w-full bg-white border border-gray-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-cyan-300 text-[15px]"
    style={{ fontSize: '16px' }}
  />
);

const FilterChip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`text-xs font-semibold px-3 py-1.5 rounded-full whitespace-nowrap ring-1 transition ${
      active ? 'bg-cyan-600 text-white ring-cyan-600' : 'bg-white text-gray-700 ring-gray-300 hover:bg-gray-50'
    }`}
  >
    {children}
  </button>
);

// Monoline icon set used by BigStat tiles (consistent with the rest
// of the new chrome — no emoji).
const STAT_ICONS: Record<string, JSX.Element> = {
  goal: (
    <svg fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" className="w-4 h-4"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13"/></svg>
  ),
  target: (
    <svg fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" className="w-4 h-4"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
  ),
  shield: (
    <svg fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" className="w-4 h-4"><path d="M12 2L4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z"/></svg>
  ),
  users: (
    <svg fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" className="w-4 h-4"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  ),
};

const BigStat: React.FC<{ icon: string; label: string; value: number; accent: 'emerald' | 'cyan' | 'amber' | 'violet' }> = ({ icon, label, value, accent }) => {
  const accents: Record<string, string> = {
    emerald: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    cyan: 'text-cyan-700 bg-cyan-50 border-cyan-200',
    amber: 'text-amber-700 bg-amber-50 border-amber-200',
    violet: 'text-violet-700 bg-violet-50 border-violet-200',
  };
  return (
    <div className={`rounded-xl px-3 py-2.5 border ${accents[accent]}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-extrabold tracking-widest uppercase opacity-80">
        {STAT_ICONS[icon]}
        {label}
      </div>
      <div className="text-2xl sm:text-3xl font-black leading-tight mt-1">{value}</div>
    </div>
  );
};

const LeaderboardCard: React.FC<{ title: string; rows: { id: string; name: string; sub: string; value: number; photoUrl?: string }[] }> = ({ title, rows }) => (
  <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
    <div className="px-4 py-3 border-b border-slate-100">
      <h3 className="text-xs font-extrabold tracking-widest uppercase text-slate-600">{title}</h3>
    </div>
    {rows.length === 0 ? (
      <div className="p-6 text-center text-sm text-gray-500">No data yet.</div>
    ) : (
      <ul className="divide-y divide-gray-100">
        {rows.map((r, i) => (
          <li key={r.id}>
            <Link to={`/player/${r.id}`} className="px-5 py-2.5 flex items-center gap-3 hover:bg-gray-50">
              <div className={`w-7 h-7 rounded-full text-sm font-black flex items-center justify-center ${
                i === 0 ? 'bg-amber-100 text-amber-800' : i === 1 ? 'bg-gray-200 text-gray-700' : i === 2 ? 'bg-orange-100 text-orange-800' : 'bg-gray-100 text-gray-600'
              }`}>
                {i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-gray-900 truncate">{r.name}</p>
                <p className="text-xs text-gray-500 truncate">{r.sub}</p>
              </div>
              <div className="font-black text-fire-950">{r.value}</div>
            </Link>
          </li>
        ))}
      </ul>
    )}
  </div>
);

function teamLabel(player: any, teams: any[]): string {
  const tIds: string[] = Array.isArray(player.teamIds) && player.teamIds.length > 0 ? player.teamIds : (player.teamId ? [player.teamId] : []);
  return tIds.map((id) => teams.find((t) => t.id === id)?.name || '').filter(Boolean).join(' · ');
}

// Payments tab — surfaces Stripe Connect status + recent invoices for
// this club. Multi-club model: each club holds their own connected
// Stripe account, funds go directly to them, Fire FC the platform
// never touches the money. Scaffolded UI here; the actual /stripe/*
// worker endpoints (OAuth start/finish, checkout, webhook) are stubbed
// in worker/src/stripe.ts and need to be wired before the connect
// button does anything live.
const PaymentsTab: React.FC = () => {
  const { userData } = useAuth();
  // Stripe state lives on the user's currently-selected club doc. For
  // now we look up the club via the user's clubId. A multi-club admin
  // could grow this to a picker, but a club admin only belongs to one
  // club in the current model.
  const clubId = (userData as any)?.clubId as string | undefined;
  const [club, setClub] = React.useState<any | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    if (!clubId) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const { doc, getDoc } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDoc(doc(db, 'clubs', clubId));
        if (cancelled) return;
        setClub(snap.exists() ? { id: snap.id, ...(snap.data() as any) } : null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clubId]);

  const connected = !!club?.stripeAccountId;
  const chargesEnabled = !!club?.stripeChargesEnabled;

  if (loading) {
    return <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-6 text-sm text-gray-500">Loading…</div>;
  }

  return (
    <div className="space-y-3">
      {/* Stripe Connect status card */}
      <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-bold text-fire-950">Stripe Connect</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">Direct payouts to the club's own bank account. 2.9% + 30¢ Stripe fee.</p>
          </div>
          <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded ${
            chargesEnabled ? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300'
              : connected ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300'
              : 'bg-slate-100 text-slate-600 ring-1 ring-slate-300'
          }`}>
            {chargesEnabled ? 'Active' : connected ? 'Onboarding' : 'Not connected'}
          </span>
        </div>
        <div className="p-5">
          {!connected ? (
            <>
              <p className="text-sm text-slate-700 mb-3">
                Connect a Stripe account to accept team-fee, tournament-entry, and uniform-order payments
                directly from parents. Stripe holds the funds and deposits them to your bank — Fire FC never
                touches the money.
              </p>
              <button
                type="button"
                onClick={() => alert('Stripe Connect onboarding is wired on the UI side but the worker endpoint needs setup. See worker/README.md for the next step.')}
                className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-bold"
              >
                Connect Stripe (Setup required)
              </button>
            </>
          ) : (
            <div className="space-y-2 text-sm text-slate-700">
              <div className="flex items-center justify-between">
                <span>Account ID</span>
                <code className="text-[11px] text-slate-500">{club.stripeAccountId}</code>
              </div>
              <div className="flex items-center justify-between">
                <span>Charges enabled</span>
                <span className={chargesEnabled ? 'text-emerald-700 font-bold' : 'text-amber-700 font-bold'}>
                  {chargesEnabled ? 'Yes' : 'Pending KYC'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Payouts enabled</span>
                <span className={club.stripePayoutsEnabled ? 'text-emerald-700 font-bold' : 'text-amber-700 font-bold'}>
                  {club.stripePayoutsEnabled ? 'Yes' : 'Pending'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Invoices list — empty for now; lights up when the worker
          can actually create Checkout Sessions. */}
      <div className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bold text-fire-950">Invoices</h2>
          <button
            type="button"
            disabled={!chargesEnabled}
            onClick={() => alert('Coming once Stripe Connect is active.')}
            className="text-[10px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            + Create
          </button>
        </div>
        <div className="p-8 text-center text-sm text-slate-500">
          {connected
            ? 'No invoices yet — create one to see it here.'
            : 'Connect Stripe above to start creating invoices.'}
        </div>
      </div>
    </div>
  );
};

export default ClubOverview;
