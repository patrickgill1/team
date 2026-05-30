// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import Header from '../components/common/Header';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { isCoach } from '../utils/helpers';

// Club-level "People" directory. One searchable, filterable list of
// every person tied to the current club — players, parents, coaches,
// admins, team managers. Replaces the fragmented "find a parent in
// the parent directory, find a player in the roster, find a coach in
// team management" tour with one surface.

type Role = 'player' | 'parent' | 'coach' | 'team_manager' | 'admin';

interface Person {
  type: 'player' | 'user';
  id: string;
  uid?: string;
  name: string;
  email?: string;
  photoURL?: string;
  role: Role;
  teamIds: string[];
  childNames?: string[];  // for parents
  isActive: boolean;
}

const ROLE_LABEL: Record<Role, string> = {
  player: 'Player',
  parent: 'Parent',
  coach: 'Coach',
  team_manager: 'Manager',
  admin: 'Admin',
};
const ROLE_CHIP: Record<Role, string> = {
  player: 'bg-blue-50 text-blue-700 border-blue-200',
  parent: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  coach: 'bg-amber-50 text-amber-700 border-amber-200',
  team_manager: 'bg-violet-50 text-violet-700 border-violet-200',
  admin: 'bg-rose-50 text-rose-700 border-rose-200',
};

const People: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { getDocuments } = useFirestore();

  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | Role>('all');
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);

  const isUserCoach = userData ? isCoach(userData.role) : false;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Pull the club ID from the current team OR the user's clubId
        // (which the migration set on every player and that we mirror
        // onto users in a follow-up). Fall back to a single-team scope
        // if no club exists.
        const clubId = (userData as any)?.clubId
          || (selectedTeamId ? await getClubIdForTeam(selectedTeamId) : null);

        const [allPlayers, allUsers, allTeams] = await Promise.all([
          getDocuments('players', []),
          getDocuments('users', []),
          getDocuments('teams', []),
        ]);
        if (cancelled) return;

        // Determine team scope. If we have a club, use every team in it.
        const teamsInClub = clubId
          ? (allTeams as any[]).filter(t => clubId && (t as any).clubId === clubId)
          : (allTeams as any[]);
        // Fall back to teams the current user belongs to if club lookup
        // hasn't migrated those team docs yet.
        const fallbackTeamIds = (userData?.teamIds || []).concat(userData?.teamId || []);
        const effectiveTeams = teamsInClub.length
          ? teamsInClub
          : (allTeams as any[]).filter(t => fallbackTeamIds.includes(t.id));
        const teamIdSet = new Set(effectiveTeams.map(t => t.id));
        setTeams(effectiveTeams.map(t => ({ id: t.id, name: t.name })));

        const out: Person[] = [];

        // Players in any of our teams
        for (const p of allPlayers as any[]) {
          const pTeamIds: string[] = Array.isArray(p.teamIds) ? p.teamIds : (p.teamId ? [p.teamId] : []);
          const intersect = pTeamIds.filter(t => teamIdSet.has(t));
          if (intersect.length === 0) continue;
          out.push({
            type: 'player',
            id: p.id,
            name: p.name,
            photoURL: p.profilePhotoUrl,
            role: 'player',
            teamIds: intersect,
            isActive: p.isActive !== false,
          });
        }

        // Users (parents/coaches/admins) on any of our teams
        for (const u of allUsers as any[]) {
          const uTeamIds: string[] = Array.isArray(u.teamIds) ? u.teamIds : (u.teamId ? [u.teamId] : []);
          const intersect = uTeamIds.filter(t => teamIdSet.has(t));
          if (intersect.length === 0) continue;
          const role: Role =
            u.isClubAdmin ? 'admin'
            : u.role === 'team_manager' ? 'team_manager'
            : u.role === 'coach' ? 'coach'
            : 'parent';
          out.push({
            type: 'user',
            id: u.id || u.uid,
            uid: u.uid,
            name: u.name || (u.email || 'Unknown'),
            email: u.email,
            photoURL: u.photoURL,
            role,
            teamIds: intersect,
            isActive: u.isActive !== false,
          });
        }

        // For parents, look up their kids' names via player.parentIds /
        // parentEmails. Cheap client-side join over the players we
        // already loaded.
        const parentLookup = new Map<string, string[]>();
        for (const p of allPlayers as any[]) {
          const emails: string[] = (p.parentEmails || []).map((e: string) => e.toLowerCase().trim());
          const parentIds: string[] = Array.isArray(p.parentIds) ? p.parentIds : (p.parentId ? [p.parentId] : []);
          for (const uid of parentIds) {
            const arr = parentLookup.get(uid) || [];
            arr.push(p.name);
            parentLookup.set(uid, arr);
          }
          for (const email of emails) {
            const arr = parentLookup.get(`email:${email}`) || [];
            arr.push(p.name);
            parentLookup.set(`email:${email}`, arr);
          }
        }
        for (const person of out) {
          if (person.role === 'parent' && person.uid) {
            person.childNames = parentLookup.get(person.uid)
              || (person.email ? parentLookup.get(`email:${person.email.toLowerCase()}`) : undefined);
          }
        }

        // Stable sort: active first, then alpha.
        out.sort((a, b) => {
          if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        setPeople(out);
      } catch (err) {
        console.error('People load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userData, selectedTeamId, getDocuments]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter(p => {
      if (roleFilter !== 'all' && p.role !== roleFilter) return false;
      if (teamFilter !== 'all' && !p.teamIds.includes(teamFilter)) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.email || ''} ${(p.childNames || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [people, query, roleFilter, teamFilter]);

  const counts = useMemo(() => {
    const c: Record<'all' | Role, number> = { all: people.length, player: 0, parent: 0, coach: 0, team_manager: 0, admin: 0 };
    for (const p of people) c[p.role]++;
    return c;
  }, [people]);

  const teamNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of teams) m[t.id] = t.name;
    return m;
  }, [teams]);

  return (
    <div className="min-h-screen bg-slate-100">
      <Header title="People" subtitle={people.length ? `${people.length} in your club` : undefined} />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4 space-y-3">
        {/* Search + team filter */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <svg className="absolute inset-y-0 left-0 pl-3 my-auto w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, email, or kid's name…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
            />
          </div>
          {teams.length > 1 && (
            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
            >
              <option value="all">All teams</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
        </div>

        {/* Role pills */}
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {([
            { k: 'all' as const, label: 'All' },
            { k: 'player' as const, label: 'Players' },
            { k: 'parent' as const, label: 'Parents' },
            { k: 'coach' as const, label: 'Coaches' },
            ...(counts.team_manager ? [{ k: 'team_manager' as const, label: 'Managers' }] : []),
            ...(counts.admin ? [{ k: 'admin' as const, label: 'Admins' }] : []),
          ]).map(({ k, label }) => (
            <button
              key={k}
              onClick={() => setRoleFilter(k as any)}
              className={`px-3 py-1 rounded-md text-[11px] font-extrabold tracking-widest uppercase border whitespace-nowrap ${
                roleFilter === k
                  ? 'bg-cyan-50 text-cyan-700 border-cyan-200'
                  : 'bg-white text-slate-500 border-slate-200 hover:text-slate-800'
              }`}
            >
              {label} <span className={roleFilter === k ? 'text-cyan-600' : 'text-slate-400'}>{counts[k as any]}</span>
            </button>
          ))}
        </div>

        {/* List */}
        {loading ? (
          <div className="flex justify-center py-10">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-cyan-200 border-t-cyan-500" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <p className="text-slate-500 text-sm">No one matches.</p>
          </div>
        ) : (
          <ul className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100 overflow-hidden">
            {filtered.map(p => {
              const initial = (p.name || '?').charAt(0).toUpperCase();
              const linkTo = p.type === 'player' ? `/player/${p.id}` : undefined;
              const Row = (
                <li className="px-3 py-2.5 flex items-center gap-2.5 hover:bg-slate-50 transition-colors">
                  {p.photoURL ? (
                    <img src={p.photoURL} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <span className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-400 to-slate-600 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">{initial}</span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-slate-900 truncate">{p.name}</span>
                      <span className={`text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border ${ROLE_CHIP[p.role]}`}>
                        {ROLE_LABEL[p.role]}
                      </span>
                      {!p.isActive && (
                        <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded border bg-slate-100 text-slate-400 border-slate-200">
                          Inactive
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate mt-0.5">
                      {p.role === 'parent' && p.childNames && p.childNames.length
                        ? `Kid${p.childNames.length === 1 ? '' : 's'}: ${p.childNames.join(', ')}`
                        : p.email || (p.teamIds.length ? p.teamIds.map(t => teamNameById[t] || '').filter(Boolean).join(' · ') : '')}
                    </div>
                  </div>
                  {p.teamIds.length > 0 && (
                    <div className="hidden sm:flex flex-wrap gap-1 justify-end max-w-[200px]">
                      {p.teamIds.slice(0, 2).map(tid => (
                        <span key={tid} className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                          {teamNameById[tid] || tid.slice(0, 6)}
                        </span>
                      ))}
                      {p.teamIds.length > 2 && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                          +{p.teamIds.length - 2}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
              return linkTo ? (
                <Link to={linkTo} key={`${p.type}-${p.id}`}>{Row}</Link>
              ) : (
                <div key={`${p.type}-${p.id}`}>{Row}</div>
              );
            })}
          </ul>
        )}

        {!isUserCoach && people.length > 0 && (
          <p className="text-[11px] text-slate-400 text-center py-2">
            Viewing your club's people. Coaches can add or remove members.
          </p>
        )}
      </div>
    </div>
  );
};

// Small helper — resolves the clubId of a team from its team doc.
async function getClubIdForTeam(teamId: string): Promise<string | null> {
  try {
    const snap = await getDocs(query(collection(db, 'teams'), where('__name__', '==', teamId)));
    const doc = snap.docs[0];
    return doc ? ((doc.data() as any).clubId || null) : null;
  } catch {
    return null;
  }
}

export default People;
