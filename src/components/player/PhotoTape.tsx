import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { where } from 'firebase/firestore';
import { useFirestore } from '../../hooks/useFirestore';
import { debugWarn } from '../../utils/debug';
import { toMillis } from '../../utils/timestamps';

export interface Props {
  playerId: string;
  teamId: string;
  playerName: string;
}

type PhotoSource = 'gallery' | 'player_media';

interface RibbonItem {
  id: string;
  url: string;
  thumbnailUrl?: string;
  caption?: string;
  createdAtMs: number;
  source: PhotoSource;
}

const CameraGlyph: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M3 8a2 2 0 012-2h2.5l1.5-2h6l1.5 2H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"
    />
    <circle cx="12" cy="13" r="3.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Horizontal-scroll ribbon of every photo this player is tagged in.
// First horizontal-scroll ribbon in the app; the class combo below is
// the locked pattern that SeasonTimeline should reuse.
const PhotoTape: React.FC<Props> = ({ playerId, playerName }) => {
  const { getPlayerMediaByPlayer, getPhotosByPlayer, getDocuments } = useFirestore();

  const [items, setItems] = useState<RibbonItem[] | null>(null);
  const [failedIds, setFailedIds] = useState<Set<string>>(() => new Set());
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);

    (async () => {
      try {
        const galleryPromise = getPhotosByPlayer(playerId);
        const mediaOwnedPromise = getPlayerMediaByPlayer(playerId);
        const mediaTaggedPromise = getDocuments('player_media', [
          where('taggedPlayerIds', 'array-contains', playerId),
        ]);

        const [galleryRaw, mediaOwnedRaw, mediaTaggedRaw] = await Promise.all([
          galleryPromise,
          mediaOwnedPromise,
          mediaTaggedPromise,
        ]);

        if (cancelled) return;

        const normalized: RibbonItem[] = [];
        const seen = new Set<string>();

        const pushGallery = (d: any) => {
          if (!d || !d.id || seen.has(d.id)) return;
          if (d.isActive === false) return;
          if (!d.url) return;
          seen.add(d.id);
          normalized.push({
            id: d.id,
            url: d.url,
            thumbnailUrl: d.thumbnailUrl,
            caption: d.caption,
            createdAtMs: toMillis(d.createdAt),
            source: 'gallery',
          });
        };

        const pushMedia = (d: any) => {
          if (!d || !d.id || seen.has(d.id)) return;
          if (d.isActive === false) return;
          if (d.type && d.type !== 'photo') return;
          if (!d.url) return;
          seen.add(d.id);
          normalized.push({
            id: d.id,
            url: d.url,
            thumbnailUrl: d.thumbnailUrl,
            caption: d.caption,
            createdAtMs: toMillis(d.createdAt),
            source: 'player_media',
          });
        };

        (galleryRaw as any[]).forEach(pushGallery);
        (mediaOwnedRaw as any[]).forEach(pushMedia);
        (mediaTaggedRaw as any[]).forEach(pushMedia);

        normalized.sort((a, b) => b.createdAtMs - a.createdAtMs);

        setItems(normalized);
      } catch (err) {
        if (cancelled) return;
        debugWarn('[photo-tape] load failed', err);
        setItems([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [playerId, getDocuments, getPlayerMediaByPlayer]);

  const handleImgError = useCallback((id: string) => {
    setFailedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const closeLightbox = useCallback(() => setActiveIdx(null), []);
  const goPrev = useCallback(() => {
    setActiveIdx((i) => (i == null ? i : Math.max(0, i - 1)));
  }, []);
  const goNext = useCallback(() => {
    setActiveIdx((i) => {
      if (i == null || !items) return i;
      return Math.min(items.length - 1, i + 1);
    });
  }, [items]);

  useEffect(() => {
    if (activeIdx == null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeIdx, closeLightbox, goNext, goPrev]);

  const active = useMemo(() => {
    if (activeIdx == null || !items) return null;
    return items[activeIdx] || null;
  }, [activeIdx, items]);

  if (items === null) return null;
  if (items.length === 0) return null;

  return (
    <>
      <section
        aria-label={`${playerName}'s photo tape`}
        className="relative overflow-hidden rounded-2xl bg-surface-elevated ring-1 ring-line-default/20 shadow-lg animate-in fade-in duration-300"
      >
        <div className="px-4 pt-4 pb-3 flex items-center justify-between">
          <span className="text-[10px] font-black tracking-[0.3em] uppercase text-ink-primary/60">
            PHOTO TAPE
          </span>
          <span className="text-[11px] text-ink-primary/50">
            {items.length} {items.length === 1 ? 'photo' : 'photos'}
          </span>
        </div>
        <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-4 px-4 -mx-1">
          {items.map((item, idx) => {
            const failed = failedIds.has(item.id);
            return (
              <button
                key={item.id}
                onClick={() => setActiveIdx(idx)}
                className="snap-start shrink-0 w-40 sm:w-48 aspect-square rounded-2xl overflow-hidden ring-1 ring-line-default/15 focus:ring-2 focus:ring-brand-primary/40 transition-transform active:scale-[0.98]"
                aria-label="Open photo"
              >
                {failed ? (
                  <div className="w-full h-full bg-brand-primary-soft/20 flex items-center justify-center text-ink-primary/40">
                    <CameraGlyph className="w-8 h-8" />
                  </div>
                ) : (
                  <img
                    src={item.thumbnailUrl || item.url}
                    alt=""
                    className="w-full h-full object-cover"
                    loading="lazy"
                    onError={() => handleImgError(item.id)}
                  />
                )}
              </button>
            );
          })}
        </div>
      </section>

      {active && items && activeIdx != null && (
        <div
          className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-sm animate-in fade-in duration-200"
          style={{
            paddingTop: 'env(safe-area-inset-top)',
            paddingBottom: 'env(safe-area-inset-bottom)',
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Photo viewer"
        >
          <div
            className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-4 py-3 text-white bg-gradient-to-b from-black/70 to-transparent"
            style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
          >
            <button
              onClick={closeLightbox}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-md"
              aria-label="Close"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <div className="text-[11px] font-bold uppercase tracking-widest opacity-70">
              {activeIdx + 1} / {items.length}
            </div>
            <div className="w-9 h-9" aria-hidden="true" />
          </div>

          <div className="absolute inset-0 flex items-center justify-center px-2">
            <img
              key={active.id}
              src={active.url}
              alt={active.caption || ''}
              className="max-h-full max-w-full object-contain select-none"
              draggable={false}
              onError={() => handleImgError(active.id)}
            />
            {activeIdx > 0 && (
              <button
                onClick={goPrev}
                className="absolute left-2 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20"
                aria-label="Previous"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            {activeIdx < items.length - 1 && (
              <button
                onClick={goNext}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 backdrop-blur-md text-white hover:bg-white/20"
                aria-label="Next"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
          </div>

          {active.caption && (
            <div
              className="absolute bottom-0 inset-x-0 z-10 text-white bg-gradient-to-t from-black/80 via-black/50 to-transparent px-4 pt-8"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
            >
              <p className="text-sm leading-snug">{active.caption}</p>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default PhotoTape;
