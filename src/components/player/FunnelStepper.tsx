// @ts-nocheck
import React, { useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { FunnelProgress, FunnelStageKey } from '../../types';

// Horizontal recruitment-funnel stepper, six stages from a kid filling
// out tryout registration to fully cleared to play. Each stage is a
// circle with a connecting line to its neighbor. Completed stages get a
// crimson fill + checkmark; the next-pending stage is highlighted with
// a ring so the eye lands on "what's next." On mobile the row scrolls
// horizontally; on desktop it fills the available width.
//
// Reads `funnelProgress` off the Player doc. Most stages auto-write
// when the upstream event fires (phase 1+ will wire those):
//   register      — registration form submit
//   tryouts       — admin marks player attended on /club/tryouts
//   offer_sent    — admin sends the offer template
//   offer_accept  — parent taps Accept
//   club_dues     — Stripe payment confirmation
// external_league is manual-only by default (admin checkbox); the
// optional Sports Affinity webhook can flip it later.
//
// When `canEdit` is true, a coach can tap any pending stage to either
// mark it done (manual override) or, for the most recent completed
// stage, undo it. The undo path matters for mistakes — accidentally
// marking external_league complete shouldn't be a one-way door.

interface Stage {
  key: FunnelStageKey;
  short: string;     // chip label on mobile
  label: string;     // full label on desktop / inside the detail panel
  hint: string;      // 1-line description for the popover
  autoNote?: string; // if set, this stage normally auto-completes — surfaced in the popover so coaches don't fight the system
}

const STAGES: Stage[] = [
  { key: 'register',        short: 'Register',  label: 'Register',          hint: 'Tryout registration submitted by family.',          autoNote: 'Auto-completes when the family submits the registration form.' },
  { key: 'tryouts',         short: 'Tryouts',   label: 'Tryouts',           hint: 'Attended the evaluation session.',                  autoNote: 'Mark from /club/tryouts when the kid checks in.' },
  { key: 'offer_sent',      short: 'Offer',     label: 'Get offer',         hint: 'Roster spot offered to the family.',                autoNote: 'Auto-completes when you send an offer from Offer templates.' },
  { key: 'offer_accept',    short: 'Accept',    label: 'Accept offer',      hint: 'Family accepted the roster spot.',                  autoNote: 'Auto-completes when the parent taps Accept on their offer.' },
  // Manual-only by design: Sports Affinity / USYS has no public API and
  // our club uploads players to the league portal by hand. If/when the
  // league opens an API we'd swap the autoNote in and remove this one.
  { key: 'external_league', short: 'League',    label: 'League registration', hint: 'Registered with the external league (Sports Affinity / USYS).', autoNote: 'Manual-only — flip when you finish the upload in the league portal.' },
  { key: 'club_dues',       short: 'Dues',      label: 'Pay club dues',     hint: 'Season fee paid.',                                  autoNote: 'Auto-completes when the payment confirms.' },
];

interface Props {
  playerId: string;
  progress?: FunnelProgress;
  /** When true, render the stage circles as interactive — tap to open
   *  the manage popover with mark-complete / undo. */
  canEdit?: boolean;
  /** Used to attribute `by` on manual marks. Falls back to 'manual'. */
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

const FunnelStepper: React.FC<Props> = ({ playerId, progress, canEdit = false, actorUid }) => {
  const [openStage, setOpenStage] = useState<FunnelStageKey | null>(null);
  const [saving, setSaving] = useState(false);

  const isDone = (key: FunnelStageKey) => !!progress?.[key]?.completedAt;
  const doneCount = STAGES.filter((s) => isDone(s.key)).length;
  const isComplete = doneCount === STAGES.length;
  const nextPendingKey: FunnelStageKey | null = isComplete
    ? null
    : (STAGES.find((s) => !isDone(s.key))?.key ?? null);

  const markDone = async (key: FunnelStageKey) => {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, 'players', playerId), {
        [`funnelProgress.${key}`]: {
          completedAt: serverTimestamp(),
          by: actorUid || 'manual',
          meta: { manual: true },
        },
      });
      setOpenStage(null);
    } catch (err) {
      console.warn('[funnel] mark done failed', err);
    } finally {
      setSaving(false);
    }
  };

  const undoDone = async (key: FunnelStageKey) => {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      // Setting to null is the documented Firestore delete sentinel for
      // a dotted-path field. Avoids a full doc-replace round-trip.
      const { deleteField } = await import('firebase/firestore');
      await updateDoc(doc(db, 'players', playerId), {
        [`funnelProgress.${key}`]: deleteField(),
      });
      setOpenStage(null);
    } catch (err) {
      console.warn('[funnel] undo failed', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl bg-charcoal-900 ring-1 ring-white/10 p-3 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[10px] font-extrabold tracking-widest uppercase text-bone/50">
            Recruitment funnel
          </div>
          <div className="text-sm font-bold text-bone">
            {isComplete ? (
              <span className="text-emerald-300">Ready to play</span>
            ) : (
              <>
                <span className="text-bone/85">{doneCount} / {STAGES.length}</span>
                <span className="text-bone/50 font-normal">  ·  next: {STAGES.find((s) => s.key === nextPendingKey)?.label}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Stepper row. On mobile we want all six circles visible at once
          (no horizontal scroll), so labels drop to text-[8px], padding
          shrinks, and the connecting line is recalc'd from the actual
          circle width (28px) so it joins cleanly. Desktop relaxes to
          larger circles + standard tracking. */}
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

      {/* Manage popover — only renders when a coach opens a stage. We
          show the long-form hint, the auto-completion behavior, and
          either a "mark complete" or an "undo" action depending on
          current state. */}
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

export default FunnelStepper;
