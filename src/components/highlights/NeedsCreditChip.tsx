// Coach-only chip banner shown above the main clip grid when there
// are untagged videos in the curation queue. One line, subtle amber.
// Tap filters the grid to those clips so the coach can knock them
// out inline instead of hunting for a separate "review" screen.

import React from 'react';

interface Props {
  count: number;
  active?: boolean;
  onTap: () => void;
}

const NeedsCreditChip: React.FC<Props> = ({ count, active = false, onTap }) => {
  if (count <= 0) return null;
  const label = active
    ? `Showing ${count} clip${count === 1 ? '' : 's'} that need credit`
    : `${count} clip${count === 1 ? '' : 's'} need credit`;
  return (
    <button
      type="button"
      onClick={onTap}
      className={`w-full inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-bold text-left transition
        ${active
          ? 'bg-amber-500/20 ring-1 ring-amber-400/50 text-amber-100'
          : 'bg-amber-500/10 ring-1 ring-amber-400/30 text-amber-200 hover:bg-amber-500/15'}
      `}
      aria-pressed={active}
    >
      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5" />
        <circle cx="12" cy="16.5" r="0.9" fill="currentColor" />
      </svg>
      <span className="flex-1 truncate">{label}</span>
      {active ? (
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="9 6 15 12 9 18" />
        </svg>
      )}
    </button>
  );
};

export default NeedsCreditChip;
