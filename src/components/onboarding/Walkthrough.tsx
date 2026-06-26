// @ts-nocheck
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui';

/**
 * First-launch walkthrough. Five tight slides that show — not tell —
 * the core value props. Shown once per device via localStorage flag
 * `gk_walkthrough_seen_v2`. Skippable from any slide.
 *
 * Patrick's pain point that triggered this: 'when i tell people all
 * of the features, there are so many good ones, I find it hard to
 * communicate to someone before I feel like I am talking too much.'
 * The walkthrough does the showing so he doesn't have to.
 *
 * Pattern: full-screen overlay, horizontal-paginated slides, dots +
 * Skip + Next/Done. Uses brand-color tokens so it re-tints per club.
 * No emojis (per memory: feedback_no_emojis).
 *
 * Storage key bumped to v2 if you reorder slides — that re-shows the
 * tour for everyone, useful when you ship a meaningful new feature.
 */

const SEEN_KEY = 'gk_walkthrough_seen_v2';

interface Slide {
  kicker: string;
  title: string;
  body: string;
  /** Inline SVG icon node (monoline). */
  icon: React.ReactNode;
}

const SLIDES: Slide[] = [
  {
    kicker: 'Welcome',
    title: 'Built by a coach who codes.',
    body: "GoalKickr is the team app I wished existed when I was running my own youth team. Five quick screens, then you're in.",
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <path d="M32 8 L52 18 L52 38 C52 48 42 56 32 58 C22 56 12 48 12 38 L12 18 Z" />
        <polyline points="22 32 30 40 44 24" />
      </svg>
    ),
  },
  {
    kicker: 'Team chat',
    title: 'Everyone in one thread.',
    body: 'Parents, players, coaches. Send a message once. Track who RSVP\'d to Thursday practice without a single group text.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <path d="M8 14 H50 A6 6 0 0 1 56 20 V40 A6 6 0 0 1 50 46 H24 L14 56 V46 H8 A6 6 0 0 1 2 40 V20 A6 6 0 0 1 8 14 Z" />
        <line x1="14" y1="24" x2="44" y2="24" />
        <line x1="14" y1="32" x2="38" y2="32" />
      </svg>
    ),
  },
  {
    kicker: 'Development',
    title: 'Build the player, not just the team.',
    body: 'Practice streaks, dev plans, parent whispers, POTM awards. The stuff that turns five-day-a-week kids into seven-day-a-week kids.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <polyline points="8 48 22 32 32 40 46 22 56 28" />
        <circle cx="22" cy="32" r="3" fill="currentColor" />
        <circle cx="32" cy="40" r="3" fill="currentColor" />
        <circle cx="46" cy="22" r="3" fill="currentColor" />
      </svg>
    ),
  },
  {
    kicker: 'Game day',
    title: 'Subs, minutes, halftime — automatic.',
    body: 'A shift bell tells you when to rotate. The board tracks who\'s on and who\'s rested. You coach the game, not the clipboard.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <circle cx="32" cy="32" r="22" />
        <polyline points="32 18 32 32 42 38" />
      </svg>
    ),
  },
  {
    kicker: 'Free for families',
    title: "Coaches pay. Families don't.",
    body: 'Every parent, every player, free. Forever. The coach picks a tier when they\'re ready; the team uses GoalKickr from day one.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <path d="M48 26 C48 36 40 46 32 50 C24 46 16 36 16 26 C16 20 20 16 26 16 C29 16 31 18 32 20 C33 18 35 16 38 16 C44 16 48 20 48 26 Z" />
      </svg>
    ),
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

const Walkthrough: React.FC<Props> = ({ open, onClose }) => {
  const [index, setIndex] = useState(0);
  const startXRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Lock body scroll while open
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Reset to first slide every open
  useEffect(() => { if (open) setIndex(0); }, [open]);

  // ESC dismisses
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleDone();
      else if (e.key === 'ArrowRight') setIndex(i => Math.min(SLIDES.length - 1, i + 1));
      else if (e.key === 'ArrowLeft')  setIndex(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const handleDone = () => {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
    onClose();
  };

  // Swipe handlers — minimal, threshold 50px
  const onTouchStart = (e: React.TouchEvent) => { startXRef.current = e.touches[0].clientX; };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = startXRef.current;
    if (start == null) return;
    const dx = e.changedTouches[0].clientX - start;
    if (Math.abs(dx) < 50) return;
    if (dx < 0) setIndex(i => Math.min(SLIDES.length - 1, i + 1));
    else setIndex(i => Math.max(0, i - 1));
    startXRef.current = null;
  };

  const slide = SLIDES[index];
  const isLast = index === SLIDES.length - 1;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] bg-charcoal-950 flex flex-col animate-fade-in"
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Skip — top right */}
      <div className="flex items-center justify-end px-5 pt-[calc(env(safe-area-inset-top)+12px)] pb-2">
        <button
          type="button"
          onClick={handleDone}
          className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 hover:text-bone px-3 py-2"
        >
          Skip
        </button>
      </div>

      {/* Slide content */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        <div className="mb-6 animate-fade-in" key={`icon-${index}`}>{slide.icon}</div>
        <p className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-2">
          {slide.kicker}
        </p>
        <h2 className="text-3xl sm:text-4xl font-black text-bone leading-tight max-w-md">
          {slide.title}
        </h2>
        <p className="text-bone/65 text-base sm:text-lg mt-4 max-w-md leading-relaxed">
          {slide.body}
        </p>
      </div>

      {/* Dots + nav */}
      <div className="px-6 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-4 space-y-5">
        <div className="flex items-center justify-center gap-2">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Slide ${i + 1}`}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? 'w-6 bg-brand-primary' : 'w-1.5 bg-white/20'
              }`}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          {index > 0 ? (
            <Button variant="ghost" onClick={() => setIndex(i => i - 1)} fullWidth>
              Back
            </Button>
          ) : <div className="flex-1" />}
          <Button
            variant="primary"
            onClick={() => isLast ? handleDone() : setIndex(i => i + 1)}
            fullWidth
          >
            {isLast ? "Let's go" : 'Next'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

/** True if the user hasn't seen the latest walkthrough yet. */
export function shouldShowWalkthrough(): boolean {
  try { return localStorage.getItem(SEEN_KEY) !== '1'; }
  catch { return false; }
}

export default Walkthrough;
