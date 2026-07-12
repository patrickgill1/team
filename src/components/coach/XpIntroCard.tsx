// @ts-nocheck
// XpIntroCard — one-tap discovery for the XP + Badges system.
//
// Problem: coaches on teams created before 2026-07-10 (when the XP
// system shipped) have team.xpConfig undefined, so every XP surface
// is silent — including the Grant XP tile Patrick added to the
// cockpit. A coach who's never opened Team Settings and flipped the
// toggle will never discover the feature.
//
// Fix (v1): a compact nudge card on CoachCockpit that renders only
// when team.xpConfig?.enabled !== true AND the coach hasn't
// dismissed it on this device (localStorage key per team).
//
// Fix (v2, 2026-07-12): "Turn on" now opens the retro-XP
// BackfillConfirmModal instead of writing xpConfig directly.
// Two reasons:
//   1. The direct-write violated the worker-writes rule
//      (feedback_onboarding_writes_are_worker).
//   2. Flipping XP on for a team with existing history silently
//      loses credit for every pre-existing achievement. The
//      confirm modal shows exactly what will be granted so the
//      coach can make an informed choice, with a "Turn on without
//      retro credit" escape hatch inside the modal.

import React, { useState } from 'react';
import type { Team } from '../../types';
import BackfillConfirmModal from './BackfillConfirmModal';

interface Props {
  team: Team;
  onEnabled?: () => void;
}

const dismissKey = (teamId: string) => `gk.xpIntro.dismissed.${teamId}`;

function isDismissed(teamId: string): boolean {
  try { return localStorage.getItem(dismissKey(teamId)) === '1'; } catch { return false; }
}

function stampDismissed(teamId: string): void {
  try { localStorage.setItem(dismissKey(teamId), '1'); } catch { /* ignore */ }
}

const XpIntroCard: React.FC<Props> = ({ team, onEnabled }) => {
  const [dismissed, setDismissed] = useState<boolean>(() => isDismissed(team.id));
  const [modalOpen, setModalOpen] = useState(false);

  if ((team as any)?.xpConfig?.enabled === true) return null;
  if (dismissed) return null;

  const openPreview = () => setModalOpen(true);
  const dismiss = () => {
    stampDismissed(team.id);
    setDismissed(true);
  };

  return (
    <>
      <div className="relative rounded-2xl bg-gradient-to-br from-brand-primary/25 via-brand-primary/12 to-transparent ring-1 ring-brand-primary/40 p-4 overflow-hidden">
        {/* Subtle hex XP glyph as background art */}
        <svg
          className="absolute -right-6 -bottom-6 w-40 h-40 text-brand-primary/10 pointer-events-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 2l8.66 5v10L12 22 3.34 17V7L12 2z" />
        </svg>

        <div className="relative flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-brand-primary-soft">
              New: XP + Badges
            </p>
            <h3 className="mt-1 text-base font-black tracking-tight text-ink-primary">
              Give your kids something to chase.
            </h3>
            <p className="mt-1.5 text-[13px] text-ink-primary/70 leading-snug">
              Kids earn XP for streaks, POTMs, and your live grants. Cards level up. Badges unlock. Preview what your players will earn from their history, then turn XP on.
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="shrink-0 p-1.5 rounded-full text-ink-primary/50 hover:text-ink-primary hover:bg-line-default/10 transition"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5" aria-hidden>
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="relative mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={openPreview}
            className="flex-1 px-4 py-2 rounded-full bg-brand-primary text-white font-black text-sm shadow-md hover:brightness-110 active:scale-[0.98] transition"
          >
            Preview retro credit
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="px-4 py-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/70 font-semibold text-sm hover:bg-line-default/15 transition"
          >
            Not now
          </button>
        </div>
      </div>

      <BackfillConfirmModal
        teamId={team.id}
        isOpen={modalOpen}
        triggerSource="first_enable"
        onClose={() => setModalOpen(false)}
        onCommitted={() => { onEnabled?.(); }}
      />
    </>
  );
};

export default XpIntroCard;
