// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import TeamFunnelStepper from '../components/team/TeamFunnelStepper';
import type { Team, TeamFunnelStageKey } from '../types';

// Admin teams cockpit — lists every team in the club with its
// activation funnel state at a glance. The "Teams to activate" chip
// on the dashboard AdminCockpit links here. Patrick 2026-06-21:
// 'need to make sure teams have that same timeline as the player does
// (things like, tryouts -> team selected-> All players registered ->
// coaching licenses and certification criteria met -> Team Activated).'
//
// This page is the canonical place where admins drive teams through
// that workflow. Each row shows: team name + ageGroup + small inline
// funnel summary. Tap a row to expand the full TeamFunnelStepper for
// that team with the mark/undo affordances.
//
// Access is gated client-side to userData.isClubAdmin === true. The
// Firestore rules layer still enforces per-doc participation/coach
// gates on the underlying writes, so a non-admin who lands on this
// URL gets an empty list (their reads filter to nothing) AND can't
// successfully stamp anything they shouldn't.

const STAGE_ORDER: TeamFunnelStageKey[] = [
  'tryouts',
  'team_selected',
  'all_registered',
  'coaches_certified',
  'activated',
];

const AdminTeams: React.FC = () => {
  const { userData } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Multi-tenant lock (2026-06-23): only load teams in clubs
        // this admin actually administers. Previously this fetched
        // EVERY active team in the database. If the user has no
        // clubIds on their doc, render nothing — better than leaking
        // every club's teams into one admin's view.
        const clubIds: string[] = Array.isArray((userData as any)?.clubIds)
          ? (userData as any).clubIds
          : (userData as any)?.clubId ? [(userData as any).clubId] : [];
        if (clubIds.length === 0) {
          if (!cancelled) setRows([]);
          return;
        }
        const snap = await getDocs(query(
          collection(db, 'teams'),
          where('isActive', '==', true),
          where('clubId', 'in', clubIds.slice(0, 30)),
        ));
        if (cancelled) return;
        const list: Team[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        // Sort: un-activated first (most actionable), then by name.
        list.sort((a, b) => {
          const aDone = !!(a as any).funnelProgress?.activated?.completedAt;
          const bDone = !!(b as any).funnelProgress?.activated?.completedAt;
          if (aDone !== bDone) return aDone ? 1 : -1;
          return (a.name || '').localeCompare(b.name || '');
        });
        setTeams(list);
      } catch (err) {
        console.warn('[admin-teams] load failed', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const isClubAdmin = (userData as any)?.isClubAdmin === true;

  if (!isClubAdmin) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 text-center">
        <p className="text-bone/85 font-semibold mb-1">Admin only</p>
        <p className="text-bone/55 text-sm mb-4">This page is for club admins.</p>
        <Link to="/dashboard" className="text-crimson-300 font-bold text-sm hover:text-crimson-200">← Back to dashboard</Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 relative">
      <div className="mb-5 sm:mb-7">
        <p className="text-[11px] font-extrabold tracking-widest uppercase text-crimson-400">Club admin</p>
        <h1 className="font-display text-2xl sm:text-3xl font-black text-bone mt-1">Team activation</h1>
        <p className="text-sm text-bone/65 mt-1.5">
          Drive every team through the five activation stages. Stamp manually until the Sports Affinity API is wired; some stages auto-fill from existing data.
        </p>
      </div>

      {showProgress && !loaded && (
        <div className="h-0.5 bg-crimson-500/15 overflow-hidden rounded-full mb-3">
          <div className="h-full w-1/3 bg-crimson-500 animate-progress-slide" />
        </div>
      )}

      <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        {teams.length === 0 && loaded ? (
          <div className="rounded-2xl bg-charcoal-900 ring-1 ring-white/10 p-10 text-center">
            <p className="text-bone/85 font-semibold mb-1">No active teams yet</p>
            <p className="text-bone/50 text-sm">Teams appear here once you create them in the club tools.</p>
          </div>
        ) : (
          <ul className="space-y-3 animate-fade-in">
            {teams.map((team) => {
              const progress: any = (team as any).funnelProgress || {};
              const doneCount = STAGE_ORDER.filter((k) => !!progress[k]?.completedAt).length;
              const isActivated = !!progress.activated?.completedAt;
              const isExpanded = expandedTeamId === team.id;
              return (
                <li key={team.id} className="rounded-2xl bg-charcoal-900 ring-1 ring-white/10 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedTeamId(isExpanded ? null : team.id)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-white/[0.03] transition-colors text-left"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[15px] font-black text-bone truncate">{team.name}</span>
                        {isActivated ? (
                          <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30">Activated</span>
                        ) : (
                          <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30">Pending</span>
                        )}
                      </div>
                      <div className="text-[12px] text-bone/55 truncate">
                        {team.ageGroup || '—'}{team.season ? ` · ${team.season}` : ''}{team.league ? ` · ${team.league}` : ''}
                      </div>
                    </div>
                    <div className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 tabular-nums shrink-0">
                      {doneCount} / {STAGE_ORDER.length}
                    </div>
                    <svg className={`w-4 h-4 text-bone/40 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-4 pt-1 border-t border-white/5 animate-fade-in">
                      <TeamFunnelStepper
                        teamId={team.id}
                        progress={(team as any).funnelProgress}
                        canEdit
                        actorUid={(userData as any)?.uid}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default AdminTeams;
