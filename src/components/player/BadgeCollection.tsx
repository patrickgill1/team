import React from 'react';
import type { Player } from '../../types';
import { badgeImageSrc, badgeSrcSet, badgeLabel } from '../../utils/badgeMeta';
import ProfileCard from './ProfileCard';

// BadgeCollection — Story-tab preview strip of the most-recent
// badges a player has earned, with a "See all N" affordance that
// jumps to the full Locker grid inside PlayerXpCard on the Stats
// tab.
//
// Hidden entirely when the player has zero badges (avoids
// Swiss-cheese scroll on brand-new profiles). PlayerXpCard already
// renders the empty locker slots on the Stats tab.
//
// Reuses badgeMeta helpers (badgeImageSrc, badgeSrcSet, badgeLabel)
// so the visual matches the Stats-tab Locker exactly.
//
// See project_xp_badges memory for phase-1 badge treatment.

interface Props {
  player: Player;
  /** Callback invoked when the user taps a badge tile OR the
   *  "See all" link. Parent switches to Stats tab and scrolls to
   *  the PlayerXpCard Locker section. */
  onSeeAll: () => void;
  /** Max tiles rendered in the preview strip. Default 6 (fits the
   *  6-col mobile grid). */
  limit?: number;
}

interface OwnedBadge {
  slug: string;
  earnedAt: Date;
  count: number;
  context?: string;
}

const BadgeCollection: React.FC<Props> = ({ player, onSeeAll, limit = 6 }) => {
  const badges: Record<string, any> = ((player as any).badges && typeof (player as any).badges === 'object')
    ? (player as any).badges
    : {};

  // Normalize + sort most-recent first. earnedAt can be a Firestore
  // Timestamp OR a Date OR an ISO string depending on load path —
  // defensively coerce.
  const owned: OwnedBadge[] = Object.entries(badges)
    .map(([slug, meta]: [string, any]) => {
      const raw = meta?.earnedAt;
      let earnedAt: Date;
      if (raw?.toDate) earnedAt = raw.toDate();
      else if (raw instanceof Date) earnedAt = raw;
      else if (typeof raw === 'string' || typeof raw === 'number') earnedAt = new Date(raw);
      else earnedAt = new Date(0);
      return {
        slug,
        earnedAt,
        count: typeof meta?.count === 'number' ? meta.count : 0,
        context: meta?.context,
      };
    })
    .sort((a, b) => b.earnedAt.getTime() - a.earnedAt.getTime());

  if (owned.length === 0) return null;

  const shown = owned.slice(0, limit);
  const remaining = owned.length - shown.length;
  const totalLabel = owned.length === 1 ? '1 badge' : `${owned.length} badges`;

  return (
    <ProfileCard
      eyebrow="Badges"
      title={totalLabel}
      action={owned.length > limit ? (
        <button
          type="button"
          onClick={onSeeAll}
          className="inline-flex items-center gap-0.5 text-xs font-black uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary transition-colors"
        >
          See all {owned.length}
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={onSeeAll}
          className="inline-flex items-center gap-0.5 text-xs font-black uppercase tracking-widest text-brand-primary-soft hover:text-brand-primary transition-colors"
        >
          Locker
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
      )}
    >
      <div className="grid grid-cols-6 gap-2 sm:gap-2.5">
        {shown.map(b => {
          const label = badgeLabel(b.slug);
          const src = badgeImageSrc(b.slug, 128);
          const srcSet = badgeSrcSet(b.slug, 56);
          const displayCount = b.slug === 'coach_pick' && b.count > 1 ? b.count : 0;
          return (
            <button
              key={b.slug}
              type="button"
              onClick={onSeeAll}
              title={b.context || label}
              aria-label={b.context ? `${label} — ${b.context}` : label}
              className="group flex flex-col items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/50 rounded-lg"
            >
              <div className="relative w-full aspect-square rounded-lg flex items-center justify-center bg-brand-primary/10 ring-1 ring-brand-primary/40 shadow-[inset_0_0_12px_rgba(200,32,44,0.15)] group-hover:ring-brand-primary/60 transition">
                <img
                  src={src}
                  srcSet={srcSet}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="w-[78%] h-[78%] object-contain"
                />
                {displayCount > 1 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-primary text-white text-[9px] font-black leading-none flex items-center justify-center ring-2 ring-surface-elevated tabular-nums">
                    {displayCount}
                  </span>
                )}
              </div>
              <span className="text-[10px] font-bold text-ink-primary/70 leading-tight text-center line-clamp-2">
                {label}
              </span>
            </button>
          );
        })}
      </div>
      {remaining > 0 && (
        <p className="text-[11px] text-ink-primary/50 leading-snug">
          +{remaining} more in the full locker.
        </p>
      )}
    </ProfileCard>
  );
};

export default BadgeCollection;
