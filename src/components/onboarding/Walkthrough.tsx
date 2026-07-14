// @ts-nocheck
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui';

/**
 * First-launch walkthrough. Role-specific slides that show — not tell —
 * the first successful path. Shown once per role/device via localStorage
 * key prefix `gk_walkthrough_seen_v3__`. Skippable from any slide.
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
 * Storage key bumped to v3 if you reorder slides — that re-shows the
 * tour for everyone, useful when you ship a meaningful new feature.
 */

const SEEN_KEY_PREFIX = 'gk_walkthrough_seen_v3__';
type WalkthroughRole = 'coach' | 'parent' | 'admin';

interface Slide {
  kicker: string;
  title: string;
  body: string;
  /** Inline SVG icon node (monoline). */
  icon: React.ReactNode;
}

const commonWelcome: Slide =
  {
    kicker: 'Welcome',
    title: 'GoalKickr starts with your role.',
    body: "Coaches, parents, and club admins each get a different first path. Four quick screens, then you're in.",
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <path d="M32 8 L52 18 L52 38 C52 48 42 56 32 58 C22 56 12 48 12 38 L12 18 Z" />
        <polyline points="22 32 30 40 44 24" />
      </svg>
    ),
  };

const roleSlides: Record<WalkthroughRole, Slide[]> = {
  coach: [
  commonWelcome,
  {
    kicker: 'Coach setup',
    title: 'Build the squad once.',
    body: 'Add each player with a contact email — GoalKickr turns that roster into invites, RSVPs, team chat, and attendance.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <circle cx="20" cy="22" r="6" />
        <circle cx="44" cy="22" r="6" />
        <path d="M10 48 C12 38 18 34 28 36" />
        <path d="M54 48 C52 38 46 34 36 36" />
        <path d="M22 44 H42" />
      </svg>
    ),
  },
  {
    kicker: 'Coach week',
    title: 'Run the next practice or game.',
    body: 'The Dugout points you to the next event, missing RSVPs, messages, and the lineup tools you need before kickoff.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <rect x="10" y="12" width="44" height="40" rx="6" />
        <path d="M20 24 H44" />
        <path d="M20 34 H36" />
        <path d="M20 44 H30" />
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
  ],
  parent: [
  commonWelcome,
  {
    kicker: 'Parent home',
    title: 'See what matters next.',
    body: 'Your dashboard is built around the next event, your player, team announcements, and anything that needs a reply.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <path d="M12 30 L32 12 L52 30" />
        <path d="M18 28 V52 H46 V28" />
        <path d="M26 52 V38 H38 V52" />
      </svg>
    ),
  },
  {
    kicker: 'RSVPs',
    title: 'Answer for your player.',
    body: "Tap Going, Maybe, or Can't go from the event card. Coaches see player attendance instead of guessing from group texts.",
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <rect x="12" y="10" width="40" height="44" rx="6" />
        <path d="M22 26 L29 33 L43 19" />
        <path d="M22 44 H42" />
      </svg>
    ),
  },
  {
    kicker: 'Player view',
    title: 'Follow progress without extra work.',
    body: 'Practice streaks, dev plans, awards, and highlights stay connected to your player so the good stuff is easy to find.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <polyline points="8 48 22 32 32 40 46 22 56 28" />
        <circle cx="22" cy="32" r="3" fill="currentColor" />
        <circle cx="32" cy="40" r="3" fill="currentColor" />
        <circle cx="46" cy="22" r="3" fill="currentColor" />
      </svg>
    ),
  },
  ],
  admin: [
  commonWelcome,
  {
    kicker: 'Club hub',
    title: 'See the club from one place.',
    body: 'Registrations, payments, teams, forms, branding, and admin tasks sit together so the club work has a real home.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <path d="M12 24 L32 12 L52 24" />
        <path d="M16 24 V52 H48 V24" />
        <path d="M24 52 V34 H40 V52" />
      </svg>
    ),
  },
  {
    kicker: 'Season launch',
    title: 'Turn admin setup into a checklist.',
    body: 'Create teams, attach forms, set products, invite coaches, and track which families still need attention.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <rect x="14" y="10" width="36" height="44" rx="5" />
        <path d="M24 24 H42" />
        <path d="M24 34 H42" />
        <path d="M24 44 H34" />
        <path d="M18 24 L20 26 L23 22" />
        <path d="M18 34 L20 36 L23 32" />
      </svg>
    ),
  },
  {
    kicker: 'Needs attention',
    title: 'Know what is stuck.',
    body: 'Use the club dashboard to find unpaid registrations, missing forms, pending offers, and teams that need cleanup.',
    icon: (
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-16 h-16 text-brand-primary">
        <circle cx="32" cy="32" r="22" />
        <path d="M32 18 V34" />
        <path d="M32 44 H32.01" />
      </svg>
    ),
  },
  ],
};

function slidesFor(role: WalkthroughRole): Slide[] {
  return roleSlides[role] || roleSlides.parent;
}

function seenKey(role: WalkthroughRole): string {
  return `${SEEN_KEY_PREFIX}${role}`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  role?: WalkthroughRole;
}

const Walkthrough: React.FC<Props> = ({ open, onClose, role = 'parent' }) => {
  const [index, setIndex] = useState(0);
  const startXRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const slides = slidesFor(role);

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
      else if (e.key === 'ArrowRight') setIndex(i => Math.min(slides.length - 1, i + 1));
      else if (e.key === 'ArrowLeft')  setIndex(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const handleDone = () => {
    try { localStorage.setItem(seenKey(role), '1'); } catch { /* ignore */ }
    onClose();
  };

  // Swipe handlers — minimal, threshold 50px
  const onTouchStart = (e: React.TouchEvent) => { startXRef.current = e.touches[0].clientX; };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = startXRef.current;
    if (start == null) return;
    const dx = e.changedTouches[0].clientX - start;
    if (Math.abs(dx) < 50) return;
    if (dx < 0) setIndex(i => Math.min(slides.length - 1, i + 1));
    else setIndex(i => Math.max(0, i - 1));
    startXRef.current = null;
  };

  const slide = slides[index] || slides[0];
  const isLast = index === slides.length - 1;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] bg-surface-base flex flex-col animate-fade-in"
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Skip — top right */}
      <div className="flex items-center justify-end px-5 pt-[calc(env(safe-area-inset-top)+12px)] pb-2">
        <button
          type="button"
          onClick={handleDone}
          className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/55 hover:text-ink-primary px-3 py-2"
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
        <h2 className="text-3xl sm:text-4xl font-black text-ink-primary leading-tight max-w-md">
          {slide.title}
        </h2>
        <p className="text-ink-primary/65 text-base sm:text-lg mt-4 max-w-md leading-relaxed">
          {slide.body}
        </p>
      </div>

      {/* Dots + nav */}
      <div className="px-6 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-4 space-y-5">
        <div className="flex items-center justify-center gap-2">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Slide ${i + 1}`}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? 'w-6 bg-brand-primary' : 'w-1.5 bg-line-default/20'
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
export function shouldShowWalkthrough(role: WalkthroughRole = 'parent'): boolean {
  try { return localStorage.getItem(seenKey(role)) !== '1'; }
  catch { return false; }
}

export default Walkthrough;
