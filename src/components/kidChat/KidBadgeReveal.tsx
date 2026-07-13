// @ts-nocheck
// KidBadgeReveal — the reveal moment for a newly-earned badge.
// Previously, badges landed silently (worker/client wrote the slug
// onto player.badges, kid discovered it on next Locker glance). This
// component turns the earn into a moment: big centered modal with
// the badge art, celebration copy, count-up XP, dismiss. Confetti
// particles drift up behind the art.
//
// One reveal per earn: we compare each badge.earnedAt against
// player.lastSeenBadgeAt (bumped on dismiss). If the app has been
// closed for a week and 3 badges landed while it was closed, the
// kid gets 3 stacked reveals in sequence — earliest first.
//
// Data-only listener: reads player.badges from the KidDashboard's
// existing snapshot (passed as prop). No extra Firestore query.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { Player } from '../../types';
import { badgeImageSrc, badgeSrcSet, badgeLabel, BADGE_META, badgeXp } from '../../utils/badgeMeta';

interface Props {
  player: Player | null;
}

interface QueuedBadge {
  slug: string;
  label: string;
  xp: number;
  earnedAtMs: number;
  celebration: string;
}

function toMillis(raw: any): number {
  if (!raw) return 0;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw?.toDate === 'function') { try { return raw.toDate().getTime(); } catch { return 0; } }
  if (typeof raw?.seconds === 'number') return raw.seconds * 1000;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') { const d = new Date(raw); return Number.isNaN(d.getTime()) ? 0 : d.getTime(); }
  return 0;
}

// Second-person celebration copy for the kid view. BADGE_META's
// celebration field is third-person for wall posts ("scored their
// first goal!"). Here we want to speak TO the kid.
const KID_CELEBRATION: Record<string, string> = {
  first_goal: "You scored your first goal.",
  first_assist: "You notched your first assist.",
  first_save: "You made your first save.",
  first_clean_sheet: "You kept a clean sheet.",
  first_potm: "You won your first Player of the Match.",
  perfect_attendance: "You showed up every single time.",
  streak_5: "5 days in a row. You're building it.",
  streak_10: "10 days in a row. That's a habit.",
  streak_25: "25 days in a row. Serious streak.",
  streak_50: "50 days. Legendary.",
  coach_pick: "You crossed the Coach's Pick threshold. Your coach has recognized you a lot.",
};

const KidBadgeReveal: React.FC<Props> = ({ player }) => {
  // Session floor: on first mount we don't want to flash a reveal
  // for every historical badge before lastSeenBadgeAt loads.
  const mountMsRef = useRef<number>(Date.now());
  const seenSlugsRef = useRef<Set<string>>(new Set());
  const [head, setHead] = useState<QueuedBadge | null>(null);

  // Effective cursor: the max of player.lastSeenBadgeAt and the
  // session floor. This prevents a returning kid with lastSeenBadgeAt
  // in the past from getting a reveal for badges they earned before
  // the app was reinstalled (worker doesn't guarantee earnedAt is
  // before the reinstall).
  const cursor = useMemo(() => {
    if (!player) return mountMsRef.current;
    const persisted = toMillis((player as any).lastSeenBadgeAt);
    return Math.max(persisted, mountMsRef.current);
  }, [player]);

  // Watch badges. Any badge with earnedAt > cursor and not already
  // seen this session gets queued. We only render one at a time to
  // keep the moment feeling intentional; the rest chain via dismiss.
  useEffect(() => {
    if (!player) return;
    const badges: Record<string, any> = (player as any).badges || {};
    const queue: QueuedBadge[] = [];
    for (const [slug, entry] of Object.entries(badges)) {
      if (seenSlugsRef.current.has(slug)) continue;
      const earnedAtMs = toMillis((entry as any)?.earnedAt);
      if (earnedAtMs <= cursor) {
        // Historical — mark seen so we don't re-check next tick.
        seenSlugsRef.current.add(slug);
        continue;
      }
      queue.push({
        slug,
        label: badgeLabel(slug),
        xp: badgeXp(slug),
        earnedAtMs,
        celebration: KID_CELEBRATION[slug] || 'You earned a new badge.',
      });
    }
    if (queue.length === 0) return;
    queue.sort((a, b) => a.earnedAtMs - b.earnedAtMs);
    // If we already have a reveal on screen, don't overwrite; let it
    // finish. When it dismisses we'll re-check and pick up next.
    if (head) return;
    const next = queue[0];
    seenSlugsRef.current.add(next.slug);
    setHead(next);
  }, [player, cursor, head]);

  const dismiss = async () => {
    setHead(null);
    if (!player) return;
    try {
      await updateDoc(doc(db, 'players', player.id), { lastSeenBadgeAt: serverTimestamp() });
    } catch (err) {
      console.warn('badge reveal dismiss write failed', err);
    }
  };

  if (!head) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center px-4 bg-black/70 backdrop-blur-sm"
      onClick={dismiss}
      role="dialog"
      aria-modal="true"
      aria-label={`You earned ${head.label}`}
    >
      <RevealCard event={head} onDismiss={dismiss} />
    </div>
  );
};

interface CardProps {
  event: QueuedBadge;
  onDismiss: () => void;
}

// The reveal card itself. Confetti + scale-in badge art + count-up
// XP + dismiss button. Stops click propagation so the backdrop-
// click dismiss doesn't fire from inside the card.
const RevealCard: React.FC<CardProps> = ({ event, onDismiss }) => {
  const [displayXp, setDisplayXp] = useState(0);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    // Kick the enter animation one frame after mount so the
    // transform-scale transition can play.
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!event.xp) return;
    const start = performance.now();
    const durationMs = 900;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplayXp(Math.round(event.xp * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [event.xp]);

  // 12 confetti sparkles rendered as absolutely-positioned brand-
  // colored dots that drift up + fade. Pure CSS keyframes so we
  // don't ship a library. Positions deterministic per slug so the
  // same badge earn always looks the same.
  const sparks = useMemo(() => {
    const seed = event.slug.length;
    const arr: Array<{ left: string; delay: string; tone: string }> = [];
    const tones = ['bg-brand-primary', 'bg-brand-primary-soft', 'bg-amber-400', 'bg-white/70'];
    for (let i = 0; i < 14; i++) {
      const left = ((i * 37 + seed * 11) % 100);
      const delay = (i * 60) % 700;
      const tone = tones[(i + seed) % tones.length];
      arr.push({ left: `${left}%`, delay: `${delay}ms`, tone });
    }
    return arr;
  }, [event.slug]);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={`relative w-full max-w-sm rounded-3xl bg-surface-elevated text-ink-primary ring-1 ring-brand-primary/40 shadow-[0_30px_80px_-20px_rgba(200,32,44,0.6)] overflow-hidden transition-all duration-500 ${entered ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}
    >
      {/* Crimson wash + confetti layer. Absolutely positioned so it
          sits behind the content. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 80% 55% at 50% 5%, rgba(200,32,44,0.35), transparent 65%)',
        }}
        aria-hidden
      />
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {sparks.map((s, i) => (
          <span
            key={i}
            className={`absolute top-full w-1.5 h-1.5 rounded-full ${s.tone} opacity-0 kbr-spark`}
            style={{
              left: s.left,
              animationDelay: s.delay,
            }}
          />
        ))}
      </div>

      <div className="relative px-6 pt-6 pb-4 flex flex-col items-center text-center">
        <p className="text-[10px] font-black uppercase tracking-[0.28em] text-brand-primary-soft">
          Unlocked
        </p>

        <div
          className={`mt-3 relative w-32 h-32 flex items-center justify-center transition-transform duration-700 ease-out ${entered ? 'scale-100 rotate-0' : 'scale-50 -rotate-12'}`}
          style={{ filter: 'drop-shadow(0 12px 24px rgba(200,32,44,0.45))' }}
        >
          <img
            src={badgeImageSrc(event.slug, 192)}
            srcSet={badgeSrcSet(event.slug, 128)}
            alt=""
            className="w-full h-full object-contain"
            draggable={false}
          />
        </div>

        <h2 className="mt-3 text-2xl font-black tracking-tight text-ink-primary">{event.label}</h2>
        <p className="mt-1.5 text-sm text-ink-primary/75 leading-snug">{event.celebration}</p>

        {event.xp > 0 && (
          <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-primary/15 ring-1 ring-brand-primary/40 text-brand-primary-soft text-sm font-black tabular-nums">
            +{displayXp} XP
          </div>
        )}
      </div>

      <div className="relative px-4 pb-5 pt-2">
        <button
          type="button"
          onClick={onDismiss}
          className="w-full px-4 py-3 rounded-full bg-brand-primary text-white font-black text-sm shadow-lg hover:brightness-110 active:scale-[0.98] transition"
        >
          Awesome
        </button>
      </div>

      <style>{`
        @keyframes kbr-spark-up {
          0%   { transform: translateY(0) scale(0.6); opacity: 0; }
          20%  { opacity: 1; }
          100% { transform: translateY(-320px) scale(1); opacity: 0; }
        }
        .kbr-spark {
          animation: kbr-spark-up 1500ms ease-out forwards;
        }
      `}</style>
    </div>
  );
};

export default KidBadgeReveal;
