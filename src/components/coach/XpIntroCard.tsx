// @ts-nocheck
// XpIntroCard — one-tap discovery for the XP + Badges system.
//
// Problem: coaches on teams created before 2026-07-10 (when the XP
// system shipped) have team.xpConfig undefined, so every XP surface
// is silent — including the Grant XP tile Patrick added to the
// cockpit. A coach who's never opened Team Settings and flipped the
// toggle will never discover the feature.
//
// Fix: a compact nudge card on CoachCockpit that renders only when
// team.xpConfig?.enabled !== true AND the coach hasn't dismissed it
// on this device (localStorage key per team). Two buttons: "Turn on"
// commits xpConfig.enabled=true + enabledAt=now via the same direct
// write TeamManagement uses; "Not now" bumps the localStorage
// dismissal so it doesn't reappear on this device.

import React, { useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { Team } from '../../types';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if ((team as any)?.xpConfig?.enabled === true) return null;
  if (dismissed) return null;

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'teams', team.id), {
        xpConfig: {
          enabled: true,
          enabledAt: new Date(),
        },
      });
      onEnabled?.();
    } catch (err: any) {
      console.error('[xp-intro] enable failed', err);
      setError('Could not turn on XP. Try again.');
      setBusy(false);
    }
  };

  const dismiss = () => {
    stampDismissed(team.id);
    setDismissed(true);
  };

  return (
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
            New · XP + Badges
          </p>
          <h3 className="mt-1 text-base font-black tracking-tight text-ink-primary">
            Give your kids something to chase.
          </h3>
          <p className="mt-1.5 text-[13px] text-ink-primary/70 leading-snug">
            Kids earn XP for streaks, POTMs, and your live grants. Cards level up. Badges unlock. All private, all opt-in.
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

      {error && (
        <p className="relative mt-2 text-[12px] text-amber-100">{error}</p>
      )}

      <div className="relative mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={enable}
          disabled={busy}
          className="flex-1 px-4 py-2 rounded-full bg-brand-primary text-white font-black text-sm shadow-md hover:brightness-110 active:scale-[0.98] transition disabled:opacity-50"
        >
          {busy ? 'Turning on...' : 'Turn on'}
        </button>
        <button
          type="button"
          onClick={dismiss}
          disabled={busy}
          className="px-4 py-2 rounded-full bg-line-default/10 ring-1 ring-line-default/20 text-ink-primary/70 font-semibold text-sm hover:bg-line-default/15 transition disabled:opacity-50"
        >
          Not now
        </button>
      </div>
    </div>
  );
};

export default XpIntroCard;
