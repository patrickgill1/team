// @ts-nocheck
// DashboardDigestSheet — bottom sheet that opens when the busy-parent
// digest strip in the hero is tapped. Lists every unread/pending
// signal grouped by category with a count and a deep-link. Uses the
// shared Sheet primitive so dismiss (backdrop, ESC, swipe) is
// consistent with every other modal.
//
// Silent-empty rule: the whole sheet only renders when at least one
// category has count > 0. Categories with count === 0 do NOT get a
// row — no "0 unread messages" filler that dilutes the "here's what
// needs you" mental model.

import React from 'react';
import { Link } from 'react-router-dom';
import { Sheet } from '../ui';

export interface DigestItem {
  key: 'chat' | 'wall' | 'events' | 'rsvp' | 'highlights';
  label: string;
  detail?: string;
  count: number;
  href: string;
  tone: 'brand' | 'amber' | 'sky' | 'emerald' | 'violet';
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: DigestItem[];
}

const TONE_STYLES: Record<DigestItem['tone'], { bg: string; text: string; ring: string }> = {
  brand:   { bg: 'bg-brand-primary/15',   text: 'text-brand-primary-soft', ring: 'ring-brand-primary/25' },
  amber:   { bg: 'bg-amber-500/15',       text: 'text-amber-300',          ring: 'ring-amber-400/25' },
  sky:     { bg: 'bg-sky-500/15',         text: 'text-sky-300',            ring: 'ring-sky-400/25' },
  emerald: { bg: 'bg-emerald-500/15',     text: 'text-emerald-300',        ring: 'ring-emerald-400/25' },
  violet:  { bg: 'bg-violet-500/15',      text: 'text-violet-300',         ring: 'ring-violet-400/25' },
};

const ICONS: Record<DigestItem['key'], React.ReactNode> = {
  chat: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  wall: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M3 11v2a1 1 0 001 1h3l4 4V6L7 10H4a1 1 0 00-1 1z" />
      <path d="M15 8a5 5 0 010 8" />
    </svg>
  ),
  events: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  ),
  rsvp: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  highlights: (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2l2.39 4.84L19.8 7.6l-3.9 3.8.92 5.36L12 14.27 7.18 16.76 8.1 11.4 4.2 7.6l5.41-.76L12 2z" />
    </svg>
  ),
};

const DashboardDigestSheet: React.FC<Props> = ({ open, onClose, items }) => {
  const active = items.filter(i => i.count > 0);
  const total = active.reduce((sum, i) => sum + i.count, 0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      kicker="Since you last checked"
      title={total === 1 ? '1 thing needs you' : `${total} things need you`}
      subtitle="Tap any row to jump straight there."
    >
      <ul className="divide-y divide-line-default/10 -mx-1">
        {active.map(item => {
          const tone = TONE_STYLES[item.tone];
          return (
            <li key={item.key}>
              <Link
                to={item.href}
                onClick={onClose}
                className="flex items-center gap-3 px-3 py-3.5 rounded-xl hover:bg-line-default/[0.05] transition"
              >
                <span
                  className={`shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-xl ring-1 ${tone.bg} ${tone.text} ${tone.ring}`}
                >
                  {ICONS[item.key]}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-ink-primary leading-tight">
                    <span className="tabular-nums">{item.count}</span> {item.label}
                  </p>
                  {item.detail && (
                    <p className="text-[11px] text-ink-primary/55 leading-snug truncate mt-0.5">{item.detail}</p>
                  )}
                </div>
                <svg className={`shrink-0 w-4 h-4 ${tone.text}`} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </Link>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
};

export default DashboardDigestSheet;
