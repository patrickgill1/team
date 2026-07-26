// Right-aligned sort dropdown above the main clip grid on the
// Highlights tab. Chrome-light: renders as "Sort: <Label> v" pill;
// tap opens a small menu with the four sort options. Keeps the grid
// header visually quiet so the clips themselves stay the focus.

import React, { useEffect, useRef, useState } from 'react';

export type SortKey = 'recent' | 'liked' | 'viewed' | 'downloaded';

interface Option {
  key: SortKey;
  label: string;
}

const OPTIONS: Option[] = [
  { key: 'recent',     label: 'Recent' },
  { key: 'liked',      label: 'Most Liked' },
  { key: 'viewed',     label: 'Most Viewed' },
  { key: 'downloaded', label: 'Most Downloaded' },
];

interface Props {
  value: SortKey;
  onChange: (next: SortKey) => void;
}

const SortPill: React.FC<Props> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Click-away close. Effect always mounted; conditional inside so
  // hooks-before-returns stays clean.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  const current = OPTIONS.find(o => o.key === value) || OPTIONS[0];

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-surface-elevated text-ink-primary ring-1 ring-line-default/20 hover:bg-line-default/10 focus:outline-none focus:ring-2 focus:ring-brand-primary/60"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="text-ink-secondary font-medium">Sort:</span>
        <span>{current.label}</span>
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full mt-1.5 min-w-[180px] rounded-xl bg-surface-elevated ring-1 ring-line-default/20 shadow-lg overflow-hidden z-20"
        >
          {OPTIONS.map(opt => {
            const active = opt.key === value;
            return (
              <button
                key={opt.key}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onChange(opt.key); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm ${active ? 'bg-brand-primary/10 text-ink-primary font-bold' : 'text-ink-primary hover:bg-line-default/10'}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default SortPill;
