// @ts-nocheck
import React, { useState } from 'react';
import { doc, serverTimestamp, updateDoc, deleteField } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { TeamFunnelProgress, TeamFunnelStageKey } from '../../types';

// Team-activation funnel stepper — five stages tracking the path from
// tryouts to fully-activated-for-season. Mirrors the player FunnelStepper
// in shape and interaction; the difference is the stage list and the
// underlying collection (writes to `teams/{teamId}` instead of
// `players/{playerId}`).
//
// Patrick 2026-06-21: 'we are going to be the best damn team management
// app on the market.' This is the wedge — Sports Affinity shows team
// activation at the club-staff level but doesn't put it in the
// admin/coach's hand inside the team app. GoalKickr does.
//
// Stages:
//   tryouts            — held + concluded (manual stamp by admin)
//   team_selected      — roster locked + head coach assigned (auto-fills
//                        once team.headCoachId is set AND team.playerIds
//                        has at least one entry)
//   all_registered     — every player on the roster has registration +
//                        waivers signed (auto-fill computed in the admin
//                        teams view; surfaced here as a manual mark for
//                        single-team use)
//   coaches_certified  — every coach on the team has all four required
//                        cert kinds on file (coach license, background
//                        check, concussion training, safesport training).
//                        Auto-fill comes when the Sports Affinity API is
//                        wired; until then admin stamps manually.
//   activated          — final go-live gate. Admin stamps after reviewing
//                        the other four. Team is now 'live' for the
//                        current season.

interface Stage {
  key: TeamFunnelStageKey;
  short: string;
  label: string;
  hint: string;
  autoNote?: string;
}

const STAGES: Stage[] = [
  { key: 'tryouts',           short: 'Tryouts',  label: 'Tryouts complete',          hint: 'Tryouts held and evaluation finished.',                              autoNote: 'Manual stamp — flip when the last tryout date is past and selections are made.' },
  { key: 'team_selected',     short: 'Roster',   label: 'Roster locked',             hint: 'Head coach assigned and at least one player on the roster.',         autoNote: 'Auto-completes when team.headCoachId is set AND team.playerIds is non-empty.' },
  { key: 'all_registered',    short: 'Reg',      label: 'All registered',            hint: 'Every player has registration + waivers signed.',                    autoNote: 'Auto-completes when each player has registration done and all required waivers signed.' },
  { key: 'coaches_certified', short: 'Certs',    label: 'Coaches certified',         hint: 'Every coach has license + background check + concussion + SafeSport.', autoNote: 'Auto-fill when the Sports Affinity API is wired. For now, stamp manually after checking learning.ussoccer.com.' },
  { key: 'activated',         short: 'Activate', label: 'Team activated',            hint: 'Final go-live gate. Team is live for the season.',                   autoNote: 'Manual stamp — flip after the other four are green.' },
];

interface Props {
  teamId: string;
  progress?: TeamFunnelProgress;
  /** When true, render stage circles as interactive (mark / undo). */
  canEdit?: boolean;
  /** UID stamped on manual writes. Falls back to 'manual'. */
  actorUid?: string;
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object' && v !== null && 'toDate' in v && typeof (v as any).toDate === 'function') {
    try { return (v as any).toDate(); } catch { return null; }
  }
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  return null;
}

const TeamFunnelStepper: React.FC<Props> = ({ teamId, progress, canEdit = false, actorUid }) => {
  const [openStage, setOpenStage] = useState<TeamFunnelStageKey | null>(null);
  const [saving, setSaving] = useState(false);

  const isDone = (key: TeamFunnelStageKey) => !!progress?.[key]?.completedAt;
  const doneCount = STAGES.filter((s) => isDone(s.key)).length;
  const isComplete = doneCount === STAGES.length;
  const nextPendingKey: TeamFunnelStageKey | null = isComplete
    ? null
    : (STAGES.find((s) => !isDone(s.key))?.key ?? null);

  const markDone = async (key: TeamFunnelStageKey) => {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, 'teams', teamId), {
        [`funnelProgress.${key}`]: {
          completedAt: serverTimestamp(),
          by: actorUid || 'manual',
          meta: { manual: true },
        },
      });
      setOpenStage(null);
    } catch (err) {
      console.warn('[team-funnel] mark done failed', err);
    } finally {
      setSaving(false);
    }
  };

  const undoDone = async (key: TeamFunnelStageKey) => {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, 'teams', teamId), {
        [`funnelProgress.${key}`]: deleteField(),
      });
      setOpenStage(null);
    } catch (err) {
      console.warn('[team-funnel] undo failed', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl bg-charcoal-900 ring-1 ring-white/10 p-3 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[10px] font-extrabold tracking-widest uppercase text-bone/50">
            Team activation
          </div>
          <div className="text-sm font-bold text-bone">
            {isComplete ? (
              <span className="text-emerald-300">Activated</span>
            ) : (
              <>
                <span className="text-bone/85">{doneCount} / {STAGES.length}</span>
                <span className="text-bone/50 font-normal">  ·  next: {STAGES.find((s) => s.key === nextPendingKey)?.label}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-start gap-0">
        {STAGES.map((stage, i) => {
          const done = isDone(stage.key);
          const isNext = stage.key === nextPendingKey;
          const isLast = i === STAGES.length - 1;
          return (
            <div key={stage.key} className="flex-1 relative min-w-0">
              {!isLast && (
                <div
                  aria-hidden
                  className={`absolute top-3 sm:top-4 left-1/2 right-[-50%] h-0.5 ${
                    done ? 'bg-brand-primary' : 'bg-white/10'
                  }`}
                />
              )}
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => canEdit && setOpenStage(openStage === stage.key ? null : stage.key)}
                className="relative w-full flex flex-col items-center gap-1 sm:gap-1.5 group disabled:cursor-default px-0.5"
              >
                <span
                  className={`relative z-10 w-6 h-6 sm:w-8 sm:h-8 rounded-full flex items-center justify-center ring-2 transition ${
                    done
                      ? 'bg-brand-primary ring-brand-primary text-white'
                      : isNext
                        ? 'bg-charcoal-950 ring-brand-primary-soft text-brand-primary-soft'
                        : 'bg-charcoal-950 ring-white/15 text-bone/40'
                  } ${canEdit ? 'group-hover:ring-bone/60' : ''}`}
                >
                  {done ? (
                    <svg className="w-3 h-3 sm:w-4 sm:h-4" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <span className="text-[10px] sm:text-[11px] font-extrabold">{i + 1}</span>
                  )}
                </span>
                <span className={`text-[8px] sm:text-[10px] font-extrabold tracking-wider sm:tracking-widest uppercase text-center leading-tight px-0.5 ${
                  done ? 'text-bone/85' : isNext ? 'text-brand-primary-soft' : 'text-bone/50'
                }`}>
                  {stage.short}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {openStage && canEdit && (() => {
        const stage = STAGES.find((s) => s.key === openStage)!;
        const done = isDone(stage.key);
        const completedAt = toDate(progress?.[stage.key]?.completedAt);
        return (
          <div className="mt-4 rounded-xl bg-charcoal-950 ring-1 ring-white/10 p-4">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <div className="text-sm font-black text-bone">{stage.label}</div>
                <div className="text-xs text-bone/65 mt-0.5">{stage.hint}</div>
                {stage.autoNote && (
                  <div className="text-[11px] text-bone/45 mt-1 italic">{stage.autoNote}</div>
                )}
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpenStage(null)}
                className="p-1 text-bone/50 hover:text-bone -mr-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            {done && completedAt && (
              <div className="text-[11px] text-emerald-300/85 mb-3">
                Completed {completedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}.
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {done ? (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => undoDone(stage.key)}
                  className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-white/5 ring-1 ring-white/10 text-bone/80 hover:bg-white/10 disabled:opacity-50"
                >
                  {saving ? 'Undoing…' : 'Undo'}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => markDone(stage.key)}
                  className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-brand-primary text-white hover:bg-brand-primary disabled:opacity-50"
                >
                  {saving ? 'Marking…' : 'Mark complete'}
                </button>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default TeamFunnelStepper;
