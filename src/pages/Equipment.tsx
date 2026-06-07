import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTeam } from '../contexts/TeamContext';
import { useFirestore } from '../hooks/useFirestore';
import { Player } from '../types';
import { isCoach } from '../utils/helpers';

type SortKey = 'name' | 'status' | 'jersey';

const Equipment: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { getDocuments } = useFirestore();
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'outstanding' | 'returned'>('outstanding');
  const [sort, setSort] = useState<SortKey>('name');
  const allowed = userData ? isCoach(userData.role) : false;

  useEffect(() => {
    if (!selectedTeamId || !allowed) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const all = await getDocuments('players', []);
        const teamPlayers = (all as any[])
          .filter(p => p && p.isActive !== false)
          .filter(p => (Array.isArray(p.teamIds) && p.teamIds.includes(selectedTeamId)) || p.teamId === selectedTeamId);
        if (!cancelled) setPlayers(teamPlayers as Player[]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId, allowed, getDocuments]);

  const rows = useMemo(() => {
    const filtered = players.filter(p => {
      const eq = (p as any).equipment || {};
      const hasAny = !!(eq.jerseyHomeSize || eq.jerseyAwaySize || eq.shortsSize || eq.socksSize || eq.trainingTopSize);
      if (filter === 'returned') return !!eq.returned;
      if (filter === 'outstanding') return hasAny && !eq.returned;
      return true;
    });
    return filtered.sort((a, b) => {
      if (sort === 'jersey') {
        const aj = a.jerseyNumber ?? 999;
        const bj = b.jerseyNumber ?? 999;
        return aj - bj;
      }
      if (sort === 'status') {
        const aReturned = !!(a as any).equipment?.returned;
        const bReturned = !!(b as any).equipment?.returned;
        if (aReturned !== bReturned) return aReturned ? 1 : -1;
        return a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });
  }, [players, filter, sort]);

  const totals = useMemo(() => {
    let outstanding = 0;
    let returned = 0;
    let untracked = 0;
    for (const p of players) {
      const eq = (p as any).equipment || {};
      const hasAny = !!(eq.jerseyHomeSize || eq.jerseyAwaySize || eq.shortsSize || eq.socksSize || eq.trainingTopSize);
      if (!hasAny) untracked++;
      else if (eq.returned) returned++;
      else outstanding++;
    }
    return { outstanding, returned, untracked };
  }, [players]);

  if (!allowed) {
    return (
      <div className="min-h-screen bg-fire-50 flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <p className="text-sm font-bold text-slate-700">Coach access only</p>
          <p className="text-xs text-slate-500 mt-1">Equipment tracking is visible to coaches and to the parents of each player on that player's profile.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-fire-50">
      <section className="bg-gradient-to-b from-slate-950 to-slate-900 px-4 sm:px-6 py-5 border-b border-cyan-500/10">
        <div className="max-w-4xl mx-auto">
          <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-cyan-300 hover:text-cyan-200 mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Dashboard
          </Link>
          <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight">Equipment</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {selectedTeam?.name ? `${selectedTeam.name} — ` : ''}who has what gear, who hasn't returned.
          </p>
        </div>
      </section>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5 space-y-3">
        {/* Summary tiles */}
        <div className="grid grid-cols-3 gap-2">
          <Tile label="Outstanding" value={totals.outstanding} tone="amber" />
          <Tile label="Returned" value={totals.returned} tone="emerald" />
          <Tile label="No record" value={totals.untracked} tone="slate" />
        </div>

        {/* Filter + sort row */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg bg-white ring-1 ring-slate-200 p-0.5">
            {(['outstanding', 'returned', 'all'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 text-[10px] font-extrabold tracking-widest uppercase rounded ${
                  filter === f ? 'bg-cyan-600 text-white' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-600">
            <span className="font-bold uppercase tracking-widest">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="bg-white border border-slate-300 rounded-md px-2 py-1 text-xs"
            >
              <option value="name">Name</option>
              <option value="jersey">Jersey #</option>
              <option value="status">Status</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              {filter === 'outstanding' ? 'Nothing outstanding — everyone returned their gear (or nothing was issued).' :
               filter === 'returned' ? 'No returned gear logged yet.' :
               'No players on this team yet.'}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {rows.map(p => {
                const eq = (p as any).equipment || {};
                const hasAny = !!(eq.jerseyHomeSize || eq.jerseyAwaySize || eq.shortsSize || eq.socksSize || eq.trainingTopSize);
                const sizes: string[] = [];
                if (eq.jerseyHomeSize) sizes.push(`H ${eq.jerseyHomeSize}`);
                if (eq.jerseyAwaySize) sizes.push(`A ${eq.jerseyAwaySize}`);
                if (eq.shortsSize) sizes.push(`Sh ${eq.shortsSize}`);
                if (eq.socksSize) sizes.push(`Sk ${eq.socksSize}`);
                if (eq.trainingTopSize) sizes.push(`Tr ${eq.trainingTopSize}`);
                return (
                  <li key={p.id}>
                    <Link to={`/player/${p.id}`} className="block px-4 py-3 hover:bg-slate-50">
                      <div className="flex items-center gap-3">
                        {p.profilePhotoUrl ? (
                          <img src={p.profilePhotoUrl} alt={p.name} className="w-9 h-9 rounded-full object-cover flex-shrink-0 ring-1 ring-slate-200" />
                        ) : (
                          <span className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-500 to-cyan-700 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                            {p.jerseyNumber != null ? `#${p.jerseyNumber}` : p.name.charAt(0).toUpperCase()}
                          </span>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-slate-900 truncate">{p.name}</span>
                            {p.jerseyNumber != null && <span className="text-[10px] font-bold text-slate-500 tabular-nums">#{p.jerseyNumber}</span>}
                          </div>
                          <div className="text-[11px] text-slate-500 truncate">
                            {hasAny ? sizes.join(' · ') : 'No gear recorded'}
                          </div>
                        </div>
                        <span className={`flex-shrink-0 text-[10px] font-extrabold tracking-widest uppercase px-2 py-0.5 rounded ${
                          !hasAny ? 'bg-slate-100 text-slate-500 ring-1 ring-slate-200'
                            : eq.returned ? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300'
                            : 'bg-amber-100 text-amber-800 ring-1 ring-amber-300'
                        }`}>
                          {!hasAny ? 'No record' : eq.returned ? 'Returned' : 'Outstanding'}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

const Tile: React.FC<{ label: string; value: number; tone: 'amber' | 'emerald' | 'slate' }> = ({ label, value, tone }) => {
  const tones = {
    amber: 'bg-amber-50 text-amber-900 ring-amber-200',
    emerald: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
    slate: 'bg-white text-slate-900 ring-slate-200',
  } as const;
  return (
    <div className={`rounded-xl ring-1 px-4 py-3 ${tones[tone]}`}>
      <div className="text-2xl font-black tabular-nums leading-none">{value}</div>
      <div className="text-[10px] font-extrabold tracking-widest uppercase mt-1 opacity-80">{label}</div>
    </div>
  );
};

export default Equipment;
