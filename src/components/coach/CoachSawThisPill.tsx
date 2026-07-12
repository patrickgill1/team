// CoachSawThisPill — per-log-entry coach acknowledgement affordance.
//
// Three visual states:
//   1. Already verified: read-only brand-primary chip with a check
//      glyph + coach name + relative time. Renders for everyone
//      (kids/parents/coaches).
//   2. Not verified + viewer is coach on this team: interactive
//      "Saw this" button that fires onVerify.
//   3. Not verified + viewer is not a coach: renders nothing (silent
//      empty per atomic-render).
//
// No emojis. No em dashes. Coach signal = brand-primary crimson,
// matching the goal-verified glyph pattern already used elsewhere.

import React, { useState } from 'react';
import type { PracticeLogEntry } from '../../types';
import { relativeTime, toMillis } from '../../utils/timestamps';

interface Props {
  entry: PracticeLogEntry;
  canVerify: boolean;
  onVerify: () => Promise<void>;
}

const CheckGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M5 12l5 5L20 7" />
  </svg>
);

const CoachSawThisPill: React.FC<Props> = ({ entry, canVerify, onVerify }) => {
  const [busy, setBusy] = useState(false);

  if (entry.verifiedBy) {
    const when = relativeTime(toMillis(entry.verifiedBy.at));
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-primary/12 ring-1 ring-brand-primary/35 px-2 py-0.5 text-[11px] font-black text-brand-primary-soft">
        <CheckGlyph className="w-3 h-3" />
        <span>Coach {entry.verifiedBy.name} saw this</span>
        {when && <span className="font-normal text-brand-primary-soft/65">{when}</span>}
      </div>
    );
  }

  if (!canVerify) return null;

  const handle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onVerify();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy}
      className="inline-flex items-center gap-1 rounded-full ring-1 ring-brand-primary/40 hover:bg-brand-primary/10 active:bg-brand-primary/15 px-2 py-0.5 text-[11px] font-black text-brand-primary-soft transition disabled:opacity-50"
      aria-label="Acknowledge this practice log entry"
    >
      <CheckGlyph className="w-3 h-3" />
      <span>{busy ? 'Saving...' : 'Saw this'}</span>
    </button>
  );
};

export default CoachSawThisPill;
