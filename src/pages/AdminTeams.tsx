// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useClubId as useClubIdHook } from '../hooks/useClubId';
import { isClubAdmin as checkIsClubAdmin } from '../utils/helpers';
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
  // Bump counter to trigger a re-fetch after TeamFunnelStepper marks
  // or undoes a stage. Keeps the activation chips in sync without a
  // full page refresh.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (loaded) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  // Load every team the admin should see:
  //   (a) teams in any club they're a member of (availableClubIds)
  //   (b) teams they're directly on (userData.teamIds) — covers the
  //       case where a team was created without a clubId or belongs
  //       to a club not on the user doc yet.
  // Merged + deduped by id. Patrick 2026-10-22: /admin/teams was
  // only showing one team ("STG Liverpool Depends") because the
  // sibling team's clubId wasn't in availableClubIds. Direct-team
  // branch closes that gap without needing every team doc to carry
  // a perfect clubId backfill.
  const { availableClubIds } = useClubIdHook();
  const directTeamIds: string[] = Array.isArray((userData as any)?.teamIds)
    ? (userData as any).teamIds.filter(Boolean)
    : (userData as any)?.teamId ? [(userData as any).teamId] : [];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const seen = new Map<string, Team>();

        // (a) By clubId. Chunked to Firestore's 30-id in-cap.
        if (availableClubIds.length > 0) {
          const chunks: string[][] = [];
          for (let i = 0; i < availableClubIds.length; i += 30) {
            chunks.push(availableClubIds.slice(i, i + 30));
          }
          const snaps = await Promise.all(chunks.map((chunk) => getDocs(query(
            collection(db, 'teams'),
            where('isActive', '==', true),
            where('clubId', 'in', chunk),
          ))));
          snaps.forEach((snap) => snap.forEach((d) => {
            seen.set(d.id, { id: d.id, ...(d.data() as any) } as Team);
          }));
        }

        // (b) By direct teamIds — catches teams without a clubId or
        //     teams in a club the user doc hasn't yet denormalized.
        if (directTeamIds.length > 0) {
          const { documentId } = await import('firebase/firestore');
          const chunks: string[][] = [];
          for (let i = 0; i < directTeamIds.length; i += 30) {
            chunks.push(directTeamIds.slice(i, i + 30));
          }
          const snaps = await Promise.all(chunks.map((chunk) => getDocs(query(
            collection(db, 'teams'),
            where(documentId(), 'in', chunk),
          ))));
          snaps.forEach((snap) => snap.forEach((d) => {
            if (seen.has(d.id)) return;
            const data = d.data() as any;
            if (data.isActive === false) return;
            seen.set(d.id, { id: d.id, ...data } as Team);
          }));
        }

        if (cancelled) return;
        const list: Team[] = Array.from(seen.values());
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
  }, [availableClubIds.join('|'), directTeamIds.join('|'), reloadKey]);

  // Use the helper (not the raw flag). See SeasonWizard for the full
  // reason — tl;dr: the flag is reserved for platform owners, so a
  // "Start a club, I'm not a coach" admin gets role:'club_admin' but
  // no raw flag and was bounced from their own cockpit CTA. Patrick
  // 2026-10-21 audit (B1).
  const isAdmin = checkIsClubAdmin(userData);

  if (!isAdmin) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 text-center">
        <p className="text-ink-primary/85 font-semibold mb-1">Admin only</p>
        <p className="text-ink-primary/55 text-sm mb-4">This page is for club admins.</p>
        <Link to="/dashboard" className="text-brand-primary-soft font-bold text-sm hover:text-brand-primary-soft">← Back to dashboard</Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 relative">
      <div className="mb-5 sm:mb-7 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft">Club admin</p>
          <h1 className="font-display text-2xl sm:text-3xl font-black text-ink-primary mt-1">Team activation</h1>
          <p className="text-sm text-ink-primary/65 mt-1.5">
            Drive every team through the five activation stages. Stages auto-fill when data exists in the app; stamp the rest manually.
          </p>
        </div>
        <Link
          to="/teams"
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary text-brand-primary-fg text-sm font-bold shadow-md"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          <span className="hidden sm:inline">New team</span>
        </Link>
      </div>

      {showProgress && !loaded && (
        <div className="h-0.5 bg-brand-primary/15 overflow-hidden rounded-full mb-3">
          <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
        </div>
      )}

      <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        {teams.length === 0 && loaded ? (
          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 p-10 text-center">
            <p className="text-ink-primary/85 font-semibold mb-1">No active teams yet</p>
            <p className="text-ink-primary/50 text-sm mb-4">Create your first team to start driving it through the activation funnel.</p>
            <Link
              to="/teams"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary text-brand-primary-fg text-sm font-bold"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              New team
            </Link>
          </div>
        ) : (
          <ul className="space-y-3 animate-fade-in">
            {teams.map((team) => {
              const progress: any = (team as any).funnelProgress || {};
              const doneCount = STAGE_ORDER.filter((k) => !!progress[k]?.completedAt).length;
              const isActivated = !!progress.activated?.completedAt;
              const isExpanded = expandedTeamId === team.id;
              return (
                <li key={team.id} className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/10 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedTeamId(isExpanded ? null : team.id)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-line-default/[0.03] transition-colors text-left"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[15px] font-black text-ink-primary truncate">{team.name}</span>
                        {isActivated ? (
                          <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30">Activated</span>
                        ) : (
                          <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30">Pending</span>
                        )}
                      </div>
                      <div className="text-[12px] text-ink-primary/55 truncate">
                        {team.ageGroup || '—'}{team.season ? ` · ${team.season}` : ''}{team.league ? ` · ${team.league}` : ''}
                      </div>
                    </div>
                    <div className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/55 tabular-nums shrink-0">
                      {doneCount} / {STAGE_ORDER.length}
                    </div>
                    <svg className={`w-4 h-4 text-ink-primary/40 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-4 pt-1 border-t border-line-default/5 animate-fade-in">
                      <TeamFunnelStepper
                        onChange={() => setReloadKey((k) => k + 1)}
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
