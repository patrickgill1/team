// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { useClubId } from '../hooks/useClubId';
import { useClubScopes } from '../hooks/useClubScopes';
import { isClubAdmin, getPlayerPositionsLabel, formatDateTime } from '../utils/helpers';
import Header from '../components/common/Header';
import DataGate from '../components/common/DataGate';
import TransferPlayerModal from '../components/club/TransferPlayerModal';
import BroadcastModal from '../components/club/BroadcastModal';
import AdminCockpit from '../components/admin/AdminCockpit';

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
// 'players' + 'coaches' tab keys removed v3.2.63 — those tabs
// were retired when /people became the unified directory.
type TabKey = 'overview' | 'calendar' | 'stats' | 'payments';

const ClubOverview: React.FC = () => {
  const navigate = useNavigate();
  const { userData } = useAuth();
  const { setSelectedTeamId } = useTeam();
  const { getDocuments } = useFirestore();
  const { clubId: scopedClubId } = useClubId();
  const { has: hasClubScope } = useClubScopes(scopedClubId);

  const allowed = isClubAdmin(userData);
  // Financials tab hides for any admin without the 'financials'
  // scope. Owners always have it (implicit), legacy isClubAdmin
  // users without explicit scopes still see it (back-compat).
  const canSeeFinancials = hasClubScope('financials');

  const [teams, setTeams] = useState<any[]>([]);
  const [players, setPlayers] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<TabKey>('overview');
  const [search, setSearch] = useState('');
  const [transferPlayer, setTransferPlayer] = useState<any | null>(null);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  // Auto-open the BroadcastModal when arriving via ?broadcast=open
  // (deep-link from the AdminCockpit's Broadcast quick-action tile
  // on the dashboard). Consumes the param so a refresh doesn't
  // re-open the modal.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('broadcast') === 'open') {
      setBroadcastOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('broadcast');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const reload = async () => {
    setLoading(true);
    try {
      // Multi-tenant lock (2026-06-24): admin's Club view used to
      // pull EVERY team in the database. Patrick: "still seeing this
      // team in my team selection and it was made from another
      // account." Now scoped to the admin's clubIds[]. Also drops
      // archived teams (isActive: false) from the list.
      //
      // Fallback (2026-06-25): for admin user docs that pre-date the
      // multi-tenant work and have no clubIds field, derive the club
      // scope from the user's own teamIds — load those teams, take
      // the unique clubIds, then expand to every team in those clubs.
      // Patrick: 'it shows i have no teams in my main club page.'
      let clubIds: string[] = Array.isArray((userData as any)?.clubIds)
        ? (userData as any).clubIds
        : (userData as any)?.clubId ? [(userData as any).clubId] : [];

      if (clubIds.length === 0 && (userData as any)?.teamIds?.length) {
        try {
          const ownIds: string[] = ((userData as any).teamIds as string[]).slice(0, 30);
          const ownSnap = await getDocs(query(
            collection(db, 'teams'),
            where('__name__', 'in', ownIds),
          ));
          const derived = new Set<string>();
          ownSnap.forEach((d) => {
            const cid = (d.data() as any)?.clubId;
            if (cid && typeof cid === 'string') derived.add(cid);
          });
          clubIds = Array.from(derived);
        } catch (err) {
          console.warn('[club] clubId fallback derive failed', err);
        }
      }

      // Teams: scope to clubIds, exclude archived.
      let teamDocs: any[] = [];
      if (clubIds.length > 0) {
        const snap = await getDocs(query(
          collection(db, 'teams'),
          where('clubId', 'in', clubIds.slice(0, 30)),
        ));
        teamDocs = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((t: any) => t.isActive !== false);
      }
      const teamIdSet = new Set<string>(teamDocs.map(t => t.id));

      // Players + events: still load broadly, then filter to our team
      // set client-side. Tightening these queries is a separate audit
      // pass (every players read site needs scoping; not in scope
      // for this fix).
      const [p, e, u] = await Promise.all([
        getDocuments('players', []).catch(() => []),
        getDocuments('events', []).catch(() => []),
        getDocuments('users', []).catch(() => []),
      ]);
      setTeams(teamDocs);
      setPlayers((p as any[])
        .filter((pl) => pl && pl.isActive !== false)
        .filter((pl) => {
          const tids: string[] = Array.isArray(pl.teamIds) && pl.teamIds.length
            ? pl.teamIds
            : (pl.teamId ? [pl.teamId] : []);
          return tids.some((id) => teamIdSet.has(id));
        }));
      setEvents((e as any[])
        .filter((ev) => teamIdSet.has(ev.teamId))
        .map((ev: any) => ({
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
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6 text-center">
            <div className="text-4xl mb-2">🔒</div>
            <p className="font-bold text-bone">Club admin only</p>
            <p className="text-sm text-bone/50 mt-1">
              Ask your club admin to flip <code className="bg-white/[0.08] px-1 rounded text-xs">isClubAdmin</code> on
              your user record to gain access.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal-950">
      <Header
        title="Club"
        subtitle={`${teams.length} team${teams.length === 1 ? '' : 's'} · ${players.length} player${players.length === 1 ? '' : 's'} · ${users.length} member${users.length === 1 ? '' : 's'}`}
      />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 space-y-3">
        {/* Admin cockpit — moved here from Dashboard 2026-06-21. Patrick:
            'this option exists as part of the main dashboard, but only
            happens once a year. it needs to be in the club section
            only.' This is the canonical 'what needs attention today'
            surface for admins; lives at the top of /club so anyone who
            taps the Club tab in the bottom nav sees their pending work
            first. */}
        <AdminCockpit />

        {/* Primary actions — three big tiles into the management surfaces */}
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => navigate('/people')}
            className="bg-charcoal-900 border border-white/10 rounded-xl px-3 py-3 text-left hover:border-brand-primary-soft transition group"
            title="Search every player, parent, and coach — tap a player to open their full admin profile"
          >
            <svg className="w-5 h-5 text-brand-primary mb-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <div className="text-[11px] font-extrabold tracking-widest uppercase text-bone/85">People</div>
            <div className="text-[10px] text-bone/50 mt-0.5">Tap a player → full profile</div>
          </button>
          <button
            onClick={() => navigate('/teams')}
            className="bg-charcoal-900 border border-white/10 rounded-xl px-3 py-3 text-left hover:border-brand-primary-soft transition group"
            title="Create a new team, edit team details, or end the season"
          >
            <svg className="w-5 h-5 text-brand-primary mb-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
            <div className="text-[11px] font-extrabold tracking-widest uppercase text-bone/85">Teams</div>
            <div className="text-[10px] text-bone/50 mt-0.5">Edit, archive, roles</div>
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
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => navigate('/club/registrations')}
            className="bg-charcoal-900 border border-white/10 rounded-xl px-3 py-3 text-left hover:border-brand-primary-soft transition group"
            title="Everyone who's registered for the season"
          >
            <svg className="w-5 h-5 text-brand-primary mb-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
            <div className="text-[11px] font-extrabold tracking-widest uppercase text-bone/85">Registrations</div>
            <div className="text-[10px] text-bone/50 mt-0.5">Funnel + status</div>
          </button>
          <button
            onClick={() => navigate('/club/products')}
            className="bg-charcoal-900 border border-white/10 rounded-xl px-3 py-3 text-left hover:border-brand-primary-soft transition group"
            title="Products + pricing tiers + coupon codes"
          >
            <svg className="w-5 h-5 text-violet-600 mb-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20 7L12 3 4 7v10l8 4 8-4V7z"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="4" y1="7" x2="20" y2="7"/></svg>
            <div className="text-[11px] font-extrabold tracking-widest uppercase text-bone/85">Products</div>
            <div className="text-[10px] text-bone/50 mt-0.5">Pricing + coupons</div>
          </button>
          <button
            onClick={() => navigate('/club/registration-form')}
            className="bg-charcoal-900 border border-white/10 rounded-xl px-3 py-3 text-left hover:border-brand-primary-soft transition group"
            title="Extra questions on the public registration form"
          >
            <svg className="w-5 h-5 text-amber-600 mb-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <div className="text-[11px] font-extrabold tracking-widest uppercase text-bone/85">Form</div>
            <div className="text-[10px] text-bone/50 mt-0.5">Custom questions</div>
          </button>
        </div>

        {/* Coach-admin tools — compressed from 6 full-width rows to a
            single horizontal-scroll strip of small chips. v3.2.64
            cleanup per Option 1: ClubOverview is an admin cockpit
            (read-only summaries + broadcast + payments), not a
            launcher menu. The 6 tools are still one tap away, just
            no longer claiming ~250px of vertical real estate. */}
        <div className="-mx-4 sm:-mx-6 px-4 sm:px-6 overflow-x-auto pb-1">
          <div className="flex items-center gap-2 min-w-max">
            {[
              { to: '/club/branding',         label: 'Branding',          accent: 'hover:border-amber-400' },
              { to: '/club/tryouts',          label: 'Tryouts',           accent: 'hover:border-rose-400' },
              { to: '/club/seasons',          label: 'Seasons',           accent: 'hover:border-amber-400' },
              { to: '/club/offer-templates',  label: 'Offer templates',   accent: 'hover:border-violet-400' },
              { to: '/club/reports',          label: 'Reports',           accent: 'hover:border-emerald-400' },
              { to: '/club/forms',            label: 'Forms',             accent: 'hover:border-brand-primary-soft' },
              { to: '/club/tasks',            label: 'Tasks',             accent: 'hover:border-rose-400' },
            ].map(t => (
              <button
                key={t.to}
                onClick={() => navigate(t.to)}
                className={`shrink-0 inline-flex items-center px-3 py-1.5 rounded-full text-[11px] font-extrabold uppercase tracking-widest text-bone/75 bg-charcoal-900 border border-white/10 transition ${t.accent} hover:text-bone`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tabs — overview/calendar/stats. Players + Coaches tabs are
            removed since the new /people directory does both better. */}
        <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1">
          {([
            { k: 'overview' as TabKey, label: 'Overview' },
            { k: 'calendar' as TabKey, label: 'Calendar' },
            { k: 'stats' as TabKey,    label: 'Stats' },
            ...(canSeeFinancials ? [{ k: 'payments' as TabKey, label: 'Payments' }] : []),
          ]).map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`px-3 py-1.5 rounded-md text-[11px] font-extrabold tracking-widest uppercase whitespace-nowrap border ${
                tab === t.k
                  ? 'bg-brand-primary/15 text-brand-primary-soft border-brand-primary-soft/30'
                  : 'bg-charcoal-900 text-bone/50 border-white/10 hover:text-bone/90'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center text-sm text-bone/50">
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
            {/* tab === 'players' + tab === 'coaches' branches
                removed v3.2.63 — both tabs were intentionally
                retired when /people became the unified directory,
                but the conditional render + component impls were
                left behind as unreachable dead code. */}
            {tab === 'calendar' && (
              <CalendarTab events={events} teamById={teamById} />
            )}
            {tab === 'stats' && (
              <StatsTab players={players} teams={teams} teamStats={teamStats} />
            )}
            {tab === 'payments' && canSeeFinancials && (
              <PaymentsTab />
            )}
            {tab === 'payments' && !canSeeFinancials && (
              <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6 text-center text-sm text-bone/60">
                You don't have access to Payments. Ask the club owner for the 'financials' scope.
              </div>
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

// Bucket an ageGroup string into a sort key + label. Handles common
// variants Patrick's club has seen so far: "U10", "u10", "Under 10",
// "10U", "Adult", missing/blank. Anything unknown buckets under "Other"
// so we never silently drop a team.
function ageBucket(raw: string | undefined): { key: string; label: string; sort: number } {
  const s = (raw || '').trim();
  if (!s) return { key: 'unspecified', label: 'No age group', sort: 9999 };
  const m = s.match(/(\d{1,2})/);
  if (m) {
    const n = parseInt(m[1], 10);
    return { key: `u${n}`, label: `U${n}`, sort: n };
  }
  if (/adult/i.test(s)) return { key: 'adult', label: 'Adult', sort: 1000 };
  return { key: s.toLowerCase(), label: s, sort: 5000 };
}

const OverviewTab: React.FC<{
  teams: any[];
  teamStats: any;
  coachNameByUid: (uid: string) => string;
  search: string;
  setSearch: (s: string) => void;
  onTeamClick: (id: string) => void;
}> = ({ teams, teamStats, coachNameByUid, search, setSearch, onTeamClick }) => {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matching = teams.filter((t) =>
      !q || (t.name || '').toLowerCase().includes(q) || (t.ageGroup || '').toLowerCase().includes(q));
    // Bucket by age group.
    const buckets = new Map<string, { label: string; sort: number; teams: any[] }>();
    for (const t of matching) {
      const b = ageBucket(t.ageGroup);
      if (!buckets.has(b.key)) buckets.set(b.key, { label: b.label, sort: b.sort, teams: [] });
      buckets.get(b.key)!.teams.push(t);
    }
    const list = Array.from(buckets.entries()).map(([key, v]) => ({ key, ...v }));
    list.sort((a, b) => a.sort - b.sort);
    for (const g of list) {
      g.teams.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
    }
    return list;
  }, [teams, search]);

  const totalMatching = useMemo(() => groups.reduce((s, g) => s + g.teams.length, 0), [groups]);
  const showGrouped = teams.length > 6 && !search.trim();
  const toggle = (key: string) => setCollapsed((s) => ({ ...s, [key]: !s[key] }));

  const renderTeamLi = (t: any) => {
    const s = teamStats[t.id] || { players: 0, upcoming: 0 };
    const headCoach = t.headCoachId ? coachNameByUid(t.headCoachId) : '';
    return (
      <li key={t.id}>
        <button
          onClick={() => onTeamClick(t.id)}
          className="w-full text-left flex items-center gap-3 px-5 py-3.5 hover:bg-white/[0.05] transition"
        >
          <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-brand-primary to-charcoal-700 text-white flex items-center justify-center font-black text-lg shadow-sm">
            {(t.name || '?').charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-bone truncate">{t.name || 'Untitled team'}</span>
              {t.ageGroup && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-bone/65 bg-white/[0.08] px-1.5 py-0.5 rounded">
                  {t.ageGroup}
                </span>
              )}
            </div>
            <p className="text-xs text-bone/50 truncate mt-0.5">
              {s.players} player{s.players === 1 ? '' : 's'}
              {headCoach ? ` · Head coach: ${headCoach}` : ''}
              {s.upcoming > 0 ? ` · ${s.upcoming} upcoming` : ''}
            </p>
          </div>
          <svg className="w-5 h-5 text-bone/35 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </li>
    );
  };

  return (
    <div className="space-y-3">
      <SearchBar value={search} onChange={setSearch} placeholder="Search teams…" />
      {totalMatching === 0 ? (
        <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
          <div className="p-8 text-center text-sm text-bone/50">
            {teams.length === 0 ? 'No teams in your club yet.' : 'No teams match your search.'}
          </div>
        </div>
      ) : showGrouped ? (
        // Many teams + no active search -> grouped accordion by age.
        <div className="space-y-2.5">
          {groups.map((g) => {
            const isCollapsed = !!collapsed[g.key];
            return (
              <div key={g.key} className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggle(g.key)}
                  className="w-full px-5 py-3 border-b border-white/5 flex items-center justify-between gap-3 hover:bg-white/[0.03] transition"
                >
                  <div className="flex items-center gap-2.5">
                    <svg className={`w-4 h-4 text-bone/55 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    <h2 className="font-bold text-bone">{g.label}</h2>
                  </div>
                  <span className="text-xs text-bone/50">{g.teams.length} team{g.teams.length === 1 ? '' : 's'}</span>
                </button>
                {!isCollapsed && (
                  <ul className="divide-y divide-white/5">
                    {g.teams.map(renderTeamLi)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        // Few teams OR active search -> single flat list.
        <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
          <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
            <h2 className="font-bold text-bone">{search.trim() ? 'Matching teams' : 'All teams'}</h2>
            <span className="text-xs text-bone/50">
              {totalMatching === teams.length ? `${teams.length} total` : `${totalMatching} of ${teams.length}`}
            </span>
          </div>
          <ul className="divide-y divide-white/5">
            {groups.flatMap((g) => g.teams).map(renderTeamLi)}
          </ul>
        </div>
      )}
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
    const palette = ['bg-rose-500/150', 'bg-amber-500/150', 'bg-emerald-500/150', 'bg-brand-primary/150', 'bg-violet-500/150', 'bg-brand-primary/150', 'bg-teal-500', 'bg-fuchsia-500/150'];
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

      <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
          <h2 className="font-bold text-bone">Upcoming across the club</h2>
          <span className="text-xs text-bone/50">{upcoming.length} event{upcoming.length === 1 ? '' : 's'}</span>
        </div>
        {upcoming.length === 0 ? (
          <div className="p-8 text-center text-sm text-bone/50">No upcoming events.</div>
        ) : (
          <ul className="divide-y divide-white/5">
            {upcoming.map((ev: any) => {
              const t = teamById.get(ev.teamId);
              return (
                <li key={ev.id} className="px-5 py-3 flex items-center gap-3">
                  {/* Monoline SVG glyph instead of emoji (per
                      [no emojis] memory). Game = ball outline,
                      practice = runner, other = calendar. */}
                  <div className={`flex-shrink-0 w-10 h-10 rounded-xl ${teamColor(ev.teamId || '')} text-white flex items-center justify-center shadow-sm`}>
                    {ev.type === 'game' ? (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="9" />
                        <path d="m12 3 3 4-1.5 5L8.5 12 7 7zM12 21l-3-4 1.5-5 5 0 1.5 5z" />
                      </svg>
                    ) : ev.type === 'practice' ? (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <circle cx="13" cy="4" r="2" />
                        <path d="M4 22l4-4 2-6 4 4-2 6M14 9l2-2 3 1-2 4 4 2" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-bone truncate">{ev.title || 'Event'}</span>
                      {t && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-bone/65 bg-white/[0.08] px-1.5 py-0.5 rounded">
                          {t.name}
                        </span>
                      )}
                      <span className="text-[10px] font-bold uppercase tracking-wider text-bone/40">
                        {ev.type}
                      </span>
                    </div>
                    <p className="text-xs text-bone/50 truncate mt-0.5">
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

      <div className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-white/5">
          <h2 className="text-xs font-extrabold tracking-widest uppercase text-bone/65">Team leaderboard</h2>
          <p className="text-[11px] text-bone/40 mt-0.5">Ranked by goals scored</p>
        </div>
        <ul className="divide-y divide-white/5">
          {teamLeaders.map((t, i) => {
            const s = teamStats[t.id] || { players: 0, goals: 0, assists: 0 };
            return (
              <li key={t.id} className="px-5 py-3 flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-white/[0.08] text-bone/85 font-bold flex items-center justify-center text-sm">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-bone truncate">{t.name}</p>
                  <p className="text-xs text-bone/50">{s.players} player{s.players === 1 ? '' : 's'} · {s.assists} assists</p>
                </div>
                <div className="text-right">
                  <p className="font-black text-emerald-300 leading-tight">{s.goals}</p>
                  <p className="text-[10px] uppercase tracking-wider text-bone/50 font-bold">goals</p>
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
    className="w-full bg-charcoal-900 border border-white/15 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft text-[15px]"
    style={{ fontSize: '16px' }}
  />
);

const FilterChip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`text-xs font-semibold px-3 py-1.5 rounded-full whitespace-nowrap ring-1 transition ${
      active ? 'bg-brand-primary text-white ring-brand-primary' : 'bg-charcoal-900 text-bone/85 ring-white/15 hover:bg-white/[0.05]'
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
    emerald: 'text-emerald-300 bg-emerald-500/15 border-emerald-400/30',
    cyan: 'text-brand-primary-soft bg-brand-primary/15 border-brand-primary-soft/30',
    amber: 'text-amber-300 bg-amber-500/15 border-amber-400/30',
    violet: 'text-violet-300 bg-violet-500/15 border-violet-400/30',
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
  <div className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm overflow-hidden">
    <div className="px-4 py-3 border-b border-white/5">
      <h3 className="text-xs font-extrabold tracking-widest uppercase text-bone/65">{title}</h3>
    </div>
    {rows.length === 0 ? (
      <div className="p-6 text-center text-sm text-bone/50">No data yet.</div>
    ) : (
      <ul className="divide-y divide-white/5">
        {rows.map((r, i) => (
          <li key={r.id}>
            <Link to={`/player/${r.id}`} className="px-5 py-2.5 flex items-center gap-3 hover:bg-white/[0.05]">
              <div className={`w-7 h-7 rounded-full text-sm font-black flex items-center justify-center ${
                i === 0 ? 'bg-amber-500/20 text-amber-200' : i === 1 ? 'bg-white/15 text-bone/85' : i === 2 ? 'bg-orange-500/20 text-orange-200' : 'bg-white/[0.08] text-bone/65'
              }`}>
                {i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-bone truncate">{r.name}</p>
                <p className="text-xs text-bone/50 truncate">{r.sub}</p>
              </div>
              <div className="font-black text-bone">{r.value}</div>
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
  // Resolves clubId from userData.clubId → first team's clubId →
  // any single club doc. See src/hooks/useClubId.ts for why.
  const { clubId } = useClubId();
  const [club, setClub] = React.useState<any | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [connectFinishing, setConnectFinishing] = React.useState(false);

  // Stripe Connect OAuth return — Stripe sends parents back to
  // /club?stripe_connected=1&state=clubId&code=AUTH_CODE. We post the
  // code to the worker, which exchanges it for a real account ID.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const flag = params.get('stripe_connected');
    if (!code || !state || !flag || !clubId || state !== clubId) return;
    setConnectFinishing(true);
    (async () => {
      try {
        const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
        const NOTIFY_SECRET = process.env.REACT_APP_NOTIFY_SECRET;
        if (!NOTIFY_URL || !NOTIFY_SECRET) { alert('Worker not configured.'); return; }
        const r = await fetch(`${NOTIFY_URL}/stripe/connect/finish`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${NOTIFY_SECRET}`,
          },
          body: JSON.stringify({ code, clubId }),
        });
        const data: any = await r.json().catch(() => ({}));
        if (!r.ok) {
          alert(data?.error || 'Stripe connect finish failed.');
          return;
        }
        // Clean the URL so a refresh doesn't re-fire the exchange.
        window.history.replaceState({}, '', '/club');
        // Reload the club doc so the new state shows.
        const { doc, getDoc } = await import('firebase/firestore');
        const { db } = await import('../utils/firebase');
        const snap = await getDoc(doc(db, 'clubs', clubId));
        if (snap.exists()) setClub({ id: snap.id, ...(snap.data() as any) });
      } finally {
        setConnectFinishing(false);
      }
    })();
  }, [clubId]);

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

  if (loading) return <DataGate when="loading" />;

  return (
    <div className="space-y-3">
      {connectFinishing && (
        <div className="rounded-xl bg-violet-500/15 ring-1 ring-violet-200 px-4 py-3 text-sm text-violet-200">
          Finalizing Stripe Connect…
        </div>
      )}
      {/* Stripe Connect status card */}
      <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <div>
            <h2 className="font-bold text-bone">Stripe Connect</h2>
            <p className="text-[11px] text-bone/50 mt-0.5">Direct payouts to the club's own bank account. 2.9% + 30¢ Stripe fee.</p>
          </div>
          <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded ${
            chargesEnabled ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-300'
              : connected ? 'bg-amber-500/20 text-amber-200 ring-1 ring-amber-300'
              : 'bg-charcoal-950 text-bone/65 ring-1 ring-white/15'
          }`}>
            {chargesEnabled ? 'Active' : connected ? 'Onboarding' : 'Not connected'}
          </span>
        </div>
        <div className="p-5">
          {!connected ? (
            <>
              <p className="text-sm text-bone/85 mb-3">
                Connect a Stripe account to accept team-fee, tournament-entry, and uniform-order payments
                directly from parents. Stripe holds the funds and deposits them to your bank — GoalKickr never
                touches the money.
              </p>
              {/* Disclosure of the platform-fee rate the worker will pass
                  as application_fee_amount. Pulled from the club doc so
                  the rate is always accurate to what's actually
                  configured for THIS club. */}
              <div className="mb-3 rounded-lg bg-white/[0.04] ring-1 ring-white/10 p-3 text-[12px] text-bone/85 leading-relaxed">
                <div className="font-bold text-bone mb-1">What this costs</div>
                <div>
                  <b>Stripe processing:</b> 2.9% + 30¢ per transaction (Stripe's standard rate, deducted before payout).
                </div>
                <div className="mt-1">
                  <b>GoalKickr platform fee:</b>{' '}
                  {(club?.platformFeeBps ?? 0) > 0
                    ? <>{((club!.platformFeeBps as number) / 100).toFixed(2)}% per transaction — helps cover the app, hosting, and email infrastructure.</>
                    : <>0% — none for this club.</>
                  }
                </div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  if (!clubId) {
                    alert("Couldn't find your club. Your user doc isn't linked to a clubId — set it in Firestore (users/<uid>.clubId) or join a team first.");
                    return;
                  }
                  try {
                    const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
                    if (!NOTIFY_URL) {
                      alert('Worker URL not configured (REACT_APP_NOTIFY_URL).');
                      return;
                    }
                    const url = `${NOTIFY_URL}/stripe/connect/start?clubId=${encodeURIComponent(clubId)}`;
                    const r = await fetch(url);
                    const data: any = await r.json().catch(() => ({}));
                    if (r.ok && data?.url) {
                      window.location.assign(data.url);
                      return;
                    }
                    if (data?.error === 'stripe-connect-not-configured') {
                      alert('Stripe Connect secrets not set on the worker. Run:\n\nnpx wrangler secret put STRIPE_CONNECT_CLIENT_ID\n\nthen redeploy the worker.');
                      return;
                    }
                    alert(`Connect start failed (${r.status}): ${data?.error || 'unknown error'}\n\nWorker URL: ${url}`);
                  } catch (err: any) {
                    alert(`Network error reaching the worker: ${err?.message || err}\n\nThis usually means REACT_APP_NOTIFY_URL is wrong or the worker isn't reachable from this device.`);
                  }
                }}
                disabled={!clubId}
                className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500/150 disabled:opacity-50 text-white text-sm font-bold"
              >
                {clubId ? 'Connect Stripe' : 'Resolving club…'}
              </button>
            </>
          ) : (
            <div className="space-y-2 text-sm text-bone/85">
              <div className="flex items-center justify-between">
                <span>Account ID</span>
                <code className="text-[11px] text-bone/50">{club.stripeAccountId}</code>
              </div>
              <div className="flex items-center justify-between">
                <span>Charges enabled</span>
                <span className={chargesEnabled ? 'text-emerald-300 font-bold' : 'text-amber-300 font-bold'}>
                  {chargesEnabled ? 'Yes' : 'Pending KYC'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Payouts enabled</span>
                <span className={club.stripePayoutsEnabled ? 'text-emerald-300 font-bold' : 'text-amber-300 font-bold'}>
                  {club.stripePayoutsEnabled ? 'Yes' : 'Pending'}
                </span>
              </div>
              {/* Read-only platform fee disclosure for the club.
                  Settable only by the platform owner at /platform/clubs
                  — surfaced here so the club always knows their rate. */}
              <div className="flex items-center justify-between pt-2 mt-1 border-t border-white/5">
                <span>GoalKickr platform fee</span>
                <span className="font-bold text-bone">
                  {((club.platformFeeBps ?? 0) / 100).toFixed(2)}%
                </span>
              </div>
              <p className="text-[10px] text-bone/50">
                Plus Stripe's standard 2.9% + 30¢ per transaction.
              </p>
              <div className="pt-3 mt-2 border-t border-white/5">
                <button
                  type="button"
                  onClick={async () => {
                    if (!clubId) return;
                    const confirm = window.confirm(
                      `Disconnect Stripe from this club?\n\nThis stops new payments from working until you reconnect. Past transactions and refund history are NOT affected.`
                    );
                    if (!confirm) return;
                    try {
                      const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
                      const NOTIFY_SECRET = process.env.REACT_APP_NOTIFY_SECRET;
                      if (!NOTIFY_URL || !NOTIFY_SECRET) { alert('Worker not configured.'); return; }
                      const r = await fetch(`${NOTIFY_URL}/stripe/connect/disconnect`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
                        body: JSON.stringify({ clubId }),
                      });
                      const data: any = await r.json().catch(() => ({}));
                      if (!r.ok) {
                        alert(data?.error || 'Disconnect failed.');
                        return;
                      }
                      // Refresh the club doc so the UI flips back to
                      // "Not connected" state.
                      const { doc, getDoc } = await import('firebase/firestore');
                      const { db } = await import('../utils/firebase');
                      const snap = await getDoc(doc(db, 'clubs', clubId));
                      if (snap.exists()) setClub({ id: snap.id, ...(snap.data() as any) });
                    } catch (err: any) {
                      alert(err?.message || 'Network error.');
                    }
                  }}
                  className="text-[10px] font-extrabold tracking-widest uppercase text-rose-300 hover:text-rose-900"
                >
                  Disconnect Stripe
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Invoices list — empty for now; lights up when the worker
          can actually create Checkout Sessions. */}
      <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
          <h2 className="font-bold text-bone">Invoices</h2>
          <button
            type="button"
            disabled={!chargesEnabled}
            onClick={() => alert('Coming once Stripe Connect is active.')}
            className="text-[10px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded bg-brand-primary/15 text-brand-primary-soft ring-1 ring-brand-primary-soft/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            + Create
          </button>
        </div>
        <div className="p-8 text-center text-sm text-bone/50">
          {connected
            ? 'No invoices yet — create one to see it here.'
            : 'Connect Stripe above to start creating invoices.'}
        </div>
      </div>
    </div>
  );
};

export default ClubOverview;
